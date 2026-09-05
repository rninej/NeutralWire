'use client'

/**
 * video-player.tsx — the Watch feature, in-article INLINE video.
 *
 * OPENED BY the Watch square on the ARTICLE VIEW's hero image
 * (bottom-left; home-screen cards never show it) — or AUTO-OPENED with
 * `initialVideo` when the user taps a home-feed card whose video preview
 * is rolling (user: "when I click on the preview it should open the
 * article with the video playing, not the normal image with the play
 * button"). Tapping Watch / the preview plays the video INSIDE the news
 * image itself — the image box becomes the player and the close square
 * restores the photo.
 *
 * LOADING FEEDBACK (user: "in the news article when i click play button
 * it doesn't show a loading animation"): a USER-INITIATED open (the
 * Watch square) shows a centered spinner from the tap until the video
 * is genuinely PLAYING — through resolution and first-play buffering —
 * over a lightly dimmed photo; mid-play buffering shows a small spinner
 * over the video. The PREVIEW-HANDOFF path (initialVideo) stays
 * spinner-free and transparent: that transition is meant to be
 * seamless, with the photo showing through until playback starts.
 *
 * NO CHROME AT LOAD (user spec: "when the video is showing it looks
 * cluttered because for first 2 seconds I see the video progress bar,
 * the pause/play button, the YouTube settings button and the info popup
 * about the news channel … fix so it just shows the video when loaded").
 * The YouTube embed is created with controls=0 — no progress bar, no
 * pause/play button, no settings gear, no channel info popup, ever.
 * OUR OWN minimal control layer (VideoChrome below) stays completely
 * hidden while the video plays and only appears on tap (auto-hiding
 * 3s later; it stays up while paused): play/pause, a thin seek slider,
 * mute and fullscreen. The byline chip (who the coverage is from) also
 * waits ~2.2s before fading in, so the first moments are JUST video.
 *
 * PREVIEW HANDOFF (user spec: a less glitchy preview→article
 * transition): `initialVideo` may carry `startAt` — the position the
 * home-feed preview had reached when the card was tapped. The article
 * player seeks there before playing, so the video CONTINUES instead of
 * visibly restarting from zero; the card's own player is paused at arm
 * time (see video-preview-store) so the two never double up.
 *
 * Fetches /api/video/[topicId]?hl=…&gl=… (the user's locale — UK users
 * get English coverage), which resolves:
 *   1. the source's OWN video (RSS video enclosures / YouTube feeds), or
 *   2. a YouTube video about the story from a news outlet.
 * Both paths enforce the quality requirements: the video's channel must
 * have >= 10k subscribers and the video must run longer than 10 seconds
 * (concise, < 7 min, coverage preferred — see video-quality.ts). The
 * resolver ranks LANDSCAPE candidates ahead of portrait ones; a portrait
 * short-form video still plays (user: big cards — and articles — show
 * short-form videos too), letterboxed inside the 16:9 image box
 * (object-contain).
 *
 * AUTO-RETRY: a failed fetch (network error, or the API's "no video" /
 * "not-found" outcomes) is re-run automatically up to 2 times — a
 * resolution that hiccuped once often succeeds on a second pass. Retries
 * carry ?retry=N so the server skips its cached miss and re-resolves; the
 * "disabled" outcome (feature flag off) is never retried.
 *
 * Rendering:
 *   - kind 'youtube' → IFrame-API player (youtube-nocookie, autoplay,
 *     controls=0 + our VideoChrome; fades in on PLAYING)
 *   - kind 'video'   → native <video> (no native controls — the same
 *     VideoChrome drives it)
 *   - fetching       → transparent overlay (photo visible), close square
 *   - miss           → compact "no video yet" panel with a close square
 */

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Play,
  Pause,
  Volume1,
  VolumeX,
  Maximize,
  Minimize,
  ExternalLink,
  AlertCircle,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { loadYouTubeIframeApi, type YTPlayer } from '@/lib/youtube-player'
import { videoLocaleParams, type ResolvedVideo } from '@/lib/video-preview-store'

export interface VideoPlayerProps {
  topicId: string
  storyTitle: string
  onClose: () => void
  /** The article was opened from a playing home-feed preview: play THIS
   *  video immediately (no fetch, no loading state). `startAt` continues
   *  from where the preview had reached. */
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
  startAt?: number
  reason?: string
}

/** Max automatic re-runs after a failed fetch (user: "if a video fails to
 *  fetch, try to rerun the function automatically because it might work"). */
const MAX_AUTO_RETRIES = 2
const RETRY_DELAY_MS = 700

/** Chrome auto-hides this long after a tap while playing (a tap that
 *  PAUSES keeps it up — the user is mid-decision). User spec: at load,
 *  JUST the video — no clutter; the bar ONLY ever comes up from a tap
 *  (user: "please fix so it doesent come... so it only comes if a user
 *  taps on the video"). */
const CHROME_AUTOHIDE_MS = 3000

/** Our persistent corner UI (the byline chip) waits this long (seconds)
 *  after playback starts before fading in — the load moment is clean. */
const BYLINE_DELAY_S = 2.2

// ── shared helpers ──

/** "1:23" / "12:05" — compact player time format. */
function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

/** Safari's prefixed element-fullscreen surface (older macOS / iPad). */
interface WebkitFullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void
}
interface WebkitFullscreenDocument extends Document {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}

/** The current fullscreen element, unprefixed or -webkit- (Safari). */
function currentFullscreenElement(): Element | null {
  const doc = document as WebkitFullscreenDocument
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null
}

/** Whether ELEMENT (box) fullscreen is supported at all. */
function boxFullscreenSupported(): boolean {
  if (typeof document === 'undefined') return false
  const root = document.documentElement as WebkitFullscreenElement
  return typeof root.requestFullscreen === 'function' || typeof root.webkitRequestFullscreen === 'function'
}

/** iOS Safari only fullscreens <video> elements (webkitEnterFullscreen);
 *  everywhere else the whole image box goes fullscreen (the video keeps
 *  letterboxing inside it). */
function tryIosVideoFullscreen(video: HTMLVideoElement | null): void {
  try {
    const el = video as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null
    el?.webkitEnterFullscreen?.()
  } catch {
    // unsupported — no fullscreen, the video still plays inline
  }
}

/** Toggle fullscreen for the video box (falls back to iOS video
 *  fullscreen when element-fullscreen isn't supported). */
function toggleBoxFullscreen(
  box: HTMLElement | null,
  video: HTMLVideoElement | null,
): void {
  try {
    if (currentFullscreenElement()) {
      const doc = document as WebkitFullscreenDocument
      if (doc.exitFullscreen) {
        void doc.exitFullscreen()
      } else if (doc.webkitExitFullscreen) {
        void doc.webkitExitFullscreen()
      }
      return
    }
    const el = box as WebkitFullscreenElement | null
    if (el?.requestFullscreen) {
      el.requestFullscreen().catch(() => tryIosVideoFullscreen(video))
      return
    }
    if (el?.webkitRequestFullscreen) {
      try {
        const r = el.webkitRequestFullscreen()
        if (r && typeof (r as Promise<void>).catch === 'function') {
          ;(r as Promise<void>).catch(() => tryIosVideoFullscreen(video))
        }
      } catch {
        tryIosVideoFullscreen(video)
      }
      return
    }
  } catch {
    // fall through to the iOS path
  }
  tryIosVideoFullscreen(video)
}

// ── VideoChrome — our own control layer ──

/**
 * The ONLY controls the article video ever shows (user spec: no
 * YouTube bar / settings / channel-info clutter — "just shows the
 * video when loaded"). Completely hidden while it plays AND at load
 * (user: "when a video loads it shows the progress bar, the pause and
 * play button, the volume button overlays over the video by default
 * for like 2 seconds... so it only comes if a user taps on the video")
 * — the bar NEVER auto-reveals: not on mount, not when playback
 * starts, not when the video pauses. It appears ONLY from a user tap
 * on the video (which toggles play/pause AND raises the bar — auto-
 * hiding 3s later if the result is playing, staying up if paused) or
 * from desktop mouse movement. Every control (play/pause, seek, mute,
 * fullscreen) drives the player through the callbacks — the YouTube
 * iframe itself never sees a pointer, which is what keeps its own
 * chrome from ever appearing.
 */
function VideoChrome({
  playing,
  muted,
  time,
  duration,
  fullscreen,
  fullscreenAvailable,
  onTogglePlay,
  onSeek,
  onToggleMute,
  onToggleFullscreen,
}: {
  playing: boolean
  muted: boolean
  time: number
  duration: number
  fullscreen: boolean
  fullscreenAvailable: boolean
  onTogglePlay: () => void
  onSeek: (seconds: number) => void
  onToggleMute: () => void
  onToggleFullscreen: () => void
}) {
  const [visible, setVisible] = React.useState(false)
  const visibleRef = React.useRef(false)
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  // Local slider value while dragging (null = follow the player).
  const [drag, setDrag] = React.useState<number | null>(null)
  const dragRef = React.useRef(false)

  const clearHide = () => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }
  const show = (autoHide: boolean) => {
    visibleRef.current = true
    setVisible(true)
    clearHide()
    if (autoHide) {
      hideTimer.current = setTimeout(() => {
        visibleRef.current = false
        setVisible(false)
      }, CHROME_AUTOHIDE_MS)
    }
  }

  // NOTE: there is deliberately NO effect on `playing`. The bar must
  // never appear on its own — not when the player mounts (paused), not
  // when autoplay starts, not when playback pauses (the old
  // `!playing → show(false)` auto-reveal was exactly the ~2s of
  // load-time clutter the user rejected: mount → paused → bar visible
  // → playback starts → 3s auto-hide countdown, so the progress bar +
  // pause/play + volume buttons sat over a freshly loaded video).
  // Reveal paths are user actions ONLY: the tap below, the bar's own
  // buttons, and desktop mouse movement.

  React.useEffect(() => clearHide, [])

  const commitDrag = () => {
    if (dragRef.current && drag !== null) {
      onSeek(drag)
    }
    dragRef.current = false
    setDrag(null)
  }

  const sliderValue = drag !== null ? drag : Math.min(time, Math.max(duration, 0.1))

  return (
    <div
      className="absolute inset-0 z-[3]"
      onClick={() => {
        // A tap toggles play/pause AND raises the bar. The `playing`
        // prop is the PRE-toggle state, so `!playing` is what the video
        // will be doing after this tap: pausing → the bar STAYS up (the
        // user is mid-decision); resuming → it auto-hides 3s in.
        onTogglePlay()
        show(!playing)
      }}
      // Desktop mouse presence: raise the bar — auto-hiding while it
      // plays, staying up while paused (same rule as the tap, minus the
      // play-state flip).
      onMouseMove={() => show(playing)}
    >
      {/* Paused → a single centered play affordance (tapping anywhere
          also resumes). */}
      {!playing && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-black/60 backdrop-blur-[2px]">
            <Play className="h-7 w-7 text-white" fill="currentColor" />
          </div>
        </div>
      )}

      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pb-2.5 pt-12"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              aria-label={playing ? 'Pause' : 'Play'}
              onClick={(e) => {
                e.stopPropagation()
                // Same rule as the video-surface tap: post-toggle state
                // decides — pausing keeps the bar up, playing auto-hides.
                onTogglePlay()
                show(!playing)
              }}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15 active:bg-white/25"
            >
              {playing ? (
                <Pause className="h-5 w-5" fill="currentColor" />
              ) : (
                <Play className="h-5 w-5" fill="currentColor" />
              )}
            </button>

            <span className="w-8 shrink-0 text-right text-[10px] font-semibold tabular-nums text-white/85">
              {fmtTime(drag ?? time)}
            </span>

            {duration > 1 && (
              <input
                type="range"
                aria-label="Seek"
                min={0}
                max={duration}
                step={0.1}
                value={sliderValue}
                onPointerDown={() => {
                  dragRef.current = true
                }}
                onChange={(e) => setDrag(Number(e.target.value))}
                onPointerUp={commitDrag}
                onKeyUp={commitDrag}
                onBlur={commitDrag}
                className="h-1.5 min-w-0 flex-1 cursor-pointer accent-white"
              />
            )}

            <span className="w-8 shrink-0 text-[10px] font-semibold tabular-nums text-white/85">
              {fmtTime(duration)}
            </span>

            <button
              type="button"
              aria-label={muted ? 'Unmute' : 'Mute'}
              onClick={(e) => {
                e.stopPropagation()
                onToggleMute()
                // Mute doesn't change the play state: auto-hide while
                // playing, stay up while paused.
                show(playing)
              }}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15 active:bg-white/25"
            >
              {muted ? (
                <VolumeX className="h-5 w-5" />
              ) : (
                <Volume1 className="h-5 w-5" />
              )}
            </button>

            {fullscreenAvailable && (
              <button
                type="button"
                aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleFullscreen()
                  // Same as mute: play state unchanged.
                  show(playing)
                }}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15 active:bg-white/25"
              >
                {fullscreen ? (
                  <Minimize className="h-5 w-5" />
                ) : (
                  <Maximize className="h-5 w-5" />
                )}
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── shared fullscreen state hook ──

/** Tracks whether OUR box is the fullscreen element (icon swap) —
 *  listens to both the standard and Safari's -webkit- event. */
function useIsFullscreen(): boolean {
  const [fs, setFs] = React.useState(false)
  React.useEffect(() => {
    const onChange = () => setFs(!!currentFullscreenElement())
    document.addEventListener('fullscreenchange', onChange)
    document.addEventListener('webkitfullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      document.removeEventListener('webkitfullscreenchange', onChange)
    }
  }, [])
  return fs
}

/** ── YouTube embed via the IFrame API ──
 *
 * controls=0 — YouTube's own bar/settings/channel-info popup never
 * renders (user spec: "just shows the video when loaded"). Our
 * VideoChrome supplies tap-to-show controls instead. `startAt` seeks to
 * the preview's position before playing (handoff continuity). Falls
 * back to a bare controls=0 iframe if the API script can't load (rare)
 * — YouTube then handles taps itself. */
function ArticleYouTubePlayer({
  videoId,
  storyTitle,
  startAt,
  onPlaying,
  onDead,
  onBuffering,
}: {
  videoId: string
  storyTitle: string
  startAt?: number
  onPlaying: () => void
  /** The player rejected this video (embed-disallowed etc.) — the
   *  parent reports it to the resolver and swaps to the next candidate. */
  onDead: (videoId: string) => void
  /** Buffering started/ended (YT state 3 → 1/2) — drives the parent's
   *  loading spinner (user: "when i click play button it doesn't show
   *  a loading animation"). */
  onBuffering: (buffering: boolean) => void
}) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  // A STABLE wrapper the IFrame API never replaces (it swaps the inner
  // host div for its iframe — hostRef.current ends up DETACHED from the
  // DOM, so `hostRef.current.closest('[data-nw-video-box]')` returned
  // null and the fullscreen button did NOTHING. User: "the fullscreen
  // button doesn't work".)
  const wrapRef = React.useRef<HTMLDivElement | null>(null)
  const playerRef = React.useRef<YTPlayer | null>(null)
  const [fallbackIframe, setFallbackIframe] = React.useState(false)
  const reportedRef = React.useRef(false)
  // Chrome state (drives VideoChrome).
  const [playing, setPlaying] = React.useState(false)
  const [muted, setMuted] = React.useState(false)
  const [time, setTime] = React.useState(0)
  const [duration, setDuration] = React.useState(0)
  const fullscreen = useIsFullscreen()

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
            // User spec: no YouTube chrome — no progress bar, no
            // pause/play button, no settings gear, no channel info
            // popup. Our VideoChrome owns the controls.
            controls: 0,
            rel: 0,
            fs: 0,
            modestbranding: 1,
            playsinline: 1,
            iv_load_policy: 3,
            disablekb: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: (e) => {
              if (cancelled) return
              // Preview handoff: continue WHERE the preview left off
              // instead of visibly restarting from zero.
              if (typeof startAt === 'number' && startAt > 1) {
                try {
                  e.target.seekTo(startAt, true)
                } catch {
                  // fresh start is fine
                }
              }
              e.target.playVideo()
            },
            onStateChange: (e) => {
              if (cancelled) return
              if (e.data === 1 /* PLAYING */) {
                if (!reportedRef.current) {
                  reportedRef.current = true
                  onPlaying()
                }
                setPlaying(true)
                onBuffering(false)
              } else if (e.data === 2 /* PAUSED */) {
                setPlaying(false)
                onBuffering(false)
              } else if (e.data === 3 /* BUFFERING */) {
                // Data catching up mid-play — the parent's spinner.
                onBuffering(true)
              }
            },
            // The user just tapped — a gesture — so audible autoplay is
            // permitted; on the rare block, mute + retry so it still
            // plays (the chrome's speaker re-enables sound).
            onAutoplayBlocked: () => {
              try {
                playerRef.current?.mute()
                playerRef.current?.playVideo()
              } catch {
                // silent
              }
              setMuted(true)
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
     
  }, [videoId, startAt])

  // Position/duration polling for the seek bar (4Hz; state guards keep
  // this from re-rendering when nothing moved).
  React.useEffect(() => {
    const iv = setInterval(() => {
      const p = playerRef.current
      if (!p) return
      try {
        const t = p.getCurrentTime()
        const d = p.getDuration()
        setTime((prev) => (Math.abs(prev - t) > 0.15 ? t : prev))
        setDuration((prev) => (prev !== d && Number.isFinite(d) && d > 0 ? d : prev))
      } catch {
        // player mid-swap — skip this tick
      }
    }, 250)
    return () => clearInterval(iv)
  }, [videoId])

  if (fallbackIframe) {
    return (
      <iframe
        key={videoId}
        src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&controls=0&modestbranding=1&playsinline=1`}
        title={storyTitle}
        className="h-full w-full"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
      />
    )
  }

  const togglePlay = () => {
    try {
      if (playing) playerRef.current?.pauseVideo()
      else playerRef.current?.playVideo()
    } catch {
      // silent
    }
  }
  const seek = (s: number) => {
    try {
      playerRef.current?.seekTo(s, true)
      setTime(s)
    } catch {
      // silent
    }
  }
  const toggleMute = () => {
    try {
      if (muted) playerRef.current?.unMute()
      else playerRef.current?.mute()
      setMuted(!muted)
    } catch {
      // silent
    }
  }
  const toggleFullscreen = () => {
    // wrapRef is a STABLE DOM node (never replaced by the API), so the
    // lookup of the fullscreen-target box actually resolves — this was
    // the dead button (see wrapRef above).
    const box = wrapRef.current?.closest('[data-nw-video-box]') ?? null
    toggleBoxFullscreen(box as HTMLElement | null, null)
  }
  const fullscreenAvailable = boxFullscreenSupported()

  return (
    <div className="absolute inset-0" ref={wrapRef}>
      {/* The API REPLACES the inner host div with its iframe — sizing
          classes live on this stable outer wrapper. */}
      <div className="absolute inset-0 [&_iframe]:h-full [&_iframe]:w-full">
        <div ref={hostRef} />
      </div>
      <VideoChrome
        playing={playing}
        muted={muted}
        time={time}
        duration={duration}
        fullscreen={fullscreen}
        fullscreenAvailable={fullscreenAvailable}
        onTogglePlay={togglePlay}
        onSeek={seek}
        onToggleMute={toggleMute}
        onToggleFullscreen={toggleFullscreen}
      />
    </div>
  )
}

/** ── Native <video> player (RSS source videos) ──
 *
 * No native `controls` attribute (user spec — the OS control bar is
 * exactly the load-time clutter they rejected); our VideoChrome drives
 * the element instead. object-contain letterboxes a portrait short
 * inside the 16:9 image box instead of cropping it. */
function ArticleNativeVideo({
  url,
  startAt,
  onPlaying,
  onError,
  onBuffering,
}: {
  url: string
  startAt?: number
  onPlaying: () => void
  onError: () => void
  /** Buffering started/ended (waiting/playing) — the parent's spinner. */
  onBuffering: (buffering: boolean) => void
}) {
  const ref = React.useRef<HTMLVideoElement | null>(null)
  const [playing, setPlaying] = React.useState(false)
  const [muted, setMuted] = React.useState(false)
  const [time, setTime] = React.useState(0)
  const [duration, setDuration] = React.useState(0)
  const fullscreen = useIsFullscreen()
  // Element-fullscreen support (iOS only offers video fullscreen).
  const [fullscreenAvailable, setFullscreenAvailable] = React.useState(true)

  React.useEffect(() => {
    const el = ref.current
    const hasEl = !!el && 'webkitEnterFullscreen' in el
    setFullscreenAvailable(boxFullscreenSupported() || hasEl)
  }, [url])

  // Autoplay fallback: autoPlay tries audible playback (allowed — the
  // tap that opened this player is a user gesture). If the browser
  // still blocks it, retry muted after a beat so SOMETHING plays (the
  // chrome's speaker re-enables sound).
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const probe = setTimeout(() => {
      if (el.paused && el.currentTime === 0) {
        el.muted = true
        el.play().catch(() => {
          // paused with the chrome up — the user can start it manually
        })
      }
    }, 1200)
    return () => clearTimeout(probe)
  }, [url])

  const togglePlay = () => {
    const el = ref.current
    if (!el) return
    if (el.paused) el.play().catch(() => {})
    else el.pause()
  }
  const seek = (s: number) => {
    const el = ref.current
    if (!el) return
    try {
      el.currentTime = s
      setTime(s)
    } catch {
      // seeking unsupported — silent
    }
  }
  const toggleMute = () => {
    const el = ref.current
    if (!el) return
    el.muted = !el.muted
    setMuted(el.muted)
  }
  const toggleFullscreen = () => {
    const box = ref.current?.closest('[data-nw-video-box]') ?? null
    toggleBoxFullscreen(box as HTMLElement | null, ref.current)
  }

  return (
    <div className="absolute inset-0">
      <video
        ref={ref}
        key={url}
        src={url}
        data-nw-video=""
        // object-contain: a portrait short letterboxes instead of being
        // center-cropped (user: short-form videos play in big cards /
        // articles too).
        className="absolute inset-0 h-full w-full object-contain"
        autoPlay
        playsInline
        onLoadedMetadata={(e) => {
          const el = e.currentTarget
          // Preview handoff: continue where the preview left off (only
          // when the position actually fits the video).
          if (
            typeof startAt === 'number' &&
            startAt > 1 &&
            Number.isFinite(el.duration) &&
            startAt < el.duration - 2
          ) {
            try {
              el.currentTime = startAt
            } catch {
              // seeking unsupported — fresh start
            }
          }
          if (Number.isFinite(el.duration)) setDuration(el.duration)
        }}
        onTimeUpdate={(e) => {
          const el = e.currentTarget
          setTime(el.currentTime)
          if (Number.isFinite(el.duration) && el.duration > 0) {
            setDuration((prev) => (prev === el.duration ? prev : el.duration))
          }
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onWaiting={() => onBuffering(true)}
        onPlaying={() => {
          onBuffering(false)
          onPlaying()
        }}
        onCanPlay={() => onBuffering(false)}
        onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
        onError={onError}
      />
      <VideoChrome
        playing={playing}
        muted={muted}
        time={time}
        duration={duration}
        fullscreen={fullscreen}
        fullscreenAvailable={fullscreenAvailable}
        onTogglePlay={togglePlay}
        onSeek={seek}
        onToggleMute={toggleMute}
        onToggleFullscreen={toggleFullscreen}
      />
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
  // The player is fetching more data mid-play — small centered spinner.
  const [buffering, setBuffering] = React.useState(false)
  // Native <video> playback failed (hotlink protection etc.)
  const [videoError, setVideoError] = React.useState(false)
  // >0 while an automatic retry is in flight.
  const [retrying, setRetrying] = React.useState(0)
  // Videos the player rejected (embed-disallowed) — the fetch re-runs
  // with them excluded so the resolver returns the NEXT candidate.
  const [deadIds, setDeadIds] = React.useState<string[]>([])
  // Opened by the user tapping the Watch square (NOT a preview handoff):
  // they expect feedback — a loading spinner runs from the tap until
  // the video is genuinely playing (user: "in the news article when i
  // click play button it doesn't show a loading animation"). The
  // handoff path stays seamless (no spinner) by design.
  const userInitiated = !initialVideo

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

  const ready = !loading && !!video?.ok

  // The byline link — the video's source (escape hatch to YouTube / the
  // source's own player, where fullscreen always works).
  const bylineHref =
    video?.kind === 'youtube'
      ? video.sourceUrl ||
        (video.videoId ? `https://www.youtube.com/watch?v=${video.videoId}` : undefined)
      : video?.url || undefined

  return (
    // Transparent until the player is actually PLAYING (user spec: the
    // news photo keeps showing — never a black loading box). Once
    // playing, the black backing + video fade in. data-nw-video-box is
    // the fullscreen target for our chrome.
    <div
      data-nw-video-box=""
      className={cn(
        'absolute inset-0 z-[3] transition-colors duration-200',
        playing ? 'bg-black' : 'bg-transparent',
      )}
    >
      {/* ── Player area — fills the news image box. Our VideoChrome
              supplies the controls (no YouTube chrome ever renders).
              Hidden (opacity 0 + pointer-events off) until PLAYING. */}
      {ready && video?.kind === 'youtube' && video.videoId ? (
        <div
          className="absolute inset-0 transition-opacity duration-200"
          style={{ opacity: playing ? 1 : 0, pointerEvents: playing ? 'auto' : 'none' }}
        >
          <ArticleYouTubePlayer
            videoId={video.videoId}
            storyTitle={video.title || storyTitle}
            startAt={video.startAt}
            onPlaying={() => setPlaying(true)}
            onDead={handleDeadVideo}
            onBuffering={setBuffering}
          />
        </div>
      ) : ready && video?.kind === 'video' && video.url ? (
        <div
          className="absolute inset-0 transition-opacity duration-200"
          style={{ opacity: playing ? 1 : 0, pointerEvents: playing ? 'auto' : 'none' }}
        >
          <ArticleNativeVideo
            url={video.url}
            startAt={video.startAt}
            onPlaying={() => setPlaying(true)}
            onError={() => setVideoError(true)}
            onBuffering={setBuffering}
          />
        </div>
      ) : !ready ? (
        // Resolving (or auto-retrying) — transparent so the photo shows
        // through, with a centered spinner for USER-INITIATED opens (the
        // tap deserves feedback; the preview handoff stays seamless).
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

      {/* ── Loading spinner (user: "in the news article when i click
              play button it doesn't show a loading animation") ──
          Runs from the Watch tap until the video is genuinely PLAYING —
          through resolution AND first-play buffering. The preview
          handoff path (initialVideo) stays spinner-free: that transition
          is meant to be seamless. A dead-video swap re-enters the fetch
          phase and shows it again. */}
      {!playing && !videoError && !(!loading && !!video && !video.ok) && (loading || userInitiated) && (
        <div className="pointer-events-none absolute inset-0 z-[2] flex items-center justify-center bg-black/25">
          <div
            className="h-10 w-10 animate-spin rounded-full border-[3px] border-white/30 border-t-white"
            role="status"
            aria-label="Loading video"
          />
        </div>
      )}
      {/* Mid-play buffering — small spinner over the (visible) video. */}
      {buffering && playing && (
        <div className="pointer-events-none absolute inset-0 z-[2] flex items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-white/30 border-t-white" />
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

      {/* Playing: tiny byline chip (bottom-right) — who the coverage is
          from. FADES IN ~2s AFTER playback starts (user spec: "just
          shows the video when loaded, not all the buttons and overlay
          features for 2 seconds") and doubles as the link out to the
          source (YouTube's own player has fullscreen everywhere). */}
      {playing && video?.ok && bylineHref && (
        <motion.a
          href={bylineHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: BYLINE_DELAY_S, duration: 0.4 }}
          className="absolute bottom-0 right-0 z-[2] flex items-center gap-1.5 bg-black/70 py-1 pl-2 pr-2 backdrop-blur-[2px]"
          title={`Coverage from ${video.author || 'a news outlet'} — opens at the source`}
        >
          <Play className="h-3 w-3 shrink-0 text-white/70" />
          <span className="max-w-[45vw] truncate text-[10px] font-semibold uppercase leading-none tracking-wide text-white/80">
            {video.author || 'news video'}
          </span>
        </motion.a>
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
