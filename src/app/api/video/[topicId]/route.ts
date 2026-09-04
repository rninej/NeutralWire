import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import { findTopicAnywhere } from '@/lib/topic-lookup'
import {
  MIN_DURATION_SECONDS,
  searchYouTubeForStory,
  youTubeIdFromUrl,
} from '@/lib/video-quality'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 15

/**
 * Video resolution for the experimental Watch button — /api/video/[topicId].
 *
 * The user opens an article and taps the Watch pill (bottom-left of the
 * hero image — the pill only exists inside the article view, never on
 * home-screen cards) → the client fetches this endpoint → we resolve ONE
 * playable video for the story, in priority order:
 *
 *   1. The SOURCE'S OWN video — the topic's articles now carry videoUrl
 *      (RSS media:content/enclosure with a video type, or a YouTube watch
 *      link when the source feed IS a YouTube channel). Extracted at
 *      ingest in news-aggregator.ts.
 *   2. A video ABOUT the story from a news outlet — a YouTube search for
 *      the headline (server-side, no API key), relevance-checked so we
 *      return a video actually about the story.
 *
 * QUALITY REQUIREMENTS (user spec, enforced by lib/video-quality.ts):
 * every YouTube video must run LONGER THAN 10 SECONDS and come from a
 * channel with AT LEAST 10,000 SUBSCRIBERS — videos that fail either
 * check are skipped and the resolver moves to the next candidate. The
 * search prefers uploads from the story's own outlets (the "source's
 * video" preference — a bare YouTube videoId can't be quality-checked
 * directly, but the outlet's own upload about the story normally tops
 * the results). Native RSS source videos enforce the duration rule when
 * the feed declares a media:content duration attribute; the subs rule is
 * a YouTube-channel concept and doesn't apply to a vetted outlet's own
 * feed enclosure.
 *
 * Results are cached in Firebase (videos2/<topicId> — namespace bumped
 * from "videos" so every entry cached before the requirements are
 * ignored): 24h for a found video, 6h for a "no video" miss. Every
 * resolution is user-initiated, bounded by a ~10.5s budget, and never
 * happens while the videoWatch feature flag is off — /debug can kill the
 * whole feature instantly (this endpoint returns { ok: false, disabled:
 * true } and the UI hides the pill).
 *
 * Response:
 *   { ok: true, kind: 'youtube', videoId, title, author, sourceUrl, aspect }
 *   { ok: true, kind: 'video', url, title, author }
 *   { ok: false, reason: 'no-video' | 'disabled' | 'not-found' }
 *
 * `aspect` (w/h, e.g. 0.5625 for 9:16) is measured from the video's
 * original-aspect thumbnail so the popup can match the video's real
 * proportions (portrait Shorts no longer letterbox inside a landscape
 * box).
 *
 * ?retry=1/2 — sent by the player's automatic retry: a CACHED MISS is
 * skipped so the endpoint re-resolves instead of echoing "no video" back
 * (a resolution that hiccuped once often works on a second pass). Cached
 * FOUND videos are still returned instantly.
 */

// Whole-resolution budget: slow YouTube fetches can never eat the 15s
// function cap — past the budget we return (and cache a short-TTL miss).
const RESOLVE_BUDGET_MS = 10_500

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

// ── Resolution cache (Firebase videos2/<topicId>) ──
// v2 namespace: bumping it invalidated every pre-requirements entry —
// cached "found" results may not meet the >=10k-subs / >10s rules.
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
  /** w/h of the actual video — sizes the Watch popup (0.5625 = 9:16). */
  aspect?: number
  reason?: string
}

interface CachedVideo {
  ts: number
  result: VideoResult
}

interface TopicForVideo {
  title: string
  articles?: Array<{
    link?: string
    videoUrl?: string | null
    videoDuration?: number | null
    sourceName?: string
  }>
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ topicId: string }> },
) {
  const { topicId } = await ctx.params
  if (!topicId) {
    return NextResponse.json(
      { ok: false, reason: 'not-found' },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }

  // The player's automatic retry — skip cached misses so the resolution
  // actually re-runs (a transient YouTube/aggregate hiccup can succeed on
  // the second pass). Cached FOUND videos still short-circuit.
  const isRetry = req.nextUrl.searchParams.get('retry') === '1' ||
    req.nextUrl.searchParams.get('retry') === '2'

  // 1. Feature flag — /debug can kill the feature instantly (no resolving
  //    CPU is spent while it's off; the UI also hides the pill).
  const enabled = await isVideoWatchEnabled()
  if (!enabled) {
    return NextResponse.json(
      { ok: false, reason: 'disabled' },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }

  // 2. Cache (per-topic, TTL by outcome). videos2/ — see header comment.
  //    A retry run skips CACHED MISSES only — re-resolving in case the
  //    first pass failed on a transient fetch.
  try {
    const cached = await firebaseRead<CachedVideo>(`videos2/${topicId}`)
    if (cached?.result && typeof cached.ts === 'number') {
      const ttl = cached.result.ok ? FOUND_TTL_MS : MISS_TTL_MS
      if (Date.now() - cached.ts < ttl) {
        if (cached.result.ok || !isRetry) {
          return NextResponse.json(cached.result, {
            headers: { 'Cache-Control': 'no-store' },
          })
        }
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

  // Shared deadline for the whole resolution.
  const deadline = Date.now() + RESOLVE_BUDGET_MS

  // 4. The source's OWN NATIVE video (a direct mp4/m3u8/... enclosure in
  //    the outlet's RSS feed). The >10s rule applies when the feed
  //    declares a media:content duration attribute; the 10k-subs rule is
  //    a YouTube-channel concept and doesn't apply to a vetted outlet's
  //    own enclosure. YouTube-shaped videoUrls/links are NOT embedded
  //    directly — a bare videoId has no keyless duration source (watch
  //    pages 429-block server IPs), so it could never pass the quality
  //    gate; instead the search below prefers the story's own outlets,
  //    which surfaces the source's upload when it exists.
  const articles = topic.articles || []
  for (const a of articles) {
    const videoUrl = a?.videoUrl || null
    if (!videoUrl) continue
    if (youTubeIdFromUrl(videoUrl)) continue // search path handles YouTube
    if (/^https?:\/\//i.test(videoUrl)) {
      const declared = a?.videoDuration
      if (typeof declared === 'number' && !(declared > MIN_DURATION_SECONDS)) {
        continue // the feed itself says this clip is too short
      }
      const found: VideoResult = {
        ok: true,
        kind: 'video',
        url: videoUrl,
        title: topic.title,
        author: a?.sourceName || 'Source video',
      }
      void cacheResult(topicId, found)
      return NextResponse.json(found, {
        headers: { 'Cache-Control': 'no-store' },
      })
    }
  }

  // 5. YouTube search — a video about the story from a news outlet that
  //    meets the requirements (alive, >10s, >=10k subs), preferring
  //    uploads from the story's own outlets.
  if (Date.now() < deadline) {
    const sourceNames = [
      ...new Set(
        articles
          .map((a) => a?.sourceName)
          .filter((n): n is string => typeof n === 'string' && !!n),
      ),
    ].slice(0, 12)
    const searchHit = await searchYouTubeForStory(
      topic.title,
      deadline,
      sourceNames,
    )
    if (searchHit) {
      const found: VideoResult = {
        ok: true,
        kind: 'youtube',
        videoId: searchHit.videoId,
        title: searchHit.title,
        author: searchHit.author,
        sourceUrl: `https://www.youtube.com/watch?v=${searchHit.videoId}`,
        aspect: searchHit.aspect ?? undefined,
      }
      void cacheResult(topicId, found)
      return NextResponse.json(found, {
        headers: { 'Cache-Control': 'no-store' },
      })
    }
  }

  // 6. Nothing found — cache the miss (short TTL) so repeat taps on the
  //    same story don't re-scrape.
  const miss: VideoResult = { ok: false, reason: 'no-video' }
  void cacheResult(topicId, miss)
  return NextResponse.json(miss, { headers: { 'Cache-Control': 'no-store' } })
}

async function cacheResult(topicId: string, result: VideoResult): Promise<void> {
  try {
    await firebaseWrite(`videos2/${topicId}`, { ts: Date.now(), result })
  } catch {
    // best-effort — a failed cache write just means we resolve again later
  }
}
