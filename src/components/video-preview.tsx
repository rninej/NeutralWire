'use client'

/**
 * video-preview.tsx — the experimental big-card video preview.
 *
 * Enabled from /debug (featureFlags/videoPreview) and passed to EVERY
 * card with a large image (the hero cards + the desktop magazine grid —
 * user: "for every news which has the large news card, load them too
 * when I scroll down"). Behaviour (user spec, refined):
 *
 *   1. The card's image renders normally — and stays normal. NOTHING
 *      is shown while the video resolves or buffers: no "Finding
 *      video…" chip, no black box, no spinner (user: "make it not show
 *      that it is loading video, and only show video once it has fully
 *      loaded in the background — do not show the black screen with
 *      loading animation"). The player mounts INVISIBLE (opacity 0,
 *      over the photo) and only fades in once it is genuinely PLAYING.
 *   2. Once the image has been CONTINUOUSLY on screen for 0.8s
 *      (IntersectionObserver ≥ 50% + a dwell timer — a card the user
 *      is actively scrolling past never triggers it), we fetch the
 *      story's video (/api/video with the user's hl=/gl= locale so the
 *      video is in the user's language — UK → English). A two-slot
 *      semaphore keeps a fast scroll from firing a dozen resolutions.
 *   3. LANDSCAPE PREFERRED, SHORTS ALLOWED (user spec): the RESOLVER
 *      ranks landscape candidates strictly ahead of portrait ones (a
 *      story with any landscape coverage resolves a landscape video —
 *      "try harder to fetch videos which are in landscape mode"), but
 *      a portrait short-form video is no longer a rejection: when a
 *      Short is what the story has, the big card shows it too (user:
 *      "make it so the big cards show short form videos too"),
 *      letterboxed inside the image box. No client-side aspect gate
 *      remains.
 *   4. When the video starts, it plays INSIDE the image with SOUND AT
 *      HALF VOLUME (setVolume 50 / video.volume 0.5). If the browser's
 *      autoplay policy blocks audible autoplay it silently falls back
 *      to muted (the chip switches to the crossed speaker). Only ONE
 *      preview is audible at a time (audio lease, see the store).
 *   5. Tapping the card opens the article WITH THE VIDEO ALREADY
 *      PLAYING (not the photo + Watch square): while the preview holds
 *      a resolved video, the card's click arms the video handoff
 *      (carrying the preview's current position — the article
 *      continues instead of restarting) and TopicDetail starts playing
 *      it immediately. The card's own player is paused at arm time so
 *      the two never play on top of each other, and every live preview
 *      pauses/resumes as the article opens/closes.
 *   6. Scrolling the card off screen UNLOADS the player (no bandwidth
 *      burn); scrolling back re-plays it without re-fetching. A
 *      "no video" outcome is remembered for the tab session.
 *
 * The whole feature rides behind the videoWatch flag too — /api/video
 * refuses while the master video feature is off.
 */

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Volume1, VolumeX } from 'lucide-react'
import { loadYouTubeIframeApi, type YTPlayer } from '@/lib/youtube-player'
import {
  acquirePreviewSlot,
  claimPreviewAudio,
  markPreviewPlaying,
  releasePreviewAudio,
  registerPreviewControls,
  videoLocaleParams,
  waitForPreviewAudio,
  type ResolvedVideo,
} from '@/lib/video-preview-store'

/** User spec: the image must be viewed for 0.8s before the preview arms. */
const DWELL_MS = 800

/** User spec: preview sound at half of normal volume. */
const PREVIEW_VOLUME = 50 // percent (YouTube) — 0.5 for <video>

/** sessionStorage key prefix — remembers a known miss for this tab. */
const MISS_KEY = 'nw:vpreview-miss:'

function hadMiss(topicId: string): boolean {
  try {
    return sessionStorage.getItem(MISS_KEY + topicId) === '1'
  } catch {
    return false
  }
}

function markMiss(topicId: string) {
  try {
    sessionStorage.setItem(MISS_KEY + topicId, '1')
  } catch {
    // private mode etc. — just refetch next time
  }
}

const EASE_OUT = [0.16, 1, 0.3, 1] as const

/** ── YouTube player (via the official IFrame API) ──
 *
 * Mounts hidden; the parent fades the whole overlay in only when this
 * reports PLAYING. Half-volume, unmuted, with an autoplay-block
 * fallback to muted (then the audio-lease waiters never see us). */
function YouTubePreviewPlayer({
  topicId,
  videoId,
  onPlaying,
  onMutedChange,
  onDead,
}: {
  topicId: string
  videoId: string
  onPlaying: (muted: boolean) => void
  onMutedChange: (muted: boolean) => void
  /** The video can't play (embed-disallowed etc.) — videoId lets the
   *  parent report it to the resolver and swap to the next candidate. */
  onDead: (videoId: string | null) => void
}) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const playerRef = React.useRef<YTPlayer | null>(null)
  // Whether the browser blocked audible autoplay → muted fallback.
  const blockedRef = React.useRef(false)
  // Whether the lease granted us sound.
  const audibleRef = React.useRef(false)

  React.useEffect(() => {
    let cancelled = false
    let reported = false

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
            mute: 0,
            controls: 0,
            loop: 1,
            playlist: videoId,
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            fs: 0,
            iv_load_policy: 3,
            disablekb: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: (e) => {
              if (cancelled) return
              // Audible preview requires the single-sound lease; without
              // it we start muted so two cards never talk over each other.
              audibleRef.current = claimPreviewAudio(topicId)
              if (audibleRef.current) {
                e.target.setVolume(PREVIEW_VOLUME)
              } else {
                e.target.mute()
                onMutedChange(true)
                // Queue for the lease — granted when the audible card
                // scrolls away.
                waitForPreviewAudio(topicId, () => {
                  if (cancelled || blockedRef.current) return
                  audibleRef.current = true
                  try {
                    playerRef.current?.unMute()
                    playerRef.current?.setVolume(PREVIEW_VOLUME)
                    onMutedChange(false)
                  } catch {
                    // player died — silent
                  }
                })
              }
              e.target.playVideo()
            },
            onStateChange: (e) => {
              if (cancelled) return
              if (e.data === 1 /* PLAYING */) {
                if (!reported) {
                  reported = true
                  onPlaying(!audibleRef.current || blockedRef.current)
                }
              }
            },
            onAutoplayBlocked: () => {
              // Browser refused audible autoplay — retry muted so the
              // preview still plays (and free the sound lease).
              if (cancelled) return
              blockedRef.current = true
              releasePreviewAudio(topicId)
              audibleRef.current = false
              onMutedChange(true)
              try {
                playerRef.current?.mute()
                playerRef.current?.playVideo()
              } catch {
                // silent
              }
            },
            onError: () => {
              // 101/150 = the owner disallows embedding — the parent
              // reports the dead video and swaps to the next candidate.
              if (!cancelled) onDead(videoId)
            },
          },
        })
        playerRef.current = player
      })
      .catch(() => {
        // IFrame API unavailable — no preview (never a black box).
        if (!cancelled) onDead(null)
      })

    // Article-open silencing + the handoff's startAt: expose
    // pause/resume/getTime to the store while this player is alive.
    const unregister = registerPreviewControls(topicId, {
      pause: () => {
        try {
          playerRef.current?.pauseVideo()
        } catch {
          // silent
        }
      },
      resume: () => {
        try {
          playerRef.current?.playVideo()
        } catch {
          // silent
        }
      },
      getTime: () => {
        try {
          return playerRef.current?.getCurrentTime() ?? 0
        } catch {
          return 0
        }
      },
    })

    // Autoplay-blocked isn't reported by every browser; if we never
    // reach PLAYING shortly after ready, fall back to muted playback.
    const blockProbe = setTimeout(() => {
      if (cancelled || reported || blockedRef.current) return
      blockedRef.current = true
      releasePreviewAudio(topicId)
      audibleRef.current = false
      onMutedChange(true)
      try {
        playerRef.current?.mute()
        playerRef.current?.playVideo()
      } catch {
        // silent
      }
    }, 3500)

    return () => {
      cancelled = true
      clearTimeout(blockProbe)
      unregister()
      releasePreviewAudio(topicId)
      try {
        playerRef.current?.destroy()
      } catch {
        // silent
      }
      playerRef.current = null
    }
     
  }, [videoId, topicId])

  return (
    // The API REPLACES the inner host div with its iframe — so the
    // sizing classes live on this stable outer wrapper.
    <div className="absolute inset-0 [&_iframe]:h-full [&_iframe]:w-full">
      <div ref={hostRef} />
    </div>
  )
}

/** ── Native <video> player (RSS source videos) ──
 *
 * Waits until the browser can play through (buffered enough), then
 * plays at half volume — hidden until the parent fades it in on the
 * `playing` event. Portrait (short-form) videos are fine: the element
 * letterboxes inside the image box (object-contain) instead of being
 * cropped or rejected. */
function NativePreviewPlayer({
  topicId,
  url,
  onPlaying,
  onMutedChange,
  onDead,
}: {
  topicId: string
  url: string
  onPlaying: (muted: boolean) => void
  onMutedChange: (muted: boolean) => void
  onDead: () => void
}) {
  const ref = React.useRef<HTMLVideoElement | null>(null)
  const audibleRef = React.useRef(false)
  const startedRef = React.useRef(false)

  const startPlayback = () => {
    const el = ref.current
    if (!el || startedRef.current) return
    startedRef.current = true
    audibleRef.current = claimPreviewAudio(topicId)
    const attempt = (muted: boolean) => {
      el.muted = muted
      if (!muted) el.volume = PREVIEW_VOLUME / 100
      el.play().catch(() => {
        if (muted) {
          onDead() // even muted failed — hotlink protection etc.
          return
        }
        // Autoplay policy — retry muted, free the sound lease.
        releasePreviewAudio(topicId)
        audibleRef.current = false
        onMutedChange(true)
        attempt(true)
      })
    }
    attempt(!audibleRef.current)
  }

  // Article-open silencing + the handoff's startAt.
  const controlsRef = React.useRef<HTMLVideoElement | null>(null)
  React.useEffect(() => {
    const el = controlsRef.current
    if (!el) return
    return registerPreviewControls(topicId, {
      pause: () => el.pause(),
      resume: () => {
        el.play().catch(() => {
          // un-muted resume can be blocked — try muted so the card at
          // least keeps moving
          el.muted = true
          el.play().catch(() => {
            // dead — the card's own error path takes over
          })
        })
      },
      getTime: () => el.currentTime || 0,
    })
  }, [topicId])

  return (
    <video
      ref={(el) => {
        ref.current = el
        controlsRef.current = el
      }}
      src={url}
      // Preload in the background — invisible until it can truly play.
      preload="auto"
      playsInline
      loop
      // object-contain: a portrait short letterboxes inside the image
      // box instead of being center-cropped (user: big cards show
      // short-form videos too).
      className="absolute inset-0 h-full w-full object-contain"
      onLoadedMetadata={() => {
        // "Fully loaded" proxy: enough buffer to play through without
        // stalling → start (still invisible until `playing` fires).
        ref.current?.addEventListener('canplaythrough', startPlayback, { once: true })
        // Some servers never let canplaythrough fire (no length hint) —
        // canplay is the pragmatic floor.
        ref.current?.addEventListener('canplay', startPlayback, { once: true })
      }}
      onPlaying={() => onPlaying(!audibleRef.current)}
      onError={onDead}
      onEnded={() => {
        startedRef.current = false
      }}
    />
  )
}

/** The overlay: hidden while resolving/buffering, faded in when playing. */
export function HeroVideoPreview({ topicId }: { topicId: string }) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  // ≥50% on screen (updated by the IntersectionObserver).
  const [visible, setVisible] = React.useState(false)
  // Resolved video (null until found; landscape-gated for YouTube).
  const [video, setVideo] = React.useState<ResolvedVideo | null>(null)
  // The player is genuinely PLAYING → fade the overlay in.
  const [playing, setPlaying] = React.useState(false)
  // Muted state (lease lost or autoplay blocked) — chip icon only.
  const [muted, setMuted] = React.useState(false)
  // One attempt per topic per session — never refetch after the first try.
  const triedRef = React.useRef(false)
  // Dead-video swaps (embed-disallowed candidates) — the client
  // accumulates the rejected ids, the resolver excludes them, and up to
  // three swaps hunt for an embeddable candidate (finance stories often
  // have 2-3 blocked videos from Bloomberg/Reuters/CGTN before an
  // embeddable one ranks). After that the card is a miss for the
  // session; the server-side dead list persists for everyone else.
  const deadIdsRef = React.useRef<string[]>([])
  // ── Visibility tracking ──
  React.useEffect(() => {
    const el = containerRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setVisible(entry.intersectionRatio >= 0.5)
        }
      },
      { threshold: [0, 0.5, 1] },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // ── The player rejected the video (embed-disallowed, etc.) — report
  //    every rejected id and swap to the next candidate (up to three
  //    times); exhausted or a miss response → mark the card a miss. ──
  const handleDead = (deadVideoId: string | null) => {
    setPlaying(false)
    if (!deadVideoId || deadIdsRef.current.includes(deadVideoId) || deadIdsRef.current.length >= 3) {
      setVideo(null)
      markMiss(topicId)
      return
    }
    deadIdsRef.current = [...deadIdsRef.current, deadVideoId]
    ;(async () => {
      try {
        const locale = videoLocaleParams()
        const dead = deadIdsRef.current.map((id) => encodeURIComponent(id)).join(',')
        const res = await fetch(
          `/api/video/${encodeURIComponent(topicId)}?${locale}&dead=${dead}`,
          { cache: 'no-store' },
        )
        const data = (await res.json()) as ResolvedVideo & { aspect?: number }
        // Any aspect is accepted — portrait shorts preview too now
        // (the resolver ranks landscape ahead, but a Short beats no
        // preview at all).
        if (
          data?.ok &&
          data.kind === 'youtube' &&
          data.videoId &&
          !deadIdsRef.current.includes(data.videoId)
        ) {
          markPreviewPlaying(topicId, data)
          setVideo(data)
        } else {
          setVideo(null)
          markMiss(topicId)
        }
      } catch {
        setVideo(null)
        markMiss(topicId)
      }
    })()
  }

  // ── Reset the fade-in when the card leaves the screen — scrolling
  // back remounts a fresh player that must buffer again before it can
  // fade in (otherwise the overlay would flash black over the photo). ──
  React.useEffect(() => {
    if (!visible) {
      setPlaying(false)
      setMuted(false)
    }
  }, [visible])

  // ── 0.8s dwell → resolve the video (once, throttled, locale-aware) ──
  // The timer RESETS every time the card dips below 50% visibility, so a
  // card the user is actively scrolling past never arms.
  React.useEffect(() => {
    if (!visible || triedRef.current || hadMiss(topicId)) return
    const timer = setTimeout(() => {
      triedRef.current = true
      ;(async () => {
        const release = await acquirePreviewSlot()
        try {
          const locale = videoLocaleParams()
          const res = await fetch(
            `/api/video/${encodeURIComponent(topicId)}?${locale}`,
            { cache: 'no-store' },
          )
          const data = (await res.json()) as ResolvedVideo & { ok: boolean; reason?: string; aspect?: number }
          if (data?.ok && data.kind) {
            // Any aspect previews now — the RESOLVER already ranks
            // landscape candidates ahead of portrait ones ("try harder
            // to fetch videos which are in landscape mode"), and a
            // short-form video is a valid big-card preview (user spec).
            const resolved: ResolvedVideo = data
            // Tapping this card while the video is previewing opens the
            // article with the video already rolling.
            markPreviewPlaying(topicId, resolved)
            setVideo(resolved)
          } else {
            markMiss(topicId)
          }
        } catch {
          markMiss(topicId)
        } finally {
          release()
        }
      })()
    }, DWELL_MS)
    return () => clearTimeout(timer)
  }, [visible, topicId])

  // ── Unmount: release any audio lease (the resolved-video handoff
  // marker intentionally survives — a tap right after the preview faded
  // still opens the article with the video rolling). ──
  React.useEffect(() => {
    return () => {
      releasePreviewAudio(topicId)
    }
  }, [topicId])

  const active = Boolean(video && visible)

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 z-[1]">
      {/* The player mounts over the photo INVISIBLE and only fades in
          when it is genuinely playing — the image is never replaced by
          a black loading box. */}
      <AnimatePresence>
        {active && (
          <motion.div
            key="preview-player"
            className="absolute inset-0 overflow-hidden bg-black"
            initial={{ opacity: 0 }}
            animate={{ opacity: playing ? 1 : 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease: EASE_OUT }}
          >
            {video?.kind === 'youtube' && video.videoId ? (
              <YouTubePreviewPlayer
                topicId={topicId}
                videoId={video.videoId}
                onPlaying={(isMuted) => {
                  setMuted(isMuted)
                  setPlaying(true)
                }}
                onMutedChange={setMuted}
                onDead={handleDead}
              />
            ) : video?.kind === 'video' && video.url ? (
              <NativePreviewPlayer
                topicId={topicId}
                url={video.url}
                onPlaying={(isMuted) => {
                  setMuted(isMuted)
                  setPlaying(true)
                }}
                onMutedChange={setMuted}
                onDead={() => {
                  setPlaying(false)
                  setVideo(null)
                }}
              />
            ) : null}

            {/* Preview chip (bottom-left) — sound state at a glance.
                Only rendered once the video is actually visible. */}
            {playing && (
              <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/70 py-[3px] pl-1.5 pr-2 backdrop-blur-[2px]">
                {muted ? (
                  <VolumeX className="h-3 w-3 text-white/80" />
                ) : (
                  <Volume1 className="h-3 w-3 text-white/80" />
                )}
                <span className="text-[8px] font-extrabold uppercase leading-none tracking-[0.14em] text-white/90">
                  Preview
                </span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
