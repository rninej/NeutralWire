'use client'

/**
 * video-player.tsx — the Watch feature, in-article INLINE video.
 *
 * Opened by the Watch square on the ARTICLE VIEW's hero image (bottom-left;
 * home-screen cards never show it). Tapping it plays the video INSIDE the
 * news image itself (user request: "it should play the video in the news
 * image, not in a popup") — the image box becomes the player and a small
 * close square restores the photo. No popup, no portal, no custom
 * fullscreen UI: the embedded player's own control bar (YouTube's fs=1
 * button / the native <video> controls) handles fullscreen.
 *
 * Fetches /api/video/[topicId], which resolves:
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
 *   - kind 'youtube' → privacy-enhanced iframe embed (youtube-nocookie,
 *     autoplay=1, rel=0, fs=1 — its own control bar incl. fullscreen)
 *   - kind 'video'   → native <video controls autoPlay> for direct URLs
 *   - loading        → dark shimmer + spinner over the image
 *   - miss           → compact "no video yet" panel with a close square
 */

import * as React from 'react'
import { motion } from 'framer-motion'
import { Play, ExternalLink, AlertCircle, Loader2, X } from 'lucide-react'

export interface VideoPlayerProps {
  topicId: string
  storyTitle: string
  onClose: () => void
}

interface VideoApiResponse {
  ok: boolean
  kind?: 'youtube' | 'video'
  videoId?: string
  url?: string
  title?: string
  author?: string
  sourceUrl?: string
  reason?: string
}

const EASE_OUT = [0.16, 1, 0.3, 1] as const

/** Max automatic re-runs after a failed fetch (user: "if a video fails to
 *  fetch, try to rerun the function automatically because it might work"). */
const MAX_AUTO_RETRIES = 2
const RETRY_DELAY_MS = 700

export function InlineVideo({ topicId, storyTitle, onClose }: VideoPlayerProps) {
  const [loading, setLoading] = React.useState(true)
  const [video, setVideo] = React.useState<VideoApiResponse | null>(null)
  // Native <video> playback failed (hotlink protection etc.)
  const [videoError, setVideoError] = React.useState(false)
  // >0 while an automatic retry is in flight (shows "Trying again…").
  const [retrying, setRetrying] = React.useState(0)

  // ── Fetch the resolved video for this story — with automatic retries ──
  // A failed pass (fetch throw, ok:false with a non-disabled reason) re-runs
  // up to MAX_AUTO_RETRIES times; retries send ?retry=N so the server
  // re-resolves instead of echoing its cached miss.
  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setRetrying(0)
    setVideoError(false)

    const run = (attempt: number) => {
      fetch(
        `/api/video/${encodeURIComponent(topicId)}${
          attempt > 0 ? `?retry=${attempt}` : ''
        }`,
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
  }, [topicId])

  return (
    <motion.div
      className="absolute inset-0 z-[3] bg-black"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.22, ease: EASE_OUT }}
    >
      {/* ── Player area — fills the news image box. The embed's own control
              bar handles play/pause + fullscreen (fs=1 / <video controls>). */}
      {loading ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
          {/* Shimmer bars */}
          <div className="absolute inset-0 overflow-hidden">
            <div className="absolute inset-x-0 top-1/4 h-3 animate-pulse rounded bg-white/5" />
            <div className="absolute inset-x-8 top-1/2 h-3 animate-pulse rounded bg-white/5 [animation-delay:150ms]" />
            <div className="absolute inset-x-16 top-3/4 h-3 animate-pulse rounded bg-white/5 [animation-delay:300ms]" />
          </div>
          <Loader2 className="h-6 w-6 animate-spin text-white/60" />
          <span className="text-xs text-white/60">
            {retrying > 0
              ? 'Trying again — sometimes the first attempt just misses…'
              : 'Fetching video from a news outlet…'}
          </span>
        </div>
      ) : video?.ok && video.kind === 'youtube' && video.videoId ? (
        <iframe
          key={video.videoId}
          src={`https://www.youtube-nocookie.com/embed/${video.videoId}?autoplay=1&rel=0&fs=1&modestbranding=1`}
          title={video.title || storyTitle}
          className="h-full w-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      ) : video?.ok && video.kind === 'video' && video.url ? (
        <video
          key={video.url}
          src={video.url}
          data-nw-video=""
          className="h-full w-full"
          controls
          autoPlay
          playsInline
          onError={() => setVideoError(true)}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
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
          never fights the Watch square's bottom-left. */}
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
      {!loading && video?.ok && (
        <div className="pointer-events-none absolute bottom-0 right-0 z-[2] flex items-center gap-1.5 bg-black/70 py-1 pl-2 pr-2 backdrop-blur-[2px]">
          <Play className="h-3 w-3 shrink-0 text-white/70" />
          <span className="max-w-[45vw] truncate text-[10px] font-semibold uppercase leading-none tracking-wide text-white/80">
            {video.author || 'news video'}
          </span>
        </div>
      )}
    </motion.div>
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
