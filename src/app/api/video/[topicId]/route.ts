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
 * LANGUAGE (user spec: "the videos should be in the language you are
 * in — UK → English, e.g. the Hideki Shirakawa story"): the client
 * sends ?hl=<lang>&gl=<country> (from the picked language + country,
 * see lib/video-preview-store). The search page is fetched with that
 * hl=/gl= + a matching Accept-Language, and candidates whose TITLE is
 * written in a foreign script are demoted behind same-language ones
 * (never excluded). Resolution results are cached PER LANGUAGE, so a
 * Japanese user and a UK user never share a video.
 *
 * QUALITY REQUIREMENTS (user spec, enforced by lib/video-quality.ts):
 * every YouTube video must run LONGER THAN 10 SECONDS and come from a
 * channel with AT LEAST 10,000 SUBSCRIBERS — videos that fail either
 * check are skipped and the resolver moves to the next candidate. On
 * top of the gate, candidates are ordered LANGUAGE-FIRST (user spec:
 * UK → English) then LANDSCAPE-FIRST (user spec: "try harder to fetch
 * videos which are in landscape mode") then CONCISE-FIRST (a video at
 * or under 7 minutes beats a half-hour broadcast roundup that only
 * mentions the story). Portrait short-form videos are NOT excluded
 * anymore — they resolve when a story has no landscape coverage, and
 * the big cards show them too (user: "make it so the big cards show
 * short form videos too"). The search prefers uploads from the story's
 * own outlets (the "source's video" preference). Native RSS source
 * videos enforce the duration rule when the feed declares a
 * media:content duration attribute; the subs rule is a
 * YouTube-channel concept and doesn't apply to a vetted outlet's own
 * feed enclosure.
 *
 * Results are cached in Firebase (videos6/<topicId>__<hl> — namespace
 * bumped from videos4 for the LANDSCAPE-FIRST ranking at the MEASURED
 * (oar2) aspect level: a portrait winner is only a fallback, the scan
 * keeps hunting for a landscape candidate. Cached v4 entries predate
 * the whole language+landscape ordering, so they re-resolve): 24h for a
 * found video, 6h for a "no video" miss. Every resolution is bounded by a
 * ~10.5s budget, and never happens while the videoWatch feature flag
 * is off — /debug can kill the whole feature instantly (this endpoint
 * returns { ok: false, disabled: true } and the UI hides the pill).
 * The preview (HeroVideoPreview) shares this endpoint with the same
 * cache — resolving once for a card also arms the article's Watch
 * button.
 *
 * Response:
 *   { ok: true, kind: 'youtube', videoId, title, author, sourceUrl, aspect }
 *   { ok: true, kind: 'video', url, title, author }
 *   { ok: false, reason: 'no-video' | 'disabled' | 'not-found' }
 *
 * `aspect` (w/h, e.g. 0.5625 for 9:16) is measured from the video's
 * original-aspect thumbnail — the resolver ranks LANDSCAPE candidates
 * ahead of portrait ones, and the client letterboxes a portrait Short
 * inside the 16:9 image box instead of rejecting it.
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

// ── Resolution cache (Firebase videos6/<topicId>__<hl>) ──
// v6 namespace: landscape-first at the MEASURED oar aspect (v5:
// thumb-hint ranking; v4: language-aware ranking + per-language keys).
// Old v4/v5 entries are ignored so everything re-resolves once under
// the new ordering.
const FOUND_TTL_MS = 24 * 60 * 60 * 1000
const MISS_TTL_MS = 6 * 60 * 60 * 1000

/** Firestore/RTDB-safe cache key: topic + language. */
function cacheKey(topicId: string, hl: string): string {
  return `videos6/${topicId}__${hl}`
}

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
  /** Videos the player rejected (embed-disallowed) — accumulated per
   *  story+language so future resolutions skip them for the cache's
   *  lifetime. */
  dead?: string[]
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

  // ── User locale (user spec: the video should be in the user's
  //    language — UK → English). Validated tightly: hl's primary subtag
  //    (2 letters) and gl (2 letters). Defaults keep the old behaviour.
  const hlRaw = (req.nextUrl.searchParams.get('hl') || 'en').toLowerCase()
  const hlMatch = hlRaw.match(/^([a-z]{2})(?:-[a-z]{2,4})?$/)
  const hl = hlMatch ? hlMatch[1] : 'en'
  const glRaw = req.nextUrl.searchParams.get('gl') || ''
  const gl = /^[a-z]{2}$/i.test(glRaw) ? glRaw.toUpperCase() : ''
  const acceptLanguage = gl
    ? `${hl}-${gl},${hl};q=0.9,en;q=0.8`
    : `${hl},en;q=0.8`

  // ── Dead-video report (client saw YouTube error 101/150 — the owner
  //    disallows embedding; oEmbed can't detect this, so the player
  //    reports it back). Accepts MULTIPLE ids (?dead=id1,id2) — the
  //    resolver re-runs, skipping every reported video, and the cached
  //    entry remembers them all so future resolutions skip them too.
  const deadRaw = req.nextUrl.searchParams.get('dead') || ''
  const deadIds = deadRaw
    .split(',')
    .map((x) => x.trim())
    .filter((x) => /^[\w-]{11}$/.test(x))
    .slice(0, 8)
  let excludeDead: string[] = []

  // 1. Feature flag — /debug can kill the feature instantly (no resolving
  //    CPU is spent while it's off; the UI also hides the pill).
  const enabled = await isVideoWatchEnabled()
  if (!enabled) {
    return NextResponse.json(
      { ok: false, reason: 'disabled' },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }

  // 2. Cache (per-topic + language, TTL by outcome). videos6/ — see
  //    header comment. A retry run skips CACHED MISSES only —
  //    re-resolving in case the first pass failed on a transient fetch.
  //    A cached YouTube FOUND entry without an `aspect` predates the
  //    aspect measurement (the preview's landscape gate needs it) —
  //    re-resolve so it gains one. A dead-video report forces a live
  //    re-resolution with the reported video(s) excluded.
  try {
    const cached = await firebaseRead<CachedVideo>(cacheKey(topicId, hl))
    const cachedDead = Array.isArray(cached?.dead)
      ? cached.dead.filter((x) => /^[\w-]{11}$/.test(x))
      : []
    if (deadIds.length > 0) {
      excludeDead = [...new Set([...cachedDead, ...deadIds])]
    } else {
      if (cached?.result && typeof cached.ts === 'number') {
        // The cached video itself was reported dead earlier — resolve
        // live rather than echoing a video the player rejects.
        const cachedIsDead =
          cached.result.ok &&
          !!cached.result.videoId &&
          cachedDead.includes(cached.result.videoId!)
        const staleAspect =
          cached.result.ok &&
          cached.result.kind === 'youtube' &&
          typeof cached.result.aspect !== 'number'
        const ttl = cached.result.ok ? FOUND_TTL_MS : MISS_TTL_MS
        if (
          Date.now() - cached.ts < ttl &&
          !staleAspect &&
          !cachedIsDead &&
          (cached.result.ok || !isRetry)
        ) {
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
    void cacheResult(topicId, hl, miss)
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
      void cacheResult(topicId, hl, found)
      return NextResponse.json(found, {
        headers: { 'Cache-Control': 'no-store' },
      })
    }
  }

  // 5. YouTube search — a video about the story from a news outlet that
  //    meets the requirements (alive, >10s, >=10k subs), preferring
  //    uploads from the story's own outlets AND the user's language
  //    (hl/gl + Accept-Language + script demotion).
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
      { hl, gl, acceptLanguage },
      excludeDead,
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
      void cacheResult(topicId, hl, found, excludeDead)
      return NextResponse.json(found, {
        headers: { 'Cache-Control': 'no-store' },
      })
    }
  }

  // 6. Nothing found — cache the miss (short TTL) so repeat taps on the
  //    same story don't re-scrape.
  const miss: VideoResult = { ok: false, reason: 'no-video' }
  void cacheResult(topicId, hl, miss, excludeDead)
  return NextResponse.json(miss, { headers: { 'Cache-Control': 'no-store' } })
}

async function cacheResult(
  topicId: string,
  hl: string,
  result: VideoResult,
  dead: string[] = [],
): Promise<void> {
  try {
    await firebaseWrite(cacheKey(topicId, hl), {
      ts: Date.now(),
      result,
      ...(dead.length > 0 ? { dead } : {}),
    })
  } catch {
    // best-effort — a failed cache write just means we resolve again later
  }
}
