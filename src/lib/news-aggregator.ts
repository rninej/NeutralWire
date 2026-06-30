/**
 * News aggregation core: fetch RSS feeds, parse, dedup, cluster into topics.
 *
 * Extracted from /api/news/route.ts so both /api/news (cache-first read)
 * and /api/refresh (force RSS fetch + write cache) can share the same logic.
 */

import {
  NEWS_SOURCES,
  feedsForCategory,
  type Category,
  type Leaning,
  type NewsSource,
} from '@/lib/news-sources'

// ---------- Types ----------
export interface FeedArticle {
  id: string
  title: string
  link: string
  description: string
  pubDate: string | null
  iso: number
  imageUrl: string | null
  sourceId: string
  sourceName: string
  sourceHomepage: string
  leaning: Leaning
  country: string
  category: string
}

export interface TopicArticle {
  topicId: string
  title: string
  summary: string
  imageUrl: string | null
  coverage: number
  leanLeft: number
  leanCenter: number
  leanRight: number
  firstSeen: number
  latestSeen: number
  articles: FeedArticle[]
  /** How many articles in this topic are from the visitor's local sources. */
  localCoverage?: number
}

export interface CategoryCachePayload {
  updatedAt: number
  sourceCount: number
  articleCount: number
  topics: TopicArticle[]
}

// ---------- Per-feed cache (in-process) ----------
// Caches the raw RSS fetch per URL for a few minutes. Shared across
// categories because many feeds (e.g. BBC top) are reused.
interface FeedCacheEntry {
  ts: number
  articles: FeedArticle[]
}
const FEED_CACHE = new Map<string, FeedCacheEntry>()
const FEED_TTL_MS = 5 * 60 * 1000

// ---------- Stopwords ----------
const STOPWORDS = new Set([
  'a','an','the','and','or','but','if','then','else','for','of','to','in','on','at','by','with','from','as','is','are','was','were','be','been','being','this','that','these','those','it','its','they','them','their','there','here','we','us','our','you','your','he','she','his','her','my','me','not','no','yes','do','does','did','done','have','has','had','will','would','can','could','should','may','might','must','shall','about','after','before','between','during','through','over','under','up','down','out','off','again','more','most','some','such','only','own','same','so','than','too','very','just','also','new','one','two','three','said','says','say','saying','news','report','reports','reported','amid','amidst','while','because','since','until','without','within','against','above','below','into','onto','upon','who','what','when','where','why','how','which','whom','whose','whether','either','neither','both','each','other','another','via','am','pm','gmt','utc',
])

function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function titleKeywords(t: string): Set<string> {
  const words = normalizeTitle(t).split(' ').filter(Boolean)
  const out = new Set<string>()
  for (const w of words) {
    if (w.length < 3) continue
    if (STOPWORDS.has(w)) continue
    if (/^\d+$/.test(w)) continue
    out.add(w)
  }
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

// ---------- RSS Parsing ----------
function parseFeed(xml: string, source: NewsSource, feedCategory: string): FeedArticle[] {
  const articles: FeedArticle[] = []
  const itemRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/g
  let m: RegExpExecArray | null

  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1]

    const title = extractTag(block, 'title') || ''
    const link =
      extractTag(block, 'link') ||
      extractAttr(block, 'link', 'href') ||
      ''
    const description =
      extractTag(block, 'description') ||
      extractTag(block, 'summary') ||
      extractTag(block, 'content') ||
      ''
    const pubDate =
      extractTag(block, 'pubDate') ||
      extractTag(block, 'published') ||
      extractTag(block, 'updated') ||
      extractTag(block, 'dc:date') ||
      null

    const imageUrl: string | null =
      extractAttr(block, 'media:content', 'url') ||
      extractAttr(block, 'media:thumbnail', 'url') ||
      extractAttr(block, 'enclosure', 'url') ||
      extractTag(block, 'image') ||
      extractImageFromHtml(description) ||
      null

    if (!title || !link) continue
    const cleanTitle = stripCdata(title).trim()
    const cleanLink = stripCdata(link).trim()
    if (!cleanTitle || !cleanLink) continue
    if (cleanTitle.length < 8) continue

    const iso = parseDateToMs(pubDate)

    articles.push({
      id: hashId(cleanLink + '|' + source.id),
      title: decodeEntities(cleanTitle),
      link: cleanLink,
      description: cleanDescription(description),
      pubDate,
      iso,
      imageUrl,
      sourceId: source.id,
      sourceName: source.name,
      sourceHomepage: source.homepage,
      leaning: source.leaning,
      country: source.country,
      category: feedCategory,
    })
  }

  return articles
}

function extractTag(block: string, tag: string): string | null {
  const re = new RegExp(
    `<${escapeReg(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeReg(tag)}>`,
    'i',
  )
  const m = block.match(re)
  return m ? m[1] : null
}

function extractAttr(block: string, tag: string, attr: string): string | null {
  const re = new RegExp(
    `<${escapeReg(tag)}\\b[^>]*\\b${escapeReg(attr)}\\s*=\\s*["']([^"']+)["'][^>]*`,
    'i',
  )
  const m = block.match(re)
  return m ? m[1] : null
}

function extractImageFromHtml(html: string): string | null {
  if (!html) return null
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i)
  return m ? m[1] : null
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripCdata(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;!\[CDATA\[([\s\S]*?)\]\]&gt;/g, '$1')
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

function parseDateToMs(s: string | null): number {
  if (!s) return Date.now()
  const t = Date.parse(s)
  if (Number.isNaN(t)) return Date.now()
  return t
}

/**
 * Thoroughly clean an RSS description field:
 *  1. Strip CDATA wrappers.
 *  2. Decode HTML entities (so &lt;p&gt; becomes <p>).
 *  3. Strip HTML tags (so <p> becomes nothing).
 *  4. Decode entities again (in case stripping revealed new entities).
 *  5. Collapse whitespace.
 *
 * This prevents encoded HTML like "&lt;p&gt;Hello&lt;/p&gt;" from showing
 * up as literal text in the card description.
 */
function cleanDescription(raw: string): string {
  let s = stripCdata(raw)
  s = decodeEntities(s)
  s = stripHtml(s)
  s = decodeEntities(s)
  s = s.replace(/\s+/g, ' ').trim()
  return s.slice(0, 400)
}

function hashId(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return 'a' + (h >>> 0).toString(36)
}

// ---------- Feed Fetcher ----------
async function fetchFeed(
  url: string,
  source: NewsSource,
  feedCategory: string,
  signal: AbortSignal,
): Promise<FeedArticle[]> {
  const cached = FEED_CACHE.get(url)
  if (cached && Date.now() - cached.ts < FEED_TTL_MS) {
    return cached.articles
  }
  try {
    const res = await fetch(url, {
      signal,
      headers: {
        'User-Agent': 'GroundNewsFree/1.0 (news aggregator; contact@example.com)',
        Accept: 'application/rss+xml, application/xml, application/atom+xml, text/xml, */*',
      },
      cache: 'no-store',
    })
    if (!res.ok) return cached?.articles ?? []
    const xml = await res.text()
    const articles = parseFeed(xml, source, feedCategory)
    FEED_CACHE.set(url, { ts: Date.now(), articles })
    return articles
  } catch {
    return cached?.articles ?? []
  }
}

// ---------- OG Image Fallback ----------
/**
 * Fetch an article's HTML page and extract the og:image (or twitter:image)
 * meta tag. Used as a fallback when no image was found in the RSS feed.
 *
 * Times out after 5s. Returns null on any failure.
 */
const OG_IMAGE_CACHE = new Map<string, { ts: number; url: string | null }>()
const OG_IMAGE_TTL_MS = 30 * 60 * 1000 // 30 min

async function fetchOgImage(articleUrl: string): Promise<string | null> {
  if (!articleUrl) return null

  const cached = OG_IMAGE_CACHE.get(articleUrl)
  if (cached && Date.now() - cached.ts < OG_IMAGE_TTL_MS) {
    return cached.url
  }

  try {
    const res = await fetch(articleUrl, {
      signal: AbortSignal.timeout(5000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible: NeutralWireBot/1.0)',
        Accept: 'text/html, application/xhtml+xml',
      },
      redirect: 'follow',
      cache: 'no-store',
    })
    if (!res.ok) {
      OG_IMAGE_CACHE.set(articleUrl, { ts: Date.now(), url: null })
      return null
    }
    const html = await res.text()
    // Extract og:image or twitter:image meta tag.
    const ogMatch = html.match(
      /<meta\s+(?:property|name)=["']og:image["']\s+content=["']([^"']+)["']/i,
    )
    if (ogMatch?.[1]) {
      const url = ogMatch[1]
      OG_IMAGE_CACHE.set(articleUrl, { ts: Date.now(), url })
      return url
    }
    const twMatch = html.match(
      /<meta\s+(?:property|name)=["']twitter:image["']\s+content=["']([^"']+)["']/i,
    )
    if (twMatch?.[1]) {
      const url = twMatch[1]
      OG_IMAGE_CACHE.set(articleUrl, { ts: Date.now(), url })
      return url
    }
    // Also try og:image:url and og:image:secure_url
    const ogAltMatch = html.match(
      /<meta\s+(?:property|name)=["']og:image:(?:secure_)?url["']\s+content=["']([^"']+)["']/i,
    )
    if (ogAltMatch?.[1]) {
      const url = ogAltMatch[1]
      OG_IMAGE_CACHE.set(articleUrl, { ts: Date.now(), url })
      return url
    }
    OG_IMAGE_CACHE.set(articleUrl, { ts: Date.now(), url: null })
    return null
  } catch {
    OG_IMAGE_CACHE.set(articleUrl, { ts: Date.now(), url: null })
    return null
  }
}

/**
 * Check if an image URL is actually fetchable by downloading it.
 * Many news CDNs block HEAD requests or external access, so we do a
 * full GET and check the content-type. Returns the validated URL or null.
 *
 * Caches the result so we don't re-fetch the same image on every aggregation.
 */
const VALIDATED_CACHE = new Map<string, { ts: number; ok: boolean }>()
const VALIDATED_TTL_MS = 30 * 60 * 1000

async function validateImageUrl(url: string): Promise<boolean> {
  const cached = VALIDATED_CACHE.get(url)
  if (cached && Date.now() - cached.ts < VALIDATED_TTL_MS) {
    return cached.ok
  }

  try {
    const parsedUrl = new URL(url)
    const referer = `${parsedUrl.protocol}//${parsedUrl.host}/`

    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        Referer: referer,
      },
      redirect: 'follow',
      cache: 'no-store',
    })
    if (!res.ok) {
      VALIDATED_CACHE.set(url, { ts: Date.now(), ok: false })
      return false
    }
    const ct = res.headers.get('content-type') || ''
    // Read a small chunk to confirm it's actually image data.
    const buf = await res.arrayBuffer()
    const ok = (ct.startsWith('image/') || buf.byteLength > 1000) && buf.byteLength < 10 * 1024 * 1024
    VALIDATED_CACHE.set(url, { ts: Date.now(), ok })
    return ok
  } catch {
    VALIDATED_CACHE.set(url, { ts: Date.now(), ok: false })
    return false
  }
}

/**
 * For a topic, find the best image URL that actually works.
 *
 * Strategy:
 * 1. Collect candidate images from: topic.imageUrl + all article imageUrls
 *    + OG images fetched from article pages.
 * 2. Validate each candidate with a HEAD request.
 * 3. Return the first valid image URL.
 *
 * Tries up to `maxAttempts` articles for OG images.
 */
async function findImageForTopic(
  topic: TopicArticle,
  maxAttempts = 4,
): Promise<string | null> {
  // Collect all candidate image URLs.
  const candidates: string[] = []
  if (topic.imageUrl) candidates.push(topic.imageUrl)
  for (const a of topic.articles) {
    if (a.imageUrl) candidates.push(a.imageUrl)
  }

  // Validate existing candidates first (fast — HEAD requests).
  for (const url of candidates) {
    if (await validateImageUrl(url)) return url
  }

  // If no existing candidate works, try fetching OG images from article pages.
  const prioritySources = ['nytimes', 'bbc', 'theguardian', 'cnbc', 'ft', 'npr']
  const sorted = [...topic.articles].sort((a, b) => {
    const aPriority = prioritySources.includes(a.sourceId) ? 0 : 1
    const bPriority = prioritySources.includes(b.sourceId) ? 0 : 1
    return aPriority - bPriority
  })

  for (let i = 0; i < Math.min(maxAttempts, sorted.length); i++) {
    const ogUrl = await fetchOgImage(sorted[i].link)
    if (ogUrl && await validateImageUrl(ogUrl)) return ogUrl
  }

  return null
}

// ---------- Topic Clustering ----------
/**
 * Cluster articles into topics based on title similarity.
 *
 * Two articles are clustered together if EITHER:
 *  - Jaccard similarity of their significant keywords >= 0.22 (lowered from 0.34
 *    to catch same-event stories worded differently), OR
 *  - They share 3+ significant keywords (catches cases where both titles are
 *    long and wordy, so Jaccard ratio is low even though they share key terms).
 *
 * Also: articles within 48h of each other (was 72h) to avoid clustering
 * unrelated stories that happen to share common words.
 *
 * `localSourceIds` is used to count how many articles per topic come from
 * the visitor's local sources — used by the Relevant tab to boost local news.
 */
function clusterTopics(
  articles: FeedArticle[],
  localSourceIds: Set<string> = new Set(),
): TopicArticle[] {
  const kwSets = articles.map((a) => titleKeywords(a.title))
  // Pre-compute as arrays for the "shared keyword count" check.
  const kwArrays = kwSets.map((s) => Array.from(s))

  const order = articles
    .map((_, i) => i)
    .sort((a, b) => articles[b].iso - articles[a].iso)

  const assigned = new Array(articles.length).fill(false)
  const topics: TopicArticle[] = []

  const JACCARD_THRESHOLD = 0.22
  const SHARED_KW_THRESHOLD = 3
  const TIME_WINDOW_MS = 48 * 60 * 60 * 1000

  for (const i of order) {
    if (assigned[i]) continue
    const clusterIdx: number[] = [i]
    assigned[i] = true

    for (const j of order) {
      if (assigned[j]) continue
      if (Math.abs(articles[i].iso - articles[j].iso) > TIME_WINDOW_MS) continue

      const sim = jaccard(kwSets[i], kwSets[j])
      if (sim >= JACCARD_THRESHOLD) {
        clusterIdx.push(j)
        assigned[j] = true
        continue
      }

      // Also cluster if they share enough significant keywords.
      // This catches same-event stories with different wording where
      // Jaccard is low (because the union is large) but they clearly
      // share the key entities.
      let shared = 0
      const setI = kwSets[i]
      for (const w of kwArrays[j]) {
        if (setI.has(w)) {
          shared++
          if (shared >= SHARED_KW_THRESHOLD) break
        }
      }
      if (shared >= SHARED_KW_THRESHOLD) {
        clusterIdx.push(j)
        assigned[j] = true
      }
    }

    let bestTitle = articles[clusterIdx[0]].title
    let bestSummary = articles[clusterIdx[0]].description
    let bestImage = articles[clusterIdx[0]].imageUrl
    let bestKwSize = kwSets[clusterIdx[0]].size
    let firstSeen = articles[clusterIdx[0]].iso
    let latestSeen = articles[clusterIdx[0]].iso

    let leanLeft = 0
    let leanCenter = 0
    let leanRight = 0
    let localCoverage = 0
    const seenSourceIds = new Set<string>()

    const clusterArticles: FeedArticle[] = []
    for (const idx of clusterIdx) {
      const a = articles[idx]
      const isLocal = localSourceIds.has(a.sourceId)
      if (seenSourceIds.has(a.sourceId)) {
        if (a.leaning === 'left') leanLeft++
        else if (a.leaning === 'center') leanCenter++
        else leanRight++
        if (isLocal) localCoverage++
        continue
      }
      seenSourceIds.add(a.sourceId)
      clusterArticles.push(a)
      if (a.leaning === 'left') leanLeft++
      else if (a.leaning === 'center') leanCenter++
      else leanRight++
      if (isLocal) localCoverage++

      if (kwSets[idx].size > bestKwSize) {
        bestKwSize = kwSets[idx].size
        bestTitle = a.title
        bestSummary = a.description
      }
      if (!bestImage && a.imageUrl) bestImage = a.imageUrl
      if (a.iso < firstSeen) firstSeen = a.iso
      if (a.iso > latestSeen) latestSeen = a.iso
    }

    const coverage = clusterArticles.length
    topics.push({
      topicId: hashId(bestTitle + '|' + firstSeen),
      title: bestTitle,
      summary: bestSummary,
      imageUrl: bestImage,
      coverage,
      leanLeft,
      leanCenter,
      leanRight,
      firstSeen,
      latestSeen,
      articles: clusterArticles.sort((a, b) => b.iso - a.iso),
      localCoverage,
    })
  }

  return topics
}

// ---------- Public: aggregate a category ----------
/**
 * Fetch all feeds for a category, dedup, cluster, return topics.
 * This is the slow path (10-20s) and is only used when:
 *   - Firebase cache is empty/missing, OR
 *   - User explicitly clicks Refresh, OR
 *   - Background refresh decides the cache is stale
 *
 * For virtual categories (`relevant`, `mycountry`), pass `countrySourceIds`
 * — the list of source IDs relevant to the visitor's country.
 */
export async function aggregateCategory(
  category: Category,
  options: {
    limit?: number
    minCoverage?: number
    countrySourceIds?: string[]
  } = {},
): Promise<{ topics: TopicArticle[]; articleCount: number; sourceCount: number }> {
  const limit = options.limit ?? 24
  const minCoverage = options.minCoverage ?? 1

  const feeds = feedsForCategory(category, {
    countrySourceIds: options.countrySourceIds,
  })
  const ac = new AbortController()
  const timeout = setTimeout(() => ac.abort(), 18000)

  try {
    const results = await Promise.all(
      feeds.map((f) => fetchFeed(f.url, f.source, f.feedCategory, ac.signal)),
    )
    clearTimeout(timeout)

    const all: FeedArticle[] = []
    for (const r of results) all.push(...r)

    const seen = new Set<string>()
    const dedup: FeedArticle[] = []
    for (const a of all) {
      const key = a.sourceId + '|' + a.link
      if (seen.has(key)) continue
      seen.add(key)
      dedup.push(a)
    }

    const cutoff = Date.now() - 48 * 60 * 60 * 1000
    const fresh = dedup.filter((a) => a.iso >= cutoff)

    const localSet = new Set(options.countrySourceIds ?? [])
    const isRelevantMode = category === 'relevant' && localSet.size > 0

    const topics = clusterTopics(fresh, isRelevantMode ? localSet : new Set())

    // Sort: for `relevant` category, give LOCAL news much higher priority
    // while keeping the absolute top stories based on coverage.
    //
    // The relevance score is:
    //   coverage * 10 + localCoverage * 5 + (hasLocal ? 30 : 0)
    //
    // - coverage * 10: a 12-source story (120) still beats an 11-source
    //   story (110) at the base level, so the biggest international story
    //   stays at #1.
    // - localCoverage * 5: each local source adds 5 points, so a 3-source
    //   UK story with 8 local sources scores 30 + 40 = 70, beating a
    //   5-source international story (50).
    // - hasLocal bonus (+30): any story with at least 1 local source gets
    //   a flat +30 boost, pushing UK-relevant stories above comparable
    //   international ones.
    //
    // Net effect: the major 10+ source story stays #1, but UK-focused
    // stories (even with just 2-3 sources) jump above mid-tier
    // international stories.
    const filtered = topics
      .filter((t) => t.coverage >= minCoverage)
      .sort((a, b) => {
        if (isRelevantMode) {
          const la = a.localCoverage ?? 0
          const lb = b.localCoverage ?? 0
          const scoreA = a.coverage * 10 + la * 5 + (la > 0 ? 30 : 0)
          const scoreB = b.coverage * 10 + lb * 5 + (lb > 0 ? 30 : 0)
          if (scoreB !== scoreA) return scoreB - scoreA
          return b.latestSeen - a.latestSeen
        }
        if (b.coverage !== a.coverage) return b.coverage - a.coverage
        return b.latestSeen - a.latestSeen
      })
      .slice(0, limit)

    // Image validation + fallback: for the top N topics, validate that the
    // existing imageUrl actually works (many CDNs return 401/403). If it
    // doesn't, or if there's no image, try to find a working one from the
    // article images or OG images.
    //
    // This runs in parallel for the top 10 topics to keep it fast.
    const topicsForImageCheck = filtered.slice(0, 10)
    await Promise.all(
      topicsForImageCheck.map(async (topic) => {
        const img = await findImageForTopic(topic, 3)
        if (img) topic.imageUrl = img
        else topic.imageUrl = null // ensure broken URLs are cleared
      }),
    )

    return {
      topics: filtered,
      articleCount: fresh.length,
      sourceCount: NEWS_SOURCES.length,
    }
  } catch (err) {
    clearTimeout(timeout)
    throw err
  }
}
