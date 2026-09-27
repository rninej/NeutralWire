/**
 * custom-topics.ts — server-side engine for Premium custom subtopic feeds.
 *
 * A custom subtopic ("AI", "Chess", "Mars missions", anything the user
 * dreams up) is queried against a LADDER of free, key-less sources and
 * cached in Firebase at `customFeeds/<topicId>` (same
 * CategoryCachePayload shape the main feed uses, so /api/news serves it
 * with zero new client code).
 *
 * ── THE SOURCE LADDER (why: GDELT alone stranded every subtopic) ──
 *   Production post-mortem: the GDELT DOC API rate-limits shared serverless
 *   egress IPs for hours at a time (a 429 takes 10-12s just to ARRIVE), so
 *   a GDELT-only fill landed nothing and users sat on "Gathering" forever.
 *   The engine now queries three independent sources, each of which can
 *   carry a topic alone:
 *
 *   1. GOOGLE NEWS RSS SEARCH (primary, ~0.7s, every topic imaginable):
 *      news.google.com/rss/search?q=<"kw1" OR "kw2"> — up to 100 fresh
 *      items, each with the outlet domain (<source url=…>) and pubDate.
 *      Links are Google redirect URLs (they open the publisher article in
 *      the browser; server-side decoding requires a fragile signed RPC, so
 *      the redirect is kept as the canonical link).
 *   2. THE SITE'S OWN RSS POOL (enricher): the same feeds that power the
 *      main categories, keyword-filtered — real publisher URLs, RSS
 *      thumbnails (IMAGES), known leanings, and a shared in-process cache
 *      with the main feed refreshes, so warm instances pay ~0 extra.
 *   3. GDELT DOC API (supplement): international reach + socialimage when
 *      its rate limiter lets us through; skipped honestly when it 429s.
 *
 *   The AI keyword fallback (widen + re-query) runs only when ALL sources
 *   genuinely match nothing.
 *
 * ── THE PIPELINE (per topic, per refresh) ──
 *   1. Build keyword queries for each source.
 *   2. Cheapy heuristics first: token-level title keyword scoring (whole
 *      words — "ai" never matches "said"), non-news skip, domain caps,
 *      URL dedup.
 *   3. AI RELEVANCE FILTER (one batched callAI returning kept-indices) —
 *      background refreshes only (cron / subscribe warm fill / the
 *      post-response polish pass), never the sync first-serve fill.
 *   4. Cluster near-identical titles (reuses push/story-dedup).
 *   5. IMAGES, in order: any cluster article's RSS/socialimage →
 *      near-duplicate pool story's thumbnail → og:image from REAL
 *      publisher URLs only (Google redirect pages serve a generic logo).
 *   6. Write `customFeeds/<id>` = { updatedAt, sourceCount, articleCount,
 *      topics: TopicArticle[] }.
 *
 * ── FLOW CONTROL (CPU + Firebase budget) ──
 *   - `mode:'sync'` (a visitor just tapped a brand-new chip): Google News
 *     only — it alone lands a full feed in ~1-2s. If it fails/thins out,
 *     the pool + GDELT run synchronously behind the route's deadline race.
 *   - `mode:'background'` (subscribe warm fill, cron rotation, and the
 *     after() polish pass the news route schedules once a sync fill
 *     lands): the full ladder + AI filter + image pass.
 *   - Single-flight per topic + 90s failure cooldown (fillCustomTopic)
 *     keeps retry storms off every source.
 */

import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import { callAI } from '@/lib/ai-providers'
import {
  poolArticlesForKeywords,
  fetchOgImage,
  type TopicArticle,
  type FeedArticle,
} from '@/lib/news-aggregator'
import { NEWS_SOURCES } from '@/lib/news-sources'
import { CATALOG_BY_ID } from '@/lib/subtopic-catalog'
import { isNearDuplicateTitle } from '@/lib/push/story-dedup'

// ── Single-flight + failure cooldown ────────────────────────────────────
// PRODUCTION POST-MORTEM (the "stuck on Gathering stories" bug): every
// pending /api/news poll started a FRESH GDELT fill (the client retries at
// 8/16/32/64s, every visitor's browser does the same, no-store means the
// CDN gives no relief) — a thundering herd on GDELT from shared serverless
// egress IPs, which is exactly what keeps GDELT answering 429. Two
// structural guards fix the herd for EVERY source:
//   • single-flight — concurrent fills for the SAME topic share one promise
//   • cooldown — a fill that just ended with nothing parks the topic for
//     FILL_COOLDOWN_MS (fast "failed" answers, sources get room to breathe)
const FILL_COOLDOWN_MS = 90 * 1000
const inflightFills = new Map<string, Promise<CustomFeedPayload | null>>()
const failedFills = new Map<string, number>()

/** How long until a recently-failed topic may be filled again (0 = free). */
export function customTopicCooldownRemaining(topicId: string): number {
  const failedAt = failedFills.get(topicId) || 0
  const left = FILL_COOLDOWN_MS - (Date.now() - failedAt)
  return left > 0 ? left : 0
}

/** Guarded fill: single-flight per topic + failure cooldown. ALL fill
 * call sites (news route, subscribe warm-fill, cron) go through this. */
export function fillCustomTopic(
  topicId: string,
  opts: { aiFilter?: boolean; mode?: 'sync' | 'background'; budgetMs?: number } = {},
): Promise<CustomFeedPayload | null> {
  const existing = inflightFills.get(topicId)
  if (existing) return existing
  if (customTopicCooldownRemaining(topicId) > 0) return Promise.resolve(null)
  const p = refreshCustomTopic(topicId, opts)
    .then((res) => {
      if (res) failedFills.delete(topicId)
      else failedFills.set(topicId, Date.now())
      return res
    })
    .finally(() => {
      inflightFills.delete(topicId)
    })
  inflightFills.set(topicId, p)
  return p
}

export interface CustomTopicDef {
  id: string
  label: string
  keywords: string[]
  group?: string
}

export interface CustomFeedPayload {
  updatedAt: number
  sourceCount: number
  articleCount: number
  topics: TopicArticle[]
}

/** Read the runtime definition of a custom topic (static catalog first,
 * then the AI-created runtime catalog in Firebase). */
export async function getCustomTopicDef(topicId: string): Promise<CustomTopicDef | null> {
  const staticTopic = CATALOG_BY_ID[topicId]
  if (staticTopic) {
    return {
      id: staticTopic.id,
      label: staticTopic.label,
      keywords: staticTopic.keywords,
      group: staticTopic.group,
    }
  }
  const runtime = await firebaseRead<{
    id: string
    label: string
    keywords: string[]
    group?: string
  }>(`customSubtopics/${topicId}`)
  if (runtime?.label && Array.isArray(runtime.keywords)) {
    return { id: runtime.id || topicId, label: runtime.label, keywords: runtime.keywords, group: runtime.group }
  }
  return null
}

export function readCustomFeed(topicId: string): Promise<CustomFeedPayload | null> {
  return firebaseRead<CustomFeedPayload>(`customFeeds/${topicId}`)
}

// ── Source 1: Google News RSS search ────────────────────────────────────

const GOOGLE_NEWS_RSS = 'https://news.google.com/rss/search'

/** In-process memo for Google News queries (5 min): the sync fill, the
 * after() polish pass and re-polls within the cooldown share one fetch. */
const GNEWS_CACHE = new Map<string, { ts: number; items: RawArticle[] }>()
const GNEWS_TTL_MS = 5 * 60 * 1000

/** Unified raw article shape across all three sources. */
interface RawArticle {
  url: string
  title: string
  iso: number
  socialimage: string | null
  domain: string
  sourcecountry?: string
}

type GoogleResult =
  | { ok: true; items: RawArticle[] }
  | { ok: false; reason: 'network' | 'rejected' }

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/** Fetch + parse a Google News RSS search for the keyword set. Returns
 * ok:false ONLY on transport failure (so a genuine zero-match result is
 * never mistaken for a source outage — the lesson from the GDELT ladder). */
async function fetchGoogleNews(keywords: string[], timeoutMs: number): Promise<GoogleResult> {
  const kw = keywords
    .slice(0, 8)
    .map((k) => `"${k.replace(/"/g, '').trim()}"`)
    .filter((k) => k.length > 3)
  if (kw.length === 0) return { ok: true, items: [] }
  const query = kw.join(' OR ')
  const url = `${GOOGLE_NEWS_RSS}?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`

  const cached = GNEWS_CACHE.get(query)
  if (cached && Date.now() - cached.ts < GNEWS_TTL_MS) {
    return { ok: true, items: cached.items }
  }

  const attempt = (): Promise<GoogleResult> =>
    fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NeutralWireBot/1.0; +https://neutralwire.org)',
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
      cache: 'no-store',
    })
      .then(async (res): Promise<GoogleResult> => {
        if (!res.ok) return { ok: false, reason: 'rejected' }
        const xml = await res.text()
        if (!xml.includes('<item')) return { ok: true, items: [] }
        const items: RawArticle[] = []
        const seenGuid = new Set<string>()
        const itemRe = /<item>([\s\S]*?)<\/item>/g
        let m: RegExpExecArray | null
        while ((m = itemRe.exec(xml)) !== null && items.length < 100) {
          const block = m[1]
          const rawTitle = decodeXmlEntities(
            (block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').trim(),
          )
          const link = (block.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '').trim()
          const guid = (
            block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1] || link
          ).trim()
          const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || ''
          const sourceTag = block.match(/<source[^>]*url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/)
          const sourceUrl = sourceTag?.[1] || ''
          const sourceName = decodeXmlEntities((sourceTag?.[2] || '').trim())
          if (!rawTitle || !link || seenGuid.has(guid)) continue
          seenGuid.add(guid)

          // The outlet rides the title as a " - CBS News" suffix; strip it
          // (we keep the outlet from <source> instead — the suffix-less
          // title clusters better across outlets).
          let title = rawTitle
          if (sourceName && title.toLowerCase().endsWith(` - ${sourceName.toLowerCase()}`)) {
            title = title.slice(0, title.length - sourceName.length - 3).trim()
          }
          if (title.length < 12) continue

          let domain = ''
          try {
            domain = sourceUrl ? new URL(sourceUrl).hostname.replace(/^www\./, '') : ''
          } catch {
            domain = ''
          }
          if (!domain) continue // no outlet attribution — unusable metadata

          const iso = pubDate ? Date.parse(pubDate) || Date.now() : Date.now()
          items.push({
            url: link,
            title,
            iso,
            socialimage: null,
            domain,
            sourcecountry: '',
          })
        }
        GNEWS_CACHE.set(query, { ts: Date.now(), items })
        return { ok: true, items }
      })
      .catch((): GoogleResult => ({ ok: false, reason: 'network' }))

  // Google News RSS is a feed-reader endpoint — extremely tolerant. One
  // polite retry on a transport blip is plenty.
  const first = await attempt()
  if (first.ok || first.reason !== 'network') return first
  await new Promise((r) => setTimeout(r, 1500))
  return attempt()
}

// ── Source 3: GDELT DOC API (supplement) ────────────────────────────────

const GDELT_API_URL = 'https://api.gdeltproject.org/api/v2/doc/doc'

/** Per-attempt fetch timing. GDELT's rate-limiter answers 429 slowly —
 * observed 10-12s just to DELIVER the rejection — so short timeouts abort
 * before the 429 ever arrives and read as blind network failures. Patient
 * attempts let the ladder see (and out-wait) the throttle; sync fills ask
 * for fewer records (75 — GDELT's floor, fastest answer). */
interface GdeltTiming {
  perAttemptMs: number
  backoffMs: number
  maxRecords: number
  /** The third, double-backoff retry is for patient background fills. */
  patientThirdRetry: boolean
}
const GDELT_TIMING_SYNC: GdeltTiming = {
  perAttemptMs: 12000,
  backoffMs: 5000,
  maxRecords: 75,
  patientThirdRetry: false,
}
const GDELT_TIMING_BACKGROUND: GdeltTiming = {
  perAttemptMs: 12000,
  backoffMs: 5500,
  maxRecords: 200,
  patientThirdRetry: true,
}

/** Discriminated GDELT result — "GDELT refused/failed us" (rate-limit,
 * network, non-JSON body) must stay apart from "the query genuinely
 * matched nothing"; conflating the two is what made rate-limited topics
 * burn AI widen calls and re-hit a throttling API. */
type GdeltResult =
  | { ok: true; articles: RawArticle[] }
  | { ok: false; reason: 'rate' | 'network' | 'rejected' }

function fetchGdelt(keywords: string[], timing: GdeltTiming): Promise<GdeltResult> {
  const kw = keywords.slice(0, 8).map((k) => `"${k.replace(/"/g, '')}"`)
  const query = `(${kw.join(' OR ')}) sourcelang:english`
  const url = `${GDELT_API_URL}?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=${timing.maxRecords}&format=json&sort=DateDesc&timewindow=1d`

  const attempt = (timeoutMs: number): Promise<GdeltResult> =>
    fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NeutralWireBot/1.0; +https://neutralwire.org)',
        Referer: 'https://neutralwire.org',
        Accept: 'application/json',
      },
      cache: 'no-store',
    })
      .then(async (res): Promise<GdeltResult> => {
        if (res.status === 429 || res.status === 503) return { ok: false, reason: 'rate' }
        if (!res.ok) return { ok: false, reason: 'rejected' }
        const ct = res.headers.get('content-type') || ''
        if (!ct.includes('json')) return { ok: false, reason: 'rejected' }
        const data = (await res.json()) as {
          articles?: Array<{
            url: string
            title: string
            seendate: string
            socialimage?: string
            domain: string
            sourcecountry?: string
          }>
        }
        const articles: RawArticle[] = (data.articles || []).map((a) => ({
          url: a.url,
          title: a.title,
          iso: a.seendate
            ? Date.parse(
                `${a.seendate.slice(0, 4)}-${a.seendate.slice(4, 6)}-${a.seendate.slice(6, 8)}T${a.seendate.slice(9, 11)}:${a.seendate.slice(11, 13)}:${a.seendate.slice(13, 15)}Z`,
              ) || Date.now()
            : Date.now(),
          socialimage: a.socialimage || null,
          domain: (a.domain || '').replace(/^www\./, ''),
          sourcecountry: a.sourcecountry || '',
        }))
        return { ok: true, articles }
      })
      .catch((): GdeltResult => ({ ok: false, reason: 'network' }))

  return (async () => {
    const first = await attempt(timing.perAttemptMs)
    if (first.ok) return first
    if (first.reason !== 'rate') return first
    await new Promise((r) => setTimeout(r, timing.backoffMs))
    const second = await attempt(timing.perAttemptMs)
    if (second.ok) return second
    if (timing.patientThirdRetry && second.reason === 'rate') {
      await new Promise((r) => setTimeout(r, timing.backoffMs * 2))
      const third = await attempt(timing.perAttemptMs)
      if (third.ok) return third
    }
    return second
  })()
}

// ── Source 2: the site's RSS pool (category map) ───────────────────────

/** Catalog group → the main-feed categories whose pool feeds get scanned.
 * 'top' (all ~320 feeds) is deliberately avoided — enricher subsets stay
 * ≤ ~60 feeds, share the in-process cache with main refreshes, and run in
 * background modes where the 10s pool budget is acceptable. */
const GROUP_TO_POOL: Record<string, string[]> = {
  Technology: ['technology', 'science'],
  Science: ['science'],
  'Business & Finance': ['business'],
  'Politics & World': ['world', 'politics'],
  Health: ['health', 'science'],
  Sports: ['sports'],
  'Culture & Media': ['world'],
  'Lifestyle & Interests': ['world', 'health'],
  Environment: ['science', 'world'],
  'Education & Society': ['world'],
  Regions: ['world'],
}

function poolCategoriesForGroup(group?: string): string[] {
  if (group && GROUP_TO_POOL[group]) return GROUP_TO_POOL[group]
  // Runtime (AI-created) topics without a group — a broad, light default.
  return ['world', 'technology']
}

// ── Source 4: Bing News RSS (image donor) ────────────────────────────

const BING_NEWS_RSS = 'https://www.bing.com/news/search'
const BING_CACHE = new Map<string, { ts: number; items: Array<{ title: string; imageUrl: string }> }>()
const BING_TTL_MS = 5 * 60 * 1000

/** Bing News RSS carries a thumbnail per item (News:Image). It is an
 * IMAGE DONOR, not a content source — its search results are thin and
 * listicle-heavy, but the top stories match Google News clusters, so
 * title matching transfers real photos onto otherwise image-less topics.
 * Simple queries only — Bing ignores complex OR syntax (returns zero
 * items) — so we fire the topic label + first keywords as separate
 * parallel queries and pool the items. */
async function fetchBingImages(
  label: string,
  keywords: string[] = [],
  timeoutMs = 4000,
): Promise<Array<{ title: string; imageUrl: string }>> {
  const queries = Array.from(
    new Set(
      [label.trim(), ...keywords.filter((k) => k.trim().length >= 3).slice(0, 2)]
        .map((q) => q.trim())
        .filter(Boolean),
    ),
  ).slice(0, 3)
  if (queries.length === 0) return []

  const fetchOne = async (q: string): Promise<Array<{ title: string; imageUrl: string }>> => {
    const cached = BING_CACHE.get(q)
    if (cached && Date.now() - cached.ts < BING_TTL_MS) return cached.items
    try {
      const res = await fetch(
        `${BING_NEWS_RSS}?q=${encodeURIComponent(q)}&format=RSS&setmkt=en-US&setlang=en-US`,
        {
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            Accept: 'application/rss+xml, application/xml, text/xml, */*',
          },
          cache: 'no-store',
        },
      )
      if (!res.ok) return []
      const xml = await res.text()
      const items: Array<{ title: string; imageUrl: string }> = []
      const itemRe = /<item>([\s\S]*?)<\/item>/g
      let m: RegExpExecArray | null
      while ((m = itemRe.exec(xml)) !== null && items.length < 15) {
        const block = m[1]
        const title = decodeXmlEntities(
          (block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').trim(),
        )
        const img = decodeXmlEntities(
          (block.match(/<News:Image>([\s\S]*?)<\/News:Image>/)?.[1] || '').trim(),
        )
        if (!title || !img) continue
        // Bing ships http:// thumbnails — upgrade to https (the image proxy
        // and the browser both prefer it). Skip anything that isn't a bing
        // CDN thumbnail to avoid arbitrary hotlinks.
        const httpsImg = img.startsWith('http://www.bing.com/')
          ? img.replace(/^http:/, 'https:')
          : img.startsWith('https://www.bing.com/')
            ? img
            : ''
        if (!httpsImg) continue
        items.push({ title, imageUrl: httpsImg })
      }
      BING_CACHE.set(q, { ts: Date.now(), items })
      return items
    } catch {
      return []
    }
  }

  const pooled = (await Promise.all(queries.map(fetchOne))).flat()
  // Different queries can surface the same story/image — dedup by image
  // URL and by normalized title so the donor pool stays clean.
  const seenImg = new Set<string>()
  const seenTitle = new Set<string>()
  const out: Array<{ title: string; imageUrl: string }> = []
  for (const it of pooled) {
    const titleKey = it.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    if (seenImg.has(it.imageUrl) || seenTitle.has(titleKey)) continue
    seenImg.add(it.imageUrl)
    seenTitle.add(titleKey)
    out.push(it)
  }
  return out
}

// ── Leanings (Google/GDELT domains → left/center/right) ─────────────────

/** Hand-curated map (kept authoritative) extended at module load with the
 * ~90 curated outlets in news-sources.ts (their homepages + ratings) —
 * Google News surfaces exactly these majors most often. */
const LEANING_BY_DOMAIN: Record<string, 'left' | 'center' | 'right'> = {
  'theguardian.com': 'left', 'cnn.com': 'left', 'msnbc.com': 'left', 'nytimes.com': 'left',
  'washingtonpost.com': 'left', 'bbc.co.uk': 'center', 'bbc.com': 'center',
  'reuters.com': 'center', 'apnews.com': 'center', 'aljazeera.com': 'center',
  'ft.com': 'center', 'bloomberg.com': 'center', 'cnbc.com': 'center',
  'foxnews.com': 'right', 'nypost.com': 'right', 'dailymail.co.uk': 'right',
  'telegraph.co.uk': 'right', 'washingtonexaminer.com': 'right', 'thehill.com': 'center',
  'newsweek.com': 'center', 'time.com': 'center', 'wsj.com': 'center',
  'economist.com': 'center', 'npr.org': 'left', 'abc.net.au': 'center',
  'smh.com.au': 'left', 'theage.com.au': 'left', 'news.com.au': 'right',
  'sky.com': 'right', 'express.co.uk': 'right', 'mirror.co.uk': 'left',
  'independent.co.uk': 'center', 'timesofindia.indiatimes.com': 'center',
  'hindustantimes.com': 'center', 'indianexpress.com': 'center',
}
for (const s of NEWS_SOURCES) {
  try {
    const host = new URL(s.homepage).hostname.replace(/^www\./, '')
    if (host && !LEANING_BY_DOMAIN[host]) LEANING_BY_DOMAIN[host] = s.leaning
  } catch {
    // unparsable homepage — skip
  }
}

function leaningFor(domain: string): 'left' | 'center' | 'right' {
  const bare = domain.replace(/^www\./, '')
  const hit = LEANING_BY_DOMAIN[bare]
  if (hit) return hit
  for (const [d, l] of Object.entries(LEANING_BY_DOMAIN)) {
    if (bare === d || bare.endsWith(`.${d}`)) return l
  }
  return 'center'
}

// ── Conversion + scoring ────────────────────────────────────────────────

const NON_NEWS = /(newsletter|subscribe|sign up|login|horoscope|daily crossword|sudoku|weather forecast|stock quotes|classifieds)/i

/** Token-level keyword scoring: multi-word keywords match as phrases
 * (+4), whole-word tokens +3, long prefixes +1. Whole-word matching is
 * load-bearing — the old substring check let "ai" match "said" and
 * "maintain", poisoning relevance for every topic with short keywords. */
function titleScore(title: string, keywords: string[]): number {
  const lower = title.toLowerCase()
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean)
  let score = 0
  for (const kw of keywords) {
    const k = kw.toLowerCase().trim()
    if (!k) continue
    if (k.includes(' ')) {
      if (lower.includes(k)) score += 4
    } else if (tokens.includes(k)) {
      score += 3
    } else if (k.length >= 5 && tokens.some((t) => t.startsWith(k))) {
      score += 1
    }
  }
  return score
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

/** AI relevance filter — one batched call, returns indices to KEEP. */
async function aiFilterArticles(
  label: string,
  articles: Array<{ title: string; domain: string; score: number }>,
): Promise<number[] | null> {
  if (articles.length === 0) return []
  const list = articles
    .map((a, i) => `${i}|${a.title} [${a.domain}]`)
    .join('\n')
    .slice(0, 6000)
  const raw = await callAI({
    systemPrompt:
      'You are a news relevance filter for a neutral news aggregator. Given a list of numbered article titles (format index|title [domain]) and a target topic, reply with ONLY a JSON array of the indices whose headline is genuinely ABOUT the topic (news, reports, analysis, events). Exclude paywalls, listicles of unrelated content, ads, horoscopes, and anything only tangentially mentioning the topic. If none qualify reply [].',
    userPrompt: `Topic: "${label}"\n\nArticles:\n${list}\n\nReply with only the JSON array of indices to keep, e.g. [0,2,5].`,
    maxTokens: 300,
  })
  if (!raw) return null
  const match = raw.match(/\[[\d\s,]*\]/)
  if (!match) return null
  try {
    const indices = JSON.parse(match[0]) as number[]
    return indices.filter((i) => Number.isInteger(i) && i >= 0 && i < articles.length)
  } catch {
    return null
  }
}

// ── AI keyword fallback ──────────────────────────────────────────────────

/** The AI FALLBACK: when a topic's query lands empty on EVERY source
 * (keywords too narrow — "Chess openings" may match nothing in a general
 * news index), ask the AI for a WIDER keyword set and re-run. Returns []
 * when the AI is unavailable (no keys) so the caller keeps its result. */
async function aiBroadenKeywords(
  label: string,
  keywords: string[],
): Promise<string[]> {
  const raw = await callAI({
    systemPrompt:
      'You widen news-search keyword sets. Given a topic and its current news-search keywords that returned ZERO results, reply with ONLY a comma-separated list of 6-8 BROADER English search keywords a general news index would actually match (umbrella terms, common spellings, related public names). No numbering, no prose.',
    userPrompt: `Topic: "${label}"\nCurrent keywords (found nothing): ${keywords.join(', ')}\n\nReply with only the comma-separated keywords.`,
    maxTokens: 90,
  })
  if (!raw) return []
  return raw
    .split(/[,\n]/)
    .map((k) => k.trim().toLowerCase().replace(/^["']|["']$/g, ''))
    .filter((k) => k.length >= 3 && k.length <= 40 && !keywords.includes(k))
    .slice(0, 8)
}

// ── Cluster + build topics ──────────────────────────────────────────────

interface ClusteredTopic {
  title: string
  articles: FeedArticle[]
}

function clusterArticles(articles: FeedArticle[]): ClusteredTopic[] {
  const clusters: ClusteredTopic[] = []
  for (const a of articles) {
    let best: ClusteredTopic | null = null
    for (const c of clusters) {
      if (isNearDuplicateTitle(c.title, a.title)) {
        best = c
        break
      }
    }
    if (best) best.articles.push(a)
    else clusters.push({ title: a.title, articles: [a] })
  }
  return clusters
}

function toTopicArticle(cluster: ClusteredTopic): TopicArticle {
  const arts = cluster.articles
  const leanLeft = arts.filter((a) => a.leaning === 'left').length
  const leanRight = arts.filter((a) => a.leaning === 'right').length
  const leanCenter = arts.length - leanLeft - leanRight
  const withImage = arts.find((a) => a.imageUrl)
  const latest = Math.max(...arts.map((a) => a.iso || 0))
  const topicId = `ct_${cluster.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '')}`
  // Summary: prefer a real RSS description (pool articles carry one);
  // fall back to the best title (Google/GDELT items have none).
  const withDescription = arts.find((a) => a.description && a.description.length > 40)
  const summary =
    (withDescription?.description || arts[0]?.title || '').slice(0, 240)
  return {
    topicId,
    title: cluster.title,
    summary,
    imageUrl: withImage?.imageUrl || null,
    coverage: arts.length,
    leanLeft,
    leanCenter,
    leanRight,
    firstSeen: latest,
    latestSeen: latest,
    articles: arts,
  }
}

// ── Image enrichment (background fills) ────────────────────────────────

/** Overlap score for IMAGE DONATION (looser than the dedup matcher):
 * shared meaningful tokens / smaller set. Bing/pool donor items are already
 * on-topic (they matched the search), so a related-story photo is
 * acceptable — the threshold only guards against unrelated grabs. */
function titleOverlapScore(a: string, b: string): number {
  const toks = (s: string) =>
    new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3))
  const A = toks(a)
  const B = toks(b)
  if (A.size < 2 || B.size < 2) return 0
  let shared = 0
  for (const t of A) if (B.has(t)) shared++
  if (shared < 2) return 0
  return shared / Math.min(A.size, B.size)
}

/** Attach images to topics that lack one, in value order:
 *   1. BING thumbnails — related titles from Bing News search (all Bing
 *      items are on-topic by construction, so overlap ≥ 0.45 is enough),
 *   2. POOL story thumbnails — a pool article the cluster missed by
 *      wording still often covers the same story (near-duplicate tight,
 *      overlap 0.55 as a second chance),
 *   3. og:image from REAL publisher URLs inside the topic (Google
 *      redirect links are skipped — their og:image is Google's generic
 *      logo, and the redirect guard can't catch it because the host
 *      matches). */
async function attachImages(
  topics: TopicArticle[],
  label: string,
  keywords: string[],
  poolArticles: FeedArticle[],
  budgetMs: number,
): Promise<void> {
  const deadline = Date.now() + budgetMs
  const imageless = topics.slice(0, 24).filter((t) => !t.imageUrl)
  if (imageless.length === 0) return

  // Donors 1 + 2 are cheap text matching — run them first so the og
  // fetches share whatever budget is left. Donor images are CONSUMED
  // (each photo lands on at most ONE topic — duplicate images across
  // cards would read as a glitch).
  const bing = await fetchBingImages(label, keywords)
  // Seed with images already attached to topics (an in-cluster pool image
  // must not be stolen onto a SECOND topic).
  const usedDonors = new Set<string>(
    topics.filter((t) => t.imageUrl).map((t) => t.imageUrl as string),
  )
  for (const t of imageless) {
    let best: { url: string; score: number } | null = null
    for (const b of bing) {
      if (usedDonors.has(b.imageUrl)) continue
      const score = Math.max(titleOverlapScore(t.title, b.title),
        isNearDuplicateTitle(t.title, b.title) ? 1 : 0)
      if (score >= 0.45 && score > (best?.score || 0)) best = { url: b.imageUrl, score }
    }
    if (best) {
      t.imageUrl = best.url
      usedDonors.add(best.url)
    }
  }
  for (const t of imageless) {
    if (t.imageUrl) continue
    let best: { url: string; score: number } | null = null
    for (const p of poolArticles) {
      if (!p.imageUrl || usedDonors.has(p.imageUrl)) continue
      const score = isNearDuplicateTitle(t.title, p.title)
        ? 1
        : titleOverlapScore(t.title, p.title)
      if (score >= 0.55 && score > (best?.score || 0)) best = { url: p.imageUrl, score }
    }
    if (best) {
      t.imageUrl = best.url
      usedDonors.add(best.url)
    }
  }

  // Donor 3: og:image from real publisher URLs (max 2 fetches per topic).
  await Promise.all(
    imageless.map(async (t) => {
      if (t.imageUrl) return
      let tries = 0
      for (const a of t.articles) {
        if (tries >= 2 || Date.now() > deadline) return
        if (!a.link) continue
        let host = ''
        try {
          host = new URL(a.link).hostname
        } catch {
          continue
        }
        if (host.endsWith('news.google.com')) continue
        tries += 1
        const og = await fetchOgImage(a.link)
        if (og) {
          t.imageUrl = og
          return
        }
      }
    }),
  )
}

// ── The refresh pipeline ────────────────────────────────────────────────

/** Minimum healthy first-source yield before the enrichers join the sync
 * path (below this, the pool + GDELT run synchronously behind the route's
 * deadline race). */
const MIN_HEALTHY = 8

export async function refreshCustomTopic(
  topicId: string,
  opts: { aiFilter?: boolean; mode?: 'sync' | 'background'; budgetMs?: number } = {},
): Promise<CustomFeedPayload | null> {
  const started = Date.now()
  const def = await getCustomTopicDef(topicId)
  if (!def) return null

  const mode = opts.mode === 'sync' ? 'sync' : 'background'
  const budgetMs = opts.budgetMs ?? (mode === 'sync' ? 9000 : 40000)
  const elapsedMs = () => Date.now() - started
  const overBudget = () => elapsedMs() > budgetMs
  /** Remaining budget (floored so a late stage still gets a moment). */
  const remaining = () => Math.max(1500, budgetMs - elapsedMs())

  const gdeltTiming = mode === 'sync' ? GDELT_TIMING_SYNC : GDELT_TIMING_BACKGROUND
  const poolCats = poolCategoriesForGroup(def.group)

  // ── Stage 1: Google News RSS — fast, reliable, carries a topic alone ──
  const google = await fetchGoogleNews(def.keywords, mode === 'sync' ? 7000 : 9000)
  let raw: RawArticle[] = google.ok ? google.items : []

  // ── Stage 2: enrichers ──
  //   sync mode: only when Google News failed or came back thin — the
  //   deadline race then covers the extra seconds.
  //   background mode: always — images (pool thumbnails), real publisher
  //   URLs, known leanings, and GDELT's international coverage.
  let pool: FeedArticle[] = []
  const needStage2 = mode === 'background' || raw.length < MIN_HEALTHY
  if (needStage2 && !overBudget()) {
    const [poolRes, gdeltRes] = await Promise.all([
      poolArticlesForKeywords(def.keywords, poolCats, {
        timeoutMs: Math.min(mode === 'sync' ? 9000 : 10000, remaining()),
        maxArticles: 40,
      }),
      // GDELT is a pure supplement now — Google News carries the topic.
      // When Google already delivered, cut the GDELT attempt early: its
      // rate-limiter takes 10-12s just to DELIVER a 429, so an 8s cut
      // loses nothing when throttled and still lands healthy (1-3s)
      // answers. The full patient ladder stays for the all-hands sync
      // fallback when Google News itself failed.
      (async (): Promise<RawArticle[]> => {
        const googleHealthy = raw.length >= MIN_HEALTHY
        const timing =
          mode === 'background' && googleHealthy
            ? { ...GDELT_TIMING_SYNC, patientThirdRetry: false }
            : gdeltTiming
        const gdeltBudget =
          mode === 'background' && googleHealthy ? 8000 : Math.min(mode === 'sync' ? 9000 : 15000, remaining())
        const r = await withBudget(fetchGdelt(def.keywords, timing), gdeltBudget)
        return r && r.ok ? r.articles : []
      })(),
    ])
    pool = poolRes
    if (gdeltRes.length > 0) raw = raw.concat(gdeltRes)
  }

  // ── AI keyword fallback: ONLY when every source genuinely matched
  //    nothing (too-narrow keywords). A source outage must NOT trigger
  //    widening — that would burn a callAI AND re-hit throttled sources
  //    (the old behaviour, and a direct driver of eternal "Gathering"). ──
  if (raw.length === 0 && pool.length === 0 && def.keywords.length > 0 && !overBudget()) {
    const googleOk = google.ok
    const broader = await aiBroadenKeywords(def.label, def.keywords)
    if (broader.length > 0) {
      const keywords = [...def.keywords.slice(0, 2), ...broader].slice(0, 8)
      const widenedGoogle = await fetchGoogleNews(keywords, 7000)
      if (widenedGoogle.ok && widenedGoogle.items.length > 0) {
        raw = widenedGoogle.items
        // A runtime (AI-created) topic's widened keywords are persisted so
        // future refreshes keep the working net. Static catalog topics are
        // shared — leave their definition alone.
        if (!CATALOG_BY_ID[topicId]) {
          firebaseWrite(`customSubtopics/${topicId}/keywords`, keywords).catch(() => {})
        }
      } else if (!googleOk) {
        // Google itself was down for the original query — worth one GDELT
        // try with the widened net before giving up.
        const second = await withBudget(fetchGdelt(keywords, GDELT_TIMING_SYNC), 9000)
        if (second && second.ok) raw = second.articles
      }
    }
  }
  if (raw.length === 0 && pool.length === 0) return null

  // ── Pass 1: heuristics over both article shapes ──
  const seenLinks = new Set<string>()
  const domainCounts: Record<string, number> = {}
  const scored: Array<{ article: FeedArticle; score: number }> = []

  const pushScored = (article: FeedArticle, domain: string, score: number) => {
    const linkKey = article.link.split('?')[0].toLowerCase().replace(/\/$/, '')
    if (!linkKey || seenLinks.has(linkKey)) return
    seenLinks.add(linkKey)
    domainCounts[domain] = (domainCounts[domain] || 0) + 1
    if (domainCounts[domain] > 6) return // cap one outlet per topic
    scored.push({ article, score })
  }

  for (const a of raw) {
    if (!a.url || !a.title) continue
    const title = cleanTitle(a.title)
    if (title.length < 12 || NON_NEWS.test(title)) continue
    const domain = a.domain || (() => {
      try {
        return new URL(a.url).hostname.replace(/^www\./, '')
      } catch {
        return ''
      }
    })()
    if (!domain) continue
    const score = titleScore(title, def.keywords)
    if (score <= 0) continue
    pushScored(
      {
        id: `${topicId}:${a.url.slice(0, 80)}`,
        title,
        link: a.url,
        description: title,
        pubDate: null,
        iso: a.iso || Date.now(),
        imageUrl: a.socialimage || null,
        sourceId: domain,
        sourceName: domain,
        sourceHomepage: `https://${domain}`,
        leaning: leaningFor(domain),
        country: a.sourcecountry || '',
        category: `custom:${topicId}`,
      },
      domain,
      score,
    )
  }

  for (const p of pool) {
    // Pool articles arrive as finished FeedArticles with REAL urls,
    // thumbnails, leanings and descriptions — remap only the category.
    let domain = ''
    try {
      domain = new URL(p.sourceHomepage).hostname.replace(/^www\./, '')
    } catch {
      domain = p.sourceId
    }
    const score = titleScore(p.title, def.keywords)
    if (score <= 0 || NON_NEWS.test(p.title)) continue
    pushScored({ ...p, category: `custom:${topicId}` }, domain, score)
  }

  if (scored.length === 0) return null

  scored.sort((a, b) => b.score - a.score || b.article.iso - a.article.iso)
  const top = scored.slice(0, 60)

  // ── Pass 2: AI relevance filter (background modes only, first half of
  //    the budget — images and the cache write outrank it near the cap) ──
  let kept = top
  if (opts.aiFilter !== false && mode === 'background' && top.length > 4 && elapsedMs() < budgetMs * 0.55) {
    // Only ask the AI when there ARE ambiguous candidates (score < 6).
    const ambiguous = top.filter((t) => t.score < 6)
    if (ambiguous.length > 2) {
      const keepIdx = await aiFilterArticles(
        def.label,
        top.map((t) => ({ title: t.article.title, domain: t.article.sourceName, score: t.score })),
      )
      if (keepIdx && keepIdx.length >= 3) {
        kept = keepIdx.map((i) => top[i]).filter(Boolean)
      }
    }
  }
  if (kept.length === 0) return null

  // ── Pass 3: cluster + build topic cards ──
  const clusters = clusterArticles(kept.map((k) => k.article))
  clusters.sort((a, b) => b.articles.length - a.articles.length)
  const topics = clusters.slice(0, 24).map(toTopicArticle)

  // ── Pass 4: images (background modes — the sync path serves instantly
  //    and the after() polish pass adds photos to the cached feed) ──
  if (mode === 'background' && !overBudget()) {
    await attachImages(topics, def.label, def.keywords, pool, Math.min(9000, remaining()))
  }

  const payload: CustomFeedPayload = {
    updatedAt: Date.now(),
    sourceCount: Math.max(1, Object.keys(domainCounts).length),
    articleCount: kept.length,
    topics,
  }
  await firebaseWrite(`customFeeds/${topicId}`, payload)
  return payload
}

/** Race a promise against a budget; null when the budget wins (the loser
 * is simply abandoned — its fetch result is not worth blocking the fill). */
async function withBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Which custom topics should refresh THIS tick? The universe of topics is
 * (static catalog ∩ subscribed-by-anyone) ∪ (runtime AI-created topics).
 * Subscription tracking: `customSubscriptions/<topicId> = { count, updatedAt }`
 * — incremented when a user adds the topic, decremented when removed, so
 * we never spend CPU on topics nobody follows.
 *
 * Rotation: hash(topicId) % 24 === current UTC hour → refreshes every ~24h
 * per topic, spread across the day; at most MAX_PER_TICK per tick.
 */
export async function customTopicsDueForRefresh(maxPerTick = 3): Promise<string[]> {
  const subs = await firebaseRead<Record<string, { count?: number }>>('customSubscriptions')
  if (!subs) return []
  const hour = new Date().getUTCHours()
  const due = Object.entries(subs)
    .filter(([id, v]) => (v?.count || 0) > 0 && hashCode(id) % 24 === hour)
    .map(([id]) => id)
  return due.slice(0, maxPerTick)
}

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** Bump the subscriber counter for a topic (user added it). */
export async function subscribeCustomTopic(topicId: string): Promise<void> {
  const subs = (await firebaseRead<Record<string, { count?: number }>>('customSubscriptions')) || {}
  const current = subs[topicId]?.count || 0
  await firebaseWrite(`customSubscriptions/${topicId}`, {
    count: current + 1,
    updatedAt: Date.now(),
  })
}

/** Decrement the subscriber counter (user removed it). */
export async function unsubscribeCustomTopic(topicId: string): Promise<void> {
  const subs = (await firebaseRead<Record<string, { count?: number }>>('customSubscriptions')) || {}
  const current = Math.max(0, (subs[topicId]?.count || 0) - 1)
  await firebaseWrite(`customSubscriptions/${topicId}`, {
    count: current,
    updatedAt: Date.now(),
  })
}
