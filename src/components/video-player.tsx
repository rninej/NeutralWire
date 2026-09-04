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
 * FULLSCREEN: the video area is a "stage" element with its OWN fullscreen
 * square (top-right corner). The embed's own fullscreen control is not
 * always offered (narrow portrait YouTube players hide it; some iframes
 * lack the permission), so we never depend on it — requestFullscreen()
 * runs on OUR stage element, which works for iframes and native video
 * alike and needs no iframe permission. iPhone Safari has no element
 * fullscreen at all: a native <video> hands off to Apple's system player,
 * anything else falls back to a pseudo-fullscreen (the dialog card itself
 * goes edge-to-edge). While fullscreen, tapping the screen (top strip,
 * letterbox areas, or any iframe interaction seen via window blur/focus)
 * reveals an exit chip in the top-right corner that un-fullscreens.
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
import { X, Play, ExternalLink, Clapperboard, AlertCircle, Loader2, Maximize2, Minimize2 } from 'lucide-react'

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

  // ── Fullscreen ──
  // The stage is the video-area element itself: fullscreening OUR element
  // works for both iframes and native video, and needs no iframe
  // permission (the embed's own fullscreen button is not always offered —
  // narrow portrait players hide it — so we always surface our own).
  const stageRef = React.useRef<HTMLDivElement | null>(null)
  const videoRef = React.useRef<HTMLVideoElement | null>(null)
  const fsExitTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const [realFs, setRealFs] = React.useState(false)
  const [pseudoFs, setPseudoFs] = React.useState(false)
  const [fsExitVisible, setFsExitVisible] = React.useState(false)
  const isFs = realFs || pseudoFs

  const handleClose = React.useCallback(() => {
    if (closing) return
    setClosing(true)
    // Drop pseudo-fullscreen first so the exit animation runs from the
    // normal card, not the edge-to-edge one.
    setPseudoFs(false)
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

  // ── Fullscreen machinery ───────────────────────────────────────────

  /** Reveal the exit-fullscreen chip and restart its idle auto-hide. */
  const showFsExit = React.useCallback(() => {
    setFsExitVisible(true)
    if (fsExitTimer.current) clearTimeout(fsExitTimer.current)
    fsExitTimer.current = setTimeout(() => setFsExitVisible(false), 3000)
  }, [])

  const enterFs = React.useCallback(() => {
    const stageEl = stageRef.current as
      | (HTMLDivElement & { webkitRequestFullscreen?: () => void })
      | null
    if (!stageEl) return
    const canElementFs =
      typeof stageEl.requestFullscreen === 'function' ||
      typeof stageEl.webkitRequestFullscreen === 'function'
    if (canElementFs) {
      try {
        if (typeof stageEl.requestFullscreen === 'function') {
          stageEl.requestFullscreen().catch(() => setPseudoFs(true))
        } else {
          stageEl.webkitRequestFullscreen?.()
        }
        return
      } catch {
        setPseudoFs(true)
        return
      }
    }
    // iPhone Safari: no element fullscreen — a native <video> can still
    // hand off to Apple's system player; anything else gets the
    // pseudo-fullscreen (edge-to-edge) card.
    const v = videoRef.current as
      | (HTMLVideoElement & { webkitEnterFullscreen?: () => void })
      | null
    if (v && typeof v.webkitEnterFullscreen === 'function') {
      try {
        v.webkitEnterFullscreen()
        return
      } catch {
        // fall through to pseudo-fullscreen
      }
    }
    setPseudoFs(true)
  }, [])

  const exitFs = React.useCallback(() => {
    setPseudoFs(false)
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null
      webkitExitFullscreen?: () => void
    }
    if (!document.fullscreenElement && !doc.webkitFullscreenElement) return
    try {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {})
      else doc.webkitExitFullscreen?.()
    } catch {
      doc.webkitExitFullscreen?.()
    }
  }, [])

  // Track real fullscreen (the user may also exit via system UI / ESC).
  React.useEffect(() => {
    const onChange = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element | null }
      const active = Boolean(document.fullscreenElement || doc.webkitFullscreenElement)
      setRealFs(active)
      if (!active) setPseudoFs(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    document.addEventListener('webkitfullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      document.removeEventListener('webkitfullscreenchange', onChange)
    }
  }, [])

  // While fullscreen: reveal the exit chip on any interaction we CAN
  // observe — the top strip, the letterbox areas, and (for taps landing
  // INSIDE the cross-origin iframe, which never bubble to us) the window
  // blur/focus pair that fires as focus moves in and out of the embed.
  React.useEffect(() => {
    if (!isFs) {
      setFsExitVisible(false)
      return
    }
    showFsExit()
    const onInteract = () => showFsExit()
    document.addEventListener('click', onInteract, true)
    document.addEventListener('touchstart', onInteract, true)
    window.addEventListener('blur', onInteract)
    window.addEventListener('focus', onInteract)
    return () => {
      document.removeEventListener('click', onInteract, true)
      document.removeEventListener('touchstart', onInteract, true)
      window.removeEventListener('blur', onInteract)
      window.removeEventListener('focus', onInteract)
    }
  }, [isFs, showFsExit])

  // Never leak the exit-chip timer.
  React.useEffect(
    () => () => {
      if (fsExitTimer.current) clearTimeout(fsExitTimer.current)
    },
    [],
  )

  // ESC exits fullscreen first; a second ESC closes the player.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (realFs || pseudoFs) exitFs()
        else handleClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [realFs, pseudoFs, exitFs, handleClose])

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

  if (!mounted || !portalEl) return null

  // Adaptive sizing: the CARD wraps the video box, so its width follows the
  // ratio too. width = min(100%, 62dvh * ratio + border, 2xl) — a portrait
  // video gets a narrow tall card (fills the phone height), a landscape
  // video gets the classic wide card, and the height never overflows.
  const ratioCss = `${Math.round(ratio * 10000) / 10000}`
  const cardWidth = `min(100%, calc(${MAX_VIDEO_DVH}dvh * ${ratioCss} + 2px), 42rem)`

  const overlay = (
    <motion.div
      className={`fixed inset-0 z-[90] flex items-center justify-center ${
        pseudoFs ? 'bg-black p-0' : 'bg-black/70 p-4 backdrop-blur-sm'
      }`}
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
        className={`overflow-hidden bg-background shadow-2xl ${
          pseudoFs
            ? 'flex h-[100dvh] w-screen flex-col rounded-none border-0'
            : 'rounded-2xl border transition-[width] duration-300 ease-out'
        }`}
        style={{ width: pseudoFs ? '100vw' : cardWidth }}
        initial={{ opacity: 0, scale: 0.92, y: 24 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 16 }}
        transition={{ duration: 0.28, ease: EASE_OUT }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header (hidden while pseudo-fullscreen — the screen belongs to
            the video alone) */}
        {!pseudoFs && (
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
        )}

        {/* Player area — the fullscreen STAGE. Normally sized to the
            video's actual proportions; fills the screen while fullscreen
            (real Fullscreen API top-layer, or the in-flow pseudo-fullscreen
            card for iPhone Safari). */}
        <div
          ref={stageRef}
          className="relative w-full bg-black"
          style={
            isFs
              ? { aspectRatio: 'auto', maxHeight: 'none', width: '100%', height: '100%' }
              : { aspectRatio: ratioCss, maxHeight: `${MAX_VIDEO_DVH}dvh` }
          }
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
              ref={videoRef}
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

          {/* Tap strip (fullscreen only): tapping the top edge of the
              screen reveals the exit chip. Taps INSIDE a cross-origin
              iframe never reach us — the strip, the letterbox areas and
              the window blur/focus pair cover the "tap the screen"
              reveal. */}
          {isFs && (
            <div
              className="absolute inset-x-0 top-0 z-[2] h-10"
              onClick={(e) => {
                e.stopPropagation()
                showFsExit()
              }}
            />
          )}

          {/* Our OWN fullscreen square — always offered whenever a video
              plays. Some embeds (narrow portrait players, iframes without
              the permission) never surface their own fullscreen control,
              so we never depend on it. */}
          {!isFs && video?.ok && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                e.preventDefault()
                enterFs()
              }}
              className="absolute right-2 top-2 z-[3] flex h-10 w-10 items-center justify-center rounded-xl bg-black/85 text-white shadow-lg backdrop-blur-[2px] transition-transform active:scale-95"
              aria-label="Fullscreen"
              title="Fullscreen"
            >
              <Maximize2 className="h-[18px] w-[18px]" />
            </button>
          )}

          {/* Exit-fullscreen chip — reveals when the screen is tapped,
              hides again after a few idle seconds. */}
          {isFs && fsExitVisible && (
            <motion.button
              type="button"
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.18, ease: EASE_OUT }}
              onClick={(e) => {
                e.stopPropagation()
                e.preventDefault()
                exitFs()
              }}
              className="absolute right-3 top-3 z-[4] flex h-11 w-11 items-center justify-center rounded-xl bg-black/85 text-white shadow-lg backdrop-blur-[2px] transition-transform active:scale-95"
              aria-label="Exit fullscreen"
              title="Exit fullscreen"
            >
              <Minimize2 className="h-5 w-5" />
            </motion.button>
          )}
        </div>

        {/* Footer (hidden while pseudo-fullscreen) */}
        {!pseudoFs && (
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
        )}
      </motion.div>
    </motion.div>
  )

  return createPortal(
    <AnimatePresence>{!closing ? overlay : null}</AnimatePresence>,
    portalEl,
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
