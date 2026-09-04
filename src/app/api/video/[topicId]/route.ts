import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import { findTopicAnywhere } from '@/lib/topic-lookup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 15

/**
 * Video resolution for the experimental Watch button — /api/video/[topicId].
 *
 * The user taps the Watch pill on an article image (card or article view)
 * → the client fetches this endpoint → we resolve ONE playable video for
 * the story, in priority order:
 *
 *   1. The SOURCE'S OWN video — the topic's articles now carry videoUrl
 *      (RSS media:content/enclosure with a video type, or a YouTube watch
 *      link when the source feed IS a YouTube channel). Extracted at
 *      ingest in news-aggregator.ts.
 *   2. A video ABOUT the story from a news outlet — a YouTube search for
 *      the headline (server-side, no API key), verified with YouTube's
 *      keyless oEmbed endpoint and a light relevance check so we return a
 *      video actually about the story, not a random match.
 *
 * Results are cached in Firebase (videos/<topicId>): 24h for a found
 * video, 6h for a "no video" miss. Every resolution is user-initiated and
 * at most 2 outbound fetches (search + oEmbed) + 1-2 Firebase reads, and
 * never happens while the videoWatch feature flag is off — /debug can
 * kill the whole feature instantly (this endpoint returns
 * { ok: false, disabled: true } and the UI hides the buttons).
 *
 * Response:
 *   { ok: true, kind: 'youtube', videoId, title, author, sourceUrl }
 *   { ok: true, kind: 'video', url, title, author }
 *   { ok: false, reason: 'no-video' | 'disabled' | 'not-found' }
 */

// ── Feature flag (Firebase featureFlags/videoWatch, default ON) ──
let videoFlagMemo: { value: boolean; ts: number } | null = null
const VIDEO_FLAG_MEMO_MS = 60 * 1000

async function isVideoWatchEnabled(): Promise<boolean> {
  if (videoFlagMemo && Date.now() - videoFlagMemo.ts < VIDEO_FLAG_MEMO_MS) {
    return videoFlagMemo.value
  }
  let value = true
  try {
    const stored = await firebaseRead<boolean | string>('featureFlags/videoWatch')
    if (stored === false || stored === 'false') value = false
  } catch {
    // Firebase unreachable — stay ON (the button is UI-gated anyway)
  }
  videoFlagMemo = { value, ts: Date.now() }
  return value
}

// ── Resolution cache (Firebase videos/<topicId>) ──
const FOUND_TTL_MS = 24 * 60 * 60 * 1000
const MISS_TTL_MS = 6 * 60 * 60 * 1000

interface VideoResult {
  ok: boolean
  kind?: 'youtube' | 'video'
  videoId?: string
  url?: string
  title?: string
  author?: string
  sourceUrl?: string
  reason?: string
}

interface CachedVideo {
  ts: number
  result: VideoResult
}

// ── YouTube helpers ──

/** Extract a YouTube videoId from any watch/short/youtu.be URL shape. */
function youTubeIdFromUrl(url: string): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '').toLowerCase()
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0]
      return /^[\w-]{11}$/.test(id) ? id : null
    }
    if (host.endsWith('youtube.com')) {
      if (u.pathname === '/watch') {
        const v = u.searchParams.get('v')
        return v && /^[\w-]{11}$/.test(v) ? v : null
      }
      const shortMatch = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/)
      return shortMatch ? shortMatch[1] : null
    }
    return null
  } catch {
    const m = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/)
    return m ? m[1] : null
  }
}

const YT_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'from', 'by', 'is', 'was', 'are', 'were', 'be', 'as', 'it', 'its',
  'this', 'that', 'new', 'news', 'video', 'watch', 'live', 'update', 'says',
  'said', 'after', 'amid', 'over', 'into', 'up', 'down', 'out', 'off',
])

function keywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !YT_STOPWORDS.has(w))
}

/** Count shared significant keywords between the story and a video title. */
function sharedKeywords(a: string, b: string): number {
  const ka = new Set(keywords(a))
  const kb = new Set(keywords(b))
  let shared = 0
  for (const w of ka) if (kb.has(w)) shared++
  return shared
}

const NEWS_CHANNEL_HINTS = [
  'news', 'tv', 'times', 'bbc', 'cnn', 'guardian', 'reuters', 'sky', 'itv',
  'channel', 'abc', 'nbc', 'cbs', 'al jazeera', 'independent', 'telegraph',
  'post', 'express', 'mail', 'mirror', 'sun', 'press', 'journal', 'daily',
  'herald', 'agency', 'radio', 'media', 'group', 'broadcast', 'now', 'world',
]

/** oEmbed-verify a YouTube video and return its title + channel. */
async function verifyYouTubeVideo(videoId: string): Promise<{
  title: string
  author: string
} | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${videoId}`,
      )}&format=json`,
      { signal: controller.signal, cache: 'no-store' },
    )
    clearTimeout(timer)
    if (!res.ok) return null
    const data = (await res.json()) as { title?: string; author_name?: string }
    if (!data?.title) return null
    return { title: data.title, author: data.author_name || 'YouTube' }
  } catch {
    return null
  }
}

/**
 * Search YouTube for a video about the story. Server-side scrape of the
 * public results page (no API key): the HTML embeds ytInitialData JSON
 * which contains every result's videoId. We take the first handful of
 * unique ids in result order, oEmbed-verify each (also filters dead /
 * private videos), and pick the first that's plausibly about the story:
 *   - ≥2 significant keywords shared with the headline, OR
 *   - the channel name looks like a news outlet.
 */
async function searchYouTubeForStory(
  storyTitle: string,
): Promise<{ videoId: string; title: string; author: string } | null> {
  const query = storyTitle.replace(/["?&/\\]/g, ' ').slice(0, 70).trim() + ' news'
  if (!query.trim()) return null

  let html = ''
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    const res = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
      {
        signal: controller.signal,
        cache: 'no-store',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept-Language': 'en-GB,en;q=0.9',
        },
      },
    )
    clearTimeout(timer)
    if (!res.ok) return null
    html = await res.text()
  } catch {
    return null
  }

  // Collect unique videoIds in result order (ytInitialData repeats each id
  // many times — the Set dedupes while preserving first-seen order).
  const seen = new Set<string>()
  const ids: string[] = []
  const re = /"videoId":"([\w-]{11})"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null && ids.length < 6) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      ids.push(m[1])
    }
  }
  if (ids.length === 0) return null

  let firstVerified: { videoId: string; title: string; author: string } | null = null
  for (const videoId of ids) {
    const verified = await verifyYouTubeVideo(videoId)
    if (!verified) continue
    const candidate = { videoId, ...verified }
    if (!firstVerified) firstVerified = candidate
    // Relevance: shared keywords with the headline, or a news-y channel.
    const shared = sharedKeywords(storyTitle, verified.title)
    const authorLower = verified.author.toLowerCase()
    const looksLikeNews = NEWS_CHANNEL_HINTS.some((h) => authorLower.includes(h))
    if (shared >= 2 || (shared >= 1 && looksLikeNews)) {
      return candidate
    }
  }
  // No candidate passed the relevance check — fall back to the first
  // verified video only when its channel looks like a news outlet.
  if (firstVerified) {
    const authorLower = firstVerified.author.toLowerCase()
    if (NEWS_CHANNEL_HINTS.some((h) => authorLower.includes(h))) {
      return firstVerified
    }
  }
  return null
}

// ── Route ──

interface TopicForVideo {
  title: string
  articles?: Array<{ link?: string; videoUrl?: string | null; sourceName?: string }>
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ topicId: string }> },
) {
  const { topicId } = await ctx.params
  if (!topicId) {
    return NextResponse.json(
      { ok: false, reason: 'not-found' },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }

  // 1. Feature flag — /debug can kill the feature instantly (no resolving
  //    CPU is spent while it's off; the UI also hides the buttons).
  const enabled = await isVideoWatchEnabled()
  if (!enabled) {
    return NextResponse.json(
      { ok: false, reason: 'disabled' },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }

  // 2. Cache (per-topic, TTL by outcome).
  try {
    const cached = await firebaseRead<CachedVideo>(`videos/${topicId}`)
    if (cached?.result && typeof cached.ts === 'number') {
      const ttl = cached.result.ok ? FOUND_TTL_MS : MISS_TTL_MS
      if (Date.now() - cached.ts < ttl) {
        return NextResponse.json(cached.result, {
          headers: { 'Cache-Control': 'no-store' },
        })
      }
    }
  } catch {
    // Firebase read failed — resolve live (rare)
  }

  // 3. Find the topic (live cache + archive).
  let topic: TopicForVideo | null = null
  try {
    topic = (await findTopicAnywhere(topicId)) as TopicForVideo | null
  } catch {
    topic = null
  }
  if (!topic?.title) {
    const miss: VideoResult = { ok: false, reason: 'not-found' }
    void cacheResult(topicId, miss)
    return NextResponse.json(miss, { headers: { 'Cache-Control': 'no-store' } })
  }

  // 4. The source's OWN video first (RSS video enclosures / YouTube feeds).
  const articles = topic.articles || []
  for (const a of articles) {
    // 4a. An explicit videoUrl on the article (RSS media:content/enclosure).
    const videoUrl = a?.videoUrl || null
    if (videoUrl) {
      const ytId = youTubeIdFromUrl(videoUrl)
      if (ytId) {
        const verified = await verifyYouTubeVideo(ytId)
        const found: VideoResult = {
          ok: true,
          kind: 'youtube',
          videoId: ytId,
          title: verified?.title || topic.title,
          author: verified?.author || a?.sourceName || 'YouTube',
          sourceUrl: `https://www.youtube.com/watch?v=${ytId}`,
        }
        void cacheResult(topicId, found)
        return NextResponse.json(found, { headers: { 'Cache-Control': 'no-store' } })
      }
      if (/^https?:\/\//i.test(videoUrl)) {
        const found: VideoResult = {
          ok: true,
          kind: 'video',
          url: videoUrl,
          title: topic.title,
          author: a?.sourceName || 'Source video',
        }
        void cacheResult(topicId, found)
        return NextResponse.json(found, { headers: { 'Cache-Control': 'no-store' } })
      }
    }
    // 4b. The article LINK itself is a YouTube video (YouTube-channel feeds).
    const linkId = a?.link ? youTubeIdFromUrl(a.link) : null
    if (linkId) {
      const verified = await verifyYouTubeVideo(linkId)
      if (verified) {
        const found: VideoResult = {
          ok: true,
          kind: 'youtube',
          videoId: linkId,
          title: verified.title,
          author: verified.author || a?.sourceName || 'YouTube',
          sourceUrl: `https://www.youtube.com/watch?v=${linkId}`,
        }
        void cacheResult(topicId, found)
        return NextResponse.json(found, { headers: { 'Cache-Control': 'no-store' } })
      }
    }
  }

  // 5. YouTube search fallback — a video about the story from a news outlet.
  const searchHit = await searchYouTubeForStory(topic.title)
  if (searchHit) {
    const found: VideoResult = {
      ok: true,
      kind: 'youtube',
      videoId: searchHit.videoId,
      title: searchHit.title,
      author: searchHit.author,
      sourceUrl: `https://www.youtube.com/watch?v=${searchHit.videoId}`,
    }
    void cacheResult(topicId, found)
    return NextResponse.json(found, { headers: { 'Cache-Control': 'no-store' } })
  }

  // 6. Nothing found — cache the miss (short TTL) so repeat taps on the
  //    same story don't re-scrape.
  const miss: VideoResult = { ok: false, reason: 'no-video' }
  void cacheResult(topicId, miss)
  return NextResponse.json(miss, { headers: { 'Cache-Control': 'no-store' } })
}

async function cacheResult(topicId: string, result: VideoResult): Promise<void> {
  try {
    await firebaseWrite(`videos/${topicId}`, { ts: Date.now(), result })
  } catch {
    // best-effort — a failed cache write just means we resolve again later
  }
}
