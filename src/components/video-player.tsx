'use client'

/**
 * video-player.tsx — the Watch feature, in-article INLINE video.
 *
 * Opened by the Watch square on the ARTICLE VIEW's hero image (bottom-left;
 * home-screen cards never show it) — or AUTO-OPENED with `initialVideo`
 * when the user taps a home-feed card whose video preview is rolling
 * (user: "when I click on the preview it should open the article with
 * the video playing, not the normal image with the play button"). Tapping
 * Watch / the preview plays the video INSIDE the news image itself — the
 * image box becomes the player and the close square restores the photo.
 *
 * NO LOADING UI (user spec): while the video resolves and buffers, the
 * overlay stays TRANSPARENT — the news photo keeps showing through; there
 * is no black box, no shimmer, no spinner. The player (YouTube embed via
 * the official IFrame API, or a native <video>) mounts hidden and the
 * overlay only fades to black + video once the player reports it is
 * genuinely PLAYING.
 *
 * Fetches /api/video/[topicId]?hl=…&gl=… (the user's locale — UK users
 * get English coverage), which resolves:
 *   1. the source's OWN video (RSS video enclosures / YouTube feeds), or
 *   2. a YouTube video about the story from a news outlet.
 * Both paths enforce the quality requirements: the video's channel must
 * have >= 10k subscribers and the video must run longer than 10 seconds
 * (concise, < 7 min, coverage preferred — see video-quality.ts).
 *
 * AUTO-RETRY: a failed fetch (network error, or the API's "no video" /
 * "not-found" outcomes) is re-run automatically up to 2 times — a
 * resolution that hiccuped once often succeeds on a second pass. Retries
 * carry ?retry=N so the server skips its cached miss and re-resolves; the
 * "disabled" outcome (feature flag off) is never retried.
 *
 * Rendering:
 *   - kind 'youtube' → IFrame-API player (youtube-nocookie, autoplay,
 *     own control bar incl. fullscreen fs=1; fades in on PLAYING)
 *   - kind 'video'   → native <video controls autoPlay>
 *   - fetching       → transparent overlay (photo visible), close square
 *   - miss           → compact "no video yet" panel with a close square
 */

import * as React from 'react'
import { motion } from 'framer-motion'
import { Play, ExternalLink, AlertCircle, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { loadYouTubeIframeApi, type YTPlayer } from '@/lib/youtube-player'
import { videoLocaleParams, type ResolvedVideo } from '@/lib/video-preview-store'

export interface VideoPlayerProps {
  topicId: string
  storyTitle: string
  onClose: () => void
  /** The article was opened from a playing home-feed preview: play THIS
   *  video immediately (no fetch, no loading state). */
  initialVideo?: ResolvedVideo
}

interface VideoApiResponse {
  ok: boolean
  kind?: 'youtube' | 'video'
  videoId?: string
  url?: string
  title?: string
  author?: string
  sourceUrl?: string
  aspect?: number
  reason?: string
}

/** Max automatic re-runs after a failed fetch (user: "if a video fails to
 *  fetch, try to rerun the function automatically because it might work"). */
const MAX_AUTO_RETRIES = 2
const RETRY_DELAY_MS = 700

/** ── YouTube embed via the IFrame API ──
 *
 * controls + fullscreen live on YouTube's own bar; the overlay fades in
 * only on the first PLAYING report (no black loading frame). Falls back
 * to a bare iframe if the API script can't load (rare). */
function ArticleYouTubePlayer({
  videoId,
  storyTitle,
  onPlaying,
  onDead,
}: {
  videoId: string
  storyTitle: string
  onPlaying: () => void
  /** The player rejected this video (embed-disallowed etc.) — the
   *  parent reports it to the resolver and swaps to the next candidate. */
  onDead: (videoId: string) => void
}) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const playerRef = React.useRef<YTPlayer | null>(null)
  const [fallbackIframe, setFallbackIframe] = React.useState(false)
  const reportedRef = React.useRef(false)

  React.useEffect(() => {
    let cancelled = false
    loadYouTubeIframeApi()
      .then((YT) => {
        if (cancelled || !hostRef.current) return
        const player = new YT.Player(hostRef.current, {
          videoId,
          host: 'https://www.youtube-nocookie.com',
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 1,
            // Sound ON at normal volume — the tap that opened this is a
            // user gesture, so audible autoplay is allowed.
            mute: 0,
            rel: 0,
            fs: 1,
            modestbranding: 1,
            playsinline: 1,
            origin: window.location.origin,
          },
          events: {
            // The user just tapped — a gesture — so audible autoplay is
            // permitted; on the rare block, mute + retry so it still plays
            // (the control bar's speaker re-enables sound).
            onAutoplayBlocked: () => {
              try {
                playerRef.current?.mute()
                playerRef.current?.playVideo()
              } catch {
                // silent
              }
            },
            onStateChange: (e) => {
              if (!cancelled && !reportedRef.current && e.data === 1 /* PLAYING */) {
                reportedRef.current = true
                onPlaying()
              }
            },
            onError: () => {
              // 101/150 = the owner disallows embedding — report the dead
              // video; the parent swaps to the next candidate.
              if (!cancelled) onDead(videoId)
            },
          },
        })
        playerRef.current = player
      })
      .catch(() => {
        // IFrame API unavailable — plain embed (rare fallback).
        if (!cancelled) setFallbackIframe(true)
      })
    return () => {
      cancelled = true
      try {
        playerRef.current?.destroy()
      } catch {
        // silent
      }
      playerRef.current = null
    }
     
  }, [videoId])

  if (fallbackIframe) {
    return (
      <iframe
        key={videoId}
        src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&fs=1&modestbranding=1`}
        title={storyTitle}
        className="h-full w-full"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
      />
    )
  }
  return (
    // The API REPLACES the inner host div with its iframe — sizing
    // classes live on this stable outer wrapper.
    <div className="absolute inset-0 [&_iframe]:h-full [&_iframe]:w-full">
      <div ref={hostRef} />
    </div>
  )
}

export function InlineVideo({ topicId, storyTitle, onClose, initialVideo }: VideoPlayerProps) {
  const [video, setVideo] = React.useState<VideoApiResponse | null>(
    initialVideo ?? null,
  )
  const [loading, setLoading] = React.useState(!initialVideo)
  // The player is genuinely rolling → fade the (black + video) overlay in.
  const [playing, setPlaying] = React.useState(false)
  // Native <video> playback failed (hotlink protection etc.)
  const [videoError, setVideoError] = React.useState(false)
  // >0 while an automatic retry is in flight.
  const [retrying, setRetrying] = React.useState(0)
  // Videos the player rejected (embed-disallowed) — the fetch re-runs
  // with them excluded so the resolver returns the NEXT candidate.
  const [deadIds, setDeadIds] = React.useState<string[]>([])

  // ── Fetch the resolved video for this story — with automatic retries ──
  // Skipped entirely when the preview handed us the resolved video.
  // Re-runs when a dead video is reported (the resolver excludes it).
  React.useEffect(() => {
    if (initialVideo && deadIds.length === 0) return
    let cancelled = false
    setLoading(true)
    setRetrying(0)
    setVideoError(false)

    const run = (attempt: number) => {
      const locale = videoLocaleParams()
      const dead = deadIds.length > 0 ? `&dead=${deadIds.map(encodeURIComponent).join(',')}` : ''
      const retry = attempt > 0 ? `&retry=${attempt}` : ''
      fetch(
        `/api/video/${encodeURIComponent(topicId)}?${locale}${retry}${dead}`,
        { cache: 'no-store' },
      )
        .then((r) => r.json())
        .then(async (data: VideoApiResponse) => {
          if (cancelled) return
          const failed =
            !data?.ok && data?.reason !== 'disabled' && attempt < MAX_AUTO_RETRIES
          if (failed) {
            // Transient failure — it might just work on a rerun.
            await new Promise((res) => setTimeout(res, RETRY_DELAY_MS))
            if (cancelled) return
            setRetrying(attempt + 1)
            run(attempt + 1)
            return
          }
          setVideo(data)
          setLoading(false)
        })
        .catch(async () => {
          if (cancelled) return
          if (attempt < MAX_AUTO_RETRIES) {
            await new Promise((res) => setTimeout(res, RETRY_DELAY_MS))
            if (cancelled) return
            setRetrying(attempt + 1)
            run(attempt + 1)
            return
          }
          setVideo({ ok: false, reason: 'no-video' })
          setLoading(false)
        })
    }
    run(0)
    return () => {
      cancelled = true
    }
  }, [topicId, initialVideo, deadIds])

  // ── The player rejected the current video (embed-disallowed etc.) ──
  // Report every rejected id (the resolver remembers them server-side)
  // and swap to the next candidate — up to three times; exhausted shows
  // the miss panel.
  const handleDeadVideo = (deadVideoId: string) => {
    setPlaying(false)
    if (deadIds.includes(deadVideoId) || deadIds.length >= 3) {
      setVideo({ ok: false, reason: 'no-video' })
      setLoading(false)
      return
    }
    setDeadIds((prev) => [...prev, deadVideoId])
  }

  // ── Native <video> autoplay fallback ──
  // The autoPlay attribute tries audible playback (allowed — the tap
  // that opened this player is a user gesture). If the browser still
  // blocks it, retry muted after a beat so SOMETHING plays (the control
  // bar re-enables sound). Deps on the native src so it re-arms when a
  // native video element actually mounts (or swaps).
  const nativeRef = React.useRef<HTMLVideoElement | null>(null)
  React.useEffect(() => {
    const el = nativeRef.current
    if (!el) return
    const probe = setTimeout(() => {
      if (el.paused && el.currentTime === 0) {
        el.muted = true
        el.play().catch(() => {
          // controls are visible — the user can start it manually
        })
      }
    }, 1200)
    return () => clearTimeout(probe)
  }, [video?.url])

  const ready = !loading && !!video?.ok

  return (
    // Transparent until the player is actually PLAYING (user spec: the
    // news photo keeps showing — never a black loading box). Once
    // playing, the black backing + video fade in.
    <div
      className={cn(
        'absolute inset-0 z-[3] transition-colors duration-200',
        playing ? 'bg-black' : 'bg-transparent',
      )}
    >
      {/* ── Player area — fills the news image box. The embed's own
              control bar handles play/pause + fullscreen (fs=1 /
              <video controls>). Hidden (opacity 0) until PLAYING. */}
      {ready && video?.kind === 'youtube' && video.videoId ? (
        <div
          className="absolute inset-0 transition-opacity duration-200"
          style={{ opacity: playing ? 1 : 0 }}
        >
          <ArticleYouTubePlayer
            videoId={video.videoId}
            storyTitle={video.title || storyTitle}
            onPlaying={() => setPlaying(true)}
            onDead={handleDeadVideo}
          />
        </div>
      ) : ready && video?.kind === 'video' && video.url ? (
        <video
          ref={nativeRef}
          key={video.url}
          src={video.url}
          data-nw-video=""
          className="absolute inset-0 h-full w-full object-cover transition-opacity duration-200"
          style={{ opacity: playing ? 1 : 0 }}
          controls
          autoPlay
          playsInline
          onPlaying={() => setPlaying(true)}
          onError={() => setVideoError(true)}
        />
      ) : !ready ? (
        // Resolving (or auto-retrying) — TRANSPARENT: the photo shows
        // through; only the close square (below) marks that anything is
        // happening. No spinner, no shimmer (user spec).
        <div className="absolute inset-0" aria-live="polite">
          <span className="sr-only">
            {retrying > 0 ? 'Retrying video search…' : 'Finding a video…'}
          </span>
        </div>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black px-6 text-center">
          <AlertCircle className="h-6 w-6 text-white/50" />
          <div className="text-sm font-medium text-white/80">
            {video?.reason === 'disabled'
              ? 'The video feature is turned off'
              : 'No video found for this story yet'}
          </div>
          <div className="text-[11px] text-white/50">
            {video?.reason === 'disabled'
              ? 'It can be re-enabled from the debug panel.'
              : 'Some very fresh stories have no video coverage — try again later.'}
          </div>
        </div>
      )}

      {/* Native <video> playback failed (hotlink protection etc.) */}
      {videoError && video?.kind === 'video' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/90 px-6 text-center">
          <AlertCircle className="h-6 w-6 text-white/60" />
          <div className="text-sm font-medium text-white/80">
            This source video can't be played here
          </div>
          {video.url && (
            <a
              href={video.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-white/20"
            >
              <ExternalLink className="h-3 w-3" />
              Open video at the source
            </a>
          )}
        </div>
      )}

      {/* Close square — restores the news image. Same visual language as
          the Watch square (solid black, flush corner), top-RIGHT so it
          never fights the Watch square's bottom-left. Visible from the
          very first moment (even while resolving — the only affordance
          while the photo is still showing). */}
      <motion.button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          // Pause a native <video> immediately (iframes die on unmount).
          try {
            const el = document.querySelector<HTMLVideoElement>('[data-nw-video]')
            if (el) el.pause()
          } catch {
            // silent
          }
          onClose()
        }}
        whileTap={{ scale: 0.9 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        className="absolute right-0 top-0 z-[4] flex h-11 w-11 items-center justify-center bg-black/85 text-white shadow-lg backdrop-blur-[2px]"
        aria-label="Close video and show the image"
        title="Close video"
      >
        <X className="h-5 w-5" />
      </motion.button>

      {/* Playing: tiny byline chip (bottom-right, above the NW mark's spot
          while the video owns the box) — who the coverage is from. */}
      {playing && video?.ok && (
        <div className="pointer-events-none absolute bottom-0 right-0 z-[2] flex items-center gap-1.5 bg-black/70 py-1 pl-2 pr-2 backdrop-blur-[2px]">
          <Play className="h-3 w-3 shrink-0 text-white/70" />
          <span className="max-w-[45vw] truncate text-[10px] font-semibold uppercase leading-none tracking-wide text-white/80">
            {video.author || 'news video'}
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * The Watch button — a solid black square FLUSH in the image's bottom-LEFT
 * corner (touching both the left and bottom edges; the image's own rounded
 * corner clips it), a single large drawn play triangle centered inside —
 * no text. Renders ONLY inside the article view (topic-detail hero image)
 * — never on home-screen cards (the NW brand mark owns the bottom-right
 * corner). pointer-events-auto + stopPropagation so tapping it opens the
 * video without hitting the image/link underneath.
 */
export function WatchPill({
  onClick,
}: {
  onClick: () => void
}) {
  return (
    <motion.button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        e.preventDefault()
        onClick()
      }}
      whileTap={{ scale: 0.9 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className="pointer-events-auto absolute bottom-0 left-0 z-[2] flex h-[54px] w-[54px] items-center justify-center bg-black text-white"
      aria-label="Watch a video about this story"
      title="Watch — video coverage of this story"
    >
      {/* Large drawn play triangle */}
      <svg
        viewBox="0 0 24 24"
        className="h-[26px] w-[26px] shrink-0"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M8.6 4.9v14.2c0 .91.98 1.46 1.76 1L21.25 13a1.17 1.17 0 0 0 0-2L10.36 3.9c-.78-.46-1.76.09-1.76 1z" />
      </svg>
    </motion.button>
  )
}
