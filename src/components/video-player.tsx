'use client'

/**
 * video-player.tsx — the Watch overlay (experimental video feature).
 *
 * Opened by the Watch pill on the ARTICLE VIEW's hero image (bottom-left;
 * home-screen cards never show it). Fetches /api/video/[topicId], which
 * resolves:
 *   1. the source's OWN video (RSS video enclosures / YouTube feeds), or
 *   2. a YouTube video about the story from a news outlet.
 * Both paths enforce the quality requirements: the video's channel must
 * have ≥ 10k subscribers and the video must run longer than 10 seconds.
 *
 * Rendering:
 *   - kind 'youtube' → privacy-enhanced iframe embed (youtube-nocookie)
 *   - kind 'video'   → native <video controls> for direct mp4/etc URLs
 *   - loading        → shimmer skeleton with a pulsing play icon
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
  reason?: string
}

const EASE_OUT = [0.16, 1, 0.3, 1] as const

export function VideoPlayer({ topicId, storyTitle, onClose }: VideoPlayerProps) {
  const [mounted, setMounted] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [video, setVideo] = React.useState<VideoApiResponse | null>(null)
  const [videoError, setVideoError] = React.useState(false)
  const [portalEl, setPortalEl] = React.useState<HTMLElement | null>(null)
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

  // Fetch the resolved video for this story.
  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/video/${encodeURIComponent(topicId)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data: VideoApiResponse) => {
        if (cancelled) return
        setVideo(data)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setVideo({ ok: false, reason: 'no-video' })
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [topicId])

  // ESC closes.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleClose])

  if (!mounted || !portalEl) return null

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
        className="w-full max-w-2xl overflow-hidden rounded-2xl border bg-background shadow-2xl"
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
                ? 'Finding a video for this story…'
                : video?.ok
                  ? `via ${video.author || 'a news outlet'} · video coverage of this story`
                  : 'Watch — experimental'}
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

        {/* Player area — 16:9 */}
        <div className="relative aspect-video w-full bg-black">
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
                Fetching video from a news outlet…
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
            {video?.ok
              ? 'Video fetched from a news outlet covering this story'
              : 'Experimental — plays a news video about this story'}
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
 * The Watch pill — the entry point for the experimental video feature.
 * Renders ONLY inside the article view (topic-detail hero image), pinned
 * to the image's BOTTOM-LEFT corner (user request: watch from the article
 * only, on the left side — the NW brand mark owns the bottom-right).
 * pointer-events-auto + stopPropagation so tapping it opens the video
 * without hitting the image/link underneath.
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
      className="pointer-events-auto absolute bottom-2 left-2 z-[2] flex h-8 items-center gap-1.5 rounded-full bg-black/65 px-3 font-semibold text-white shadow-lg backdrop-blur-[3px] transition-colors hover:bg-black/80 active:scale-95"
      aria-label="Watch a video about this story"
      title="Watch — video coverage of this story"
    >
      <motion.span
        className="flex h-4.5 w-4.5 items-center justify-center rounded-full bg-red-500 p-0.5"
        initial={{ scale: 0.8 }}
        animate={{ scale: 1 }}
      >
        <Play className="h-2.5 w-2.5 fill-white" />
      </motion.span>
      <span className="text-[11px] tracking-wide">Watch</span>
    </motion.button>
  )
}
