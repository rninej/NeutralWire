'use client'

/**
 * video-player.tsx — the Watch overlay (video feature).
 *
 * Opened by the Watch square on the ARTICLE VIEW's hero image (bottom-left;
 * home-screen cards never show it). Fetches /api/video/[topicId], which
 * resolves:
 *   1. the source's OWN video (RSS video enclosures / YouTube feeds), or
 *   2. a YouTube video about the story from a news outlet.
 * Both paths enforce the quality requirements: the video's channel must
 * have >= 10k subscribers and the video must run longer than 10 seconds.
 *
 * ADAPTIVE PROPORTIONS: the popup sizes itself to the video's real aspect
 * ratio, not a fixed landscape box. The API reports the ratio for YouTube
 * results (original-aspect thumbnail measurement, server-side); native
 * <video> sources are measured live from videoWidth/videoHeight the moment
 * metadata loads. A portrait (Shorts-style) video gets a portrait popup —
 * no more tiny letterboxed video on phones.
 *
 * AUTO-RETRY: a failed fetch (network error, or the API's "no video" /
 * "not-found" outcomes) is re-run automatically up to 2 times — a
 * resolution that hiccuped once often succeeds on a second pass. Retries
 * carry ?retry=N so the server skips its cached miss and re-resolves; the
 * "disabled" outcome (feature flag off) is never retried.
 *
 * Rendering:
 *   - kind 'youtube' → privacy-enhanced iframe embed (youtube-nocookie)
 *   - kind 'video'   → native <video controls> for direct mp4/etc URLs
 *   - loading        → shimmer skeleton with a spinner
 *   - miss           → friendly "no video yet" card
 *
 * Portaled to document.body (the article overlay animates with a
 * transform — a plain fixed child inside it would move with the sheet
 * during swipe-to-close; a portal escapes that containing block).
 * Scroll lock saves/restores the PREVIOUS body overflow so closing the
 * player inside the article view never unlocks the article's own lock.
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Play, ExternalLink, Clapperboard, AlertCircle, Loader2 } from 'lucide-react'

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
  /** Width / height of the actual video (e.g. 0.5625 for 9:16, 1.778 for
   * 16:9). Present for YouTube results; native videos measure themselves
   * client-side via videoWidth/videoHeight. */
  aspect?: number
  reason?: string
}

const EASE_OUT = [0.16, 1, 0.3, 1] as const

/** Video area height cap — leaves room for the dialog header + footer
 * inside the viewport (with the overlay's p-4) on any phone. */
const MAX_VIDEO_DVH = 62

/** Max automatic re-runs after a failed fetch (user: "if a video fails to
 * fetch, try to rerun the function automatically because it might work"). */
const MAX_AUTO_RETRIES = 2
const RETRY_DELAY_MS = 700

/** Kept in a sane range so a bogus ratio can never collapse the popup. */
function clampRatio(r: number | null | undefined): number | null {
  if (typeof r !== 'number' || !Number.isFinite(r)) return null
  if (r < 0.4 || r > 2.6) return null
  return Math.round(r * 10000) / 10000
}

export function VideoPlayer({ topicId, storyTitle, onClose }: VideoPlayerProps) {
  const [mounted, setMounted] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [video, setVideo] = React.useState<VideoApiResponse | null>(null)
  const [videoError, setVideoError] = React.useState(false)
  const [portalEl, setPortalEl] = React.useState<HTMLElement | null>(null)
  // The popup's current aspect ratio (starts 16:9 while loading, snaps to
  // the video's real proportions the moment they're known).
  const [ratio, setRatio] = React.useState(16 / 9)
  // >0 while an automatic retry is in flight (shows "Trying again…").
  const [retrying, setRetrying] = React.useState(0)
  // Closing state plays the exit animation BEFORE the parent unmounts us
  // (the parent's conditional render can't animate a portaled exit).
  const [closing, setClosing] = React.useState(false)

  const handleClose = React.useCallback(() => {
    if (closing) return
    setClosing(true)
    // Pause a native <video> immediately on close (iframes die on unmount).
    try {
      const el = document.querySelector<HTMLVideoElement>('[data-nw-video]')
      if (el) el.pause()
    } catch {
      // silent
    }
    setTimeout(onClose, 200)
  }, [closing, onClose])

  // Portal target + scroll lock (save/restore the PREVIOUS overflow so we
  // never clobber the article overlay's own lock).
  React.useEffect(() => {
    setMounted(true)
    setPortalEl(document.body)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  // Fetch the resolved video for this story — with automatic retries.
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

  // Adopt the video's proportions: the API-reported aspect when present,
  // else the live videoWidth/videoHeight of a native <video> (see
  // onLoadedMetadata below — it overrides this for kind 'video').
  React.useEffect(() => {
    if (!video) return
    const r = clampRatio(video.aspect)
    setRatio(r ?? 16 / 9)
  }, [video])

  const handleLoadedMetadata = React.useCallback(
    (e: React.SyntheticEvent<HTMLVideoElement>) => {
      const el = e.currentTarget
      const r = clampRatio(
        el.videoWidth && el.videoHeight ? el.videoWidth / el.videoHeight : null,
      )
      if (r) setRatio(r)
    },
    [],
  )

  // ESC closes.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleClose])

  if (!mounted || !portalEl) return null

  // Adaptive sizing: the CARD wraps the video box, so its width follows the
  // ratio too. width = min(100%, 62dvh * ratio + border, 2xl) — a portrait
  // video gets a narrow tall card (fills the phone height), a landscape
  // video gets the classic wide card, and the height never overflows.
  const ratioCss = `${Math.round(ratio * 10000) / 10000}`
  const cardWidth = `min(100%, calc(${MAX_VIDEO_DVH}dvh * ${ratioCss} + 2px), 42rem)`

  const overlay = (
    <motion.div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Video: ${storyTitle}`}
    >
      <motion.div
        className="overflow-hidden rounded-2xl border bg-background shadow-2xl transition-[width] duration-300 ease-out"
        style={{ width: cardWidth }}
        initial={{ opacity: 0, scale: 0.92, y: 24 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 16 }}
        transition={{ duration: 0.28, ease: EASE_OUT }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 border-b px-4 py-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-500">
            <Clapperboard className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-bold leading-tight">
              {video?.title || storyTitle}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {loading
                ? retrying > 0
                  ? 'First attempt came up empty — trying again…'
                  : 'Finding a video for this story…'
                : video?.ok
                  ? `via ${video.author || 'a news outlet'} · video coverage of this story`
                  : 'No video found for this story'}
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close video"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Player area — sized to the video's actual proportions */}
        <div
          className="relative w-full bg-black"
          style={{ aspectRatio: ratioCss, maxHeight: `${MAX_VIDEO_DVH}dvh` }}
        >
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
              src={`https://www.youtube-nocookie.com/embed/${video.videoId}?autoplay=1&rel=0&modestbranding=1`}
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
              onLoadedMetadata={handleLoadedMetadata}
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
                  className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-white/20"
                >
                  <ExternalLink className="h-3 w-3" />
                  Open video at the source
                </a>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-4 py-2.5 text-[11px] text-muted-foreground">
          <Play className="h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {video?.ok ? 'Video fetched from a news outlet covering this story' : 'Plays a news video about this story'}
          </span>
          {video?.sourceUrl && (
            <a
              href={video.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline"
            >
              Source
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </motion.div>
    </motion.div>
  )

  return createPortal(
    <AnimatePresence>{!closing ? overlay : null}</AnimatePresence>,
    portalEl,
  )
}

/**
 * The Watch button — a clean black square embedded in the image's
 * BOTTOM-LEFT corner: a large drawn play triangle on top, small "watch"
 * text beneath it. Renders ONLY inside the article view (topic-detail hero
 * image) — never on home-screen cards (the NW brand mark owns the
 * bottom-right corner). pointer-events-auto + stopPropagation so tapping
 * it opens the video without hitting the image/link underneath.
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
      whileTap={{ scale: 0.92 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className="pointer-events-auto absolute bottom-2 left-2 z-[2] flex w-[54px] flex-col items-center justify-center gap-[3px] rounded-xl bg-black/90 pb-[7px] pt-[10px] text-white shadow-lg backdrop-blur-[2px] transition-colors hover:bg-black active:scale-95"
      aria-label="Watch a video about this story"
      title="Watch — video coverage of this story"
    >
      {/* Large drawn triangle (play) */}
      <svg
        viewBox="0 0 24 24"
        className="h-[19px] w-[19px] shrink-0"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M8.6 4.9v14.2c0 .91.98 1.46 1.76 1L21.25 13a1.17 1.17 0 0 0 0-2L10.36 3.9c-.78-.46-1.76.09-1.76 1z" />
      </svg>
      <span className="text-[9px] font-semibold uppercase leading-none tracking-[0.1em]">
        Watch
      </span>
    </motion.button>
  )
}
