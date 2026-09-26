/**
 * custom-topics.ts — server-side engine for Premium custom subtopic feeds.
 *
 * A custom subtopic ("AI", "Chess", "Mars missions", anything the user
 * dreams up) is a keyword set queried against the GDELT DOC API — the same
 * free API that powers "My Country" — then AI-FILTERED for relevance and
 * clustered into NeutralWire topic cards, and cached in Firebase at
 * `customFeeds/<topicId>` (same CategoryCachePayload shape the main feed
 * uses, so /api/news serves it with zero new client code).
 *
 * ── THE PIPELINE (per topic, per refresh) ──
 *   1. Build GDELT query: ("kw1" OR "kw2" OR …) sourcelang:english
 *   2. Fetch up to 250 articles from the last 24h.
 *   3. Cheapy heuristics first: title keyword scoring, non-news skip,
 *      domain caps, URL dedup (mirrors gdelt-aggregator.ts).
 *   4. AI RELEVANCE FILTER (the user spec: "a request is sent to ai api
 *      with news articles and the ai properly filters it") — one batched
 *      callAI() returning kept-indices. Runs on the cron path where load
 *      is low; skipped on cache MISS first-serve (freshness beats perfect
 *      relevance there) and when the heuristic score is already decisive.
 *   5. Cluster near-identical titles (reuse of the stem-similarity idea
 *      from push/story-dedup, simplified).
 *   6. Write `customFeeds/<id>` = { updatedAt, sourceCount, articleCount,
 *      topics: TopicArticle[] }.
 *
 * ── FLOW CONTROL (CPU + Firebase budget) ──
 *   - Refresh happens ONLY inside the refresh-all cron's after() tail,
 *     rotating a few topics per tick (hour-bucketed) — never on user
 *     requests (the /api/news custom: path is pure cache read + a
 *     fire-and-forget one-time first fill).
 *   - GDELT queries are free; the AI filter costs one callAI per topic
 *     per refresh (only when heuristic scores are ambiguous).
 */

import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import { callAI } from '@/lib/ai-providers'
import type { TopicArticle, FeedArticle } from '@/lib/news-aggregator'
import { CATALOG_BY_ID } from '@/lib/subtopic-catalog'
import { isNearDuplicateTitle } from '@/lib/push/story-dedup'

const GDELT_API_URL = 'https://api.gdeltproject.org/api/v2/doc/doc'

export interface CustomTopicDef {
  id: string
  label: string
  keywords: string[]
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
    return { id: staticTopic.id, label: staticTopic.label, keywords: staticTopic.keywords }
  }
  const runtime = await firebaseRead<{ id: string; label: string; keywords: string[] }>(
    `customSubtopics/${topicId}`,
  )
  if (runtime?.label && Array.isArray(runtime.keywords)) {
    return { id: runtime.id || topicId, label: runtime.label, keywords: runtime.keywords }
  }
  return null
}

export function readCustomFeed(topicId: string): Promise<CustomFeedPayload | null> {
  return firebaseRead<CustomFeedPayload>(`customFeeds/${topicId}`)
}

// ── GDELT fetch ─────────────────────────────────────────────────────────

interface GdeltArticle {
  url: string
  url_mobile?: string
  title: string
  seendate: string
  socialimage?: string
  domain: string
  language?: string
  sourcecountry?: string
}

const NON_NEWS = /(newsletter|subscribe|sign up|login|horoscope|daily crossword|sudoku|weather forecast|stock quotes|classifieds)/i

function fetchGdelt(keywords: string[], maxRecords = 200): Promise<GdeltArticle[]> {
  const kw = keywords.slice(0, 8).map((k) => `"${k.replace(/"/g, '')}"`)
  const query = `(${kw.join(' OR ')}) sourcelang:english`
  const url = `${GDELT_API_URL}?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=${maxRecords}&format=json&sort=DateDesc&timewindow=1d`
  return fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; NeutralWireBot/1.0; +https://neutralwire.org)',
      Referer: 'https://neutralwire.org',
      Accept: 'application/json',
    },
    cache: 'no-store',
  })
    .then(async (res) => {
      if (!res.ok) return []
      const ct = res.headers.get('content-type') || ''
      if (!ct.includes('json')) return []
      const data = (await res.json()) as { articles?: GdeltArticle[] }
      return data.articles || []
    })
    .catch(() => [])
}

// ── Conversion + scoring (mirrors gdelt-aggregator patterns) ────────────

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

function leaningFor(domain: string): 'left' | 'center' | 'right' {
  const bare = domain.replace(/^www\./, '')
  for (const [d, l] of Object.entries(LEANING_BY_DOMAIN)) {
    if (bare === d || bare.endsWith(`.${d}`)) return l
  }
  return 'center'
}

function titleScore(title: string, keywords: string[]): number {
  const lower = title.toLowerCase()
  let score = 0
  for (const kw of keywords) {
    const k = kw.toLowerCase().trim()
    if (!k) continue
    if (lower.includes(k)) score += k.includes(' ') ? 4 : 3
    else {
      // Partial-word match for multiword keywords ("formula 1" → "f1")
      const first = k.split(' ')[0]
      if (first.length >= 4 && lower.includes(first)) score += 1
    }
  }
  return score
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
  return {
    topicId,
    title: cluster.title,
    summary: arts[0]?.description?.slice(0, 240) || '',
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

/**
 * Fetch + filter + cluster + cache one custom topic.
 * `opts.aiFilter` controls whether the AI pass runs (cron low-load = yes,
 * first-serve fill = no).
 */
export async function refreshCustomTopic(
  topicId: string,
  opts: { aiFilter?: boolean } = {},
): Promise<CustomFeedPayload | null> {
  const def = await getCustomTopicDef(topicId)
  if (!def) return null

  const raw = await fetchGdelt(def.keywords)
  if (raw.length === 0) return null

  // ── Pass 1: cheap heuristics ──
  const seenLinks = new Set<string>()
  const domainCounts: Record<string, number> = {}
  const scored: Array<{ article: FeedArticle; score: number }> = []

  for (const a of raw) {
    if (!a.url || !a.title) continue
    const title = a.title
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ').trim()
    if (title.length < 12 || NON_NEWS.test(title)) continue

    const domain = (a.domain || new URL(a.url).hostname).replace(/^www\./, '')
    const linkKey = a.url.split('?')[0].toLowerCase().replace(/\/$/, '')
    if (seenLinks.has(linkKey)) continue
    seenLinks.add(linkKey)
    domainCounts[domain] = (domainCounts[domain] || 0) + 1
    if (domainCounts[domain] > 6) continue // cap one outlet per topic

    const score = titleScore(title, def.keywords)
    if (score <= 0) continue

    const seendate = a.seendate || ''
    const iso = seendate
      ? Date.parse(
          `${seendate.slice(0, 4)}-${seendate.slice(4, 6)}-${seendate.slice(6, 8)}T${seendate.slice(9, 11)}:${seendate.slice(11, 13)}:${seendate.slice(13, 15)}Z`,
        ) || Date.now()
      : Date.now()

    scored.push({
      article: {
        id: linkKey,
        title,
        link: a.url,
        description: title,
        pubDate: null,
        iso,
        imageUrl: a.socialimage || null,
        sourceId: domain,
        sourceName: domain,
        sourceHomepage: `https://${domain}`,
        leaning: leaningFor(domain),
        country: a.sourcecountry || '',
        category: `custom:${topicId}`,
      },
      score,
    })
  }

  if (scored.length === 0) return null

  scored.sort((a, b) => b.score - a.score || b.article.iso - a.article.iso)
  const top = scored.slice(0, 60)

  // ── Pass 2: AI relevance filter (when allowed) ──
  let kept = top
  if (opts.aiFilter !== false && top.length > 4) {
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

  const payload: CustomFeedPayload = {
    updatedAt: Date.now(),
    sourceCount: Object.keys(domainCounts).length,
    articleCount: kept.length,
    topics,
  }
  await firebaseWrite(`customFeeds/${topicId}`, payload)
  return payload
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
