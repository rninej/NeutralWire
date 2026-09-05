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
 *   2. The video resolves the MOMENT the image is sufficiently on
 *      screen (IntersectionObserver ≥ 50% — the 0.8s dwell was
 *      removed, user: "show it as fast as possible"; a card the user
 *      is actively scrolling past never triggers it). We fetch the
 *      story's video (/api/video with the user's hl=/gl= locale so the
 *      video is in the user's language — UK → English). A two-slot
 *      semaphore keeps a fast scroll from firing a dozen resolutions.
 *      While an article sheet is open, no preview player mounts (a
 *      video must never roll behind the sheet) — see the store.
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
 *      to muted. Only ONE preview is audible at a time (audio lease,
 *      see the store). While the preview is PLAYING, a small SOUND
 *      button replaces the corner chip (user: "only in the preview
 *      video make it show a sound button which i can press to turn on
 *      sound" — the press is the user gesture the autoplay policy
 *      requires, so un-muting from it reliably works).
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
 *   7. A small "WATCH" chip sits in the image's bottom-left corner
 *      whenever the preview isn't rolling (user: "ONLY for the large
 *      news cards show the play button in the bottom left corner, so
 *      people know you can watch too") — the SOUND button takes over
 *      the corner while the video plays. Known misses drop it.
 *
 * The whole feature rides behind the videoWatch flag too — /api/video
 * refuses while the master video feature is off.
 */

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Play, Volume1, VolumeX } from 'lucide-react'
import { loadYouTubeIframeApi, type YTPlayer } from '@/lib/youtube-player'
import {
  acquirePreviewSlot,
  armLateIfRequested,
  claimPreviewAudio,
  hasUserGestured,
  isArticleSheetOpen,
  markPreviewFetchPending,
  markPreviewFetchSettled,
  markPreviewPlaying,
  onArticleOpenChange,
  onUserGesture,
  releasePreviewAudio,
  registerPreviewControls,
  setPreviewAudible,
  videoLocaleParams,
  waitForPreviewAudio,
  type ResolvedVideo,
} from '@/lib/video-preview-store'

/** User spec: "remove the 0.8 second wait from the preview and show it
 *  as fast as possible" — the video resolves the moment the card is
 *  sufficiently on screen (no dwell timer). The ≥50% visibility gate
 *  itself stays: an off-screen card still never arms. */
const DWELL_MS = 0

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
 * fallback to muted — and the muted state is RECOVERABLE: the first
 * user interaction with the page un-mutes it (the fallback used to be
 * permanent, which read as "sound is muted on home and only activates
 * in article" — see the store's gesture tracking). */
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

    // ── Audible recovery (un-mute paths, all gesture-gated) ──
    // Browsers pause a video you un-mute outside a user gesture, so
    // every un-mute first ensures the user has interacted.
    const unMuteNow = () => {
      if (cancelled) return
      blockedRef.current = false
      audibleRef.current = true
      try {
        playerRef.current?.unMute()
        playerRef.current?.setVolume(PREVIEW_VOLUME)
      } catch {
        // player died — silent
      }
      onMutedChange(false)
    }
    const tryUnmute = () => {
      if (cancelled) return
      if (claimPreviewAudio(topicId)) {
        unMuteNow()
        return
      }
      // Someone else is audible — queue (fires when they scroll off).
      waitForPreviewAudio(topicId, () => {
        if (cancelled) return
        if (!hasUserGestured()) {
          // Un-muting now would just get the video paused by policy —
          // drop the lease; the gesture handler re-claims later.
          releasePreviewAudio(topicId)
          return
        }
        unMuteNow()
      })
    }

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
              // it we start muted so two cards never talk over each
              // other.
              audibleRef.current = claimPreviewAudio(topicId)
              if (audibleRef.current) {
                e.target.setVolume(PREVIEW_VOLUME)
              } else {
                e.target.mute()
                onMutedChange(true)
                // Queue for the lease — granted when the audible card
                // scrolls away.
                waitForPreviewAudio(topicId, () => {
                  if (cancelled) return
                  if (!hasUserGestured()) {
                    // Un-muting now would just get the video paused by
                    // policy — drop the lease; the gesture handler
                    // re-claims later.
                    releasePreviewAudio(topicId)
                    return
                  }
                  unMuteNow()
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
              // Recover as soon as the user interacts with the page —
              // from then on audible playback is allowed.
              onUserGesture(tryUnmute)
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
    // setAudible is the preview's SOUND BUTTON path (user: "only in the
    // preview video make it show a sound button which i can press to
    // turn on sound") — the press is the user gesture the autoplay
    // policy needs, so the un-mute reliably sticks.
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
      setAudible: (on: boolean) => {
        if (on) {
          // unMuteNow (no lease re-claim — the store already forced the
          // lease to THIS topic before calling).
          unMuteNow()
        } else {
          audibleRef.current = false
          try {
            playerRef.current?.mute()
          } catch {
            // silent
          }
          onMutedChange(true)
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
      // Recover the sound as soon as the user interacts (see the store).
      onUserGesture(tryUnmute)
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
        // Autoplay policy — retry muted, free the sound lease, and
        // recover the sound at the first user gesture (the fallback
        // used to be permanent: "sound is muted on home screen and
        // only activates in article" — see the store's gesture
        // tracking).
        releasePreviewAudio(topicId)
        audibleRef.current = false
        onMutedChange(true)
        attempt(true)
        onUserGesture(() => {
          const el2 = ref.current
          if (!el2 || startedRef.current !== true) return
          if (claimPreviewAudio(topicId)) {
            el2.muted = false
            el2.volume = PREVIEW_VOLUME / 100
            audibleRef.current = true
            el2.play().catch(() => {
              // policy still blocks — revert to muted
              el2.muted = true
              releasePreviewAudio(topicId)
              audibleRef.current = false
              el2.play().catch(() => {})
            })
            onMutedChange(false)
            return
          }
          // Someone else is audible — queue for the lease; un-mute only
          // once the user has interacted (policy pauses otherwise).
          waitForPreviewAudio(topicId, () => {
            const el3 = ref.current
            if (!el3) return
            if (!hasUserGestured()) {
              releasePreviewAudio(topicId)
              return
            }
            el3.muted = false
            el3.volume = PREVIEW_VOLUME / 100
            audibleRef.current = true
            onMutedChange(false)
          })
        })
      })
    }
    if (!audibleRef.current) {
      // No lease — start muted and queue; un-mute on grant, but only
      // after the user has interacted (un-muting earlier gets the
      // video paused by the autoplay policy).
      waitForPreviewAudio(topicId, () => {
        const el2 = ref.current
        if (!el2) return
        if (!hasUserGestured()) {
          releasePreviewAudio(topicId)
          return
        }
        el2.muted = false
        el2.volume = PREVIEW_VOLUME / 100
        audibleRef.current = true
        onMutedChange(false)
      })
    }
    attempt(!audibleRef.current)
  }

  // Article-open silencing + the handoff's startAt + the sound button.
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
      // The preview's SOUND BUTTON path — the press is the user gesture
      // the autoplay policy needs, so audible play() here reliably
      // sticks (user: "only in the preview video make it show a sound
      // button which i can press to turn on sound").
      setAudible: (on: boolean) => {
        if (on) {
          el.muted = false
          el.volume = PREVIEW_VOLUME / 100
          audibleRef.current = true
          onMutedChange(false)
          // If the policy STILL refuses (rare), fall back to muted so
          // the preview keeps rolling instead of freezing.
          el.play().catch(() => {
            el.muted = true
            audibleRef.current = false
            onMutedChange(true)
            el.play().catch(() => {})
          })
        } else {
          el.muted = true
          audibleRef.current = false
          onMutedChange(true)
        }
      },
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
  // Resolved video (null until found).
  const [video, setVideo] = React.useState<ResolvedVideo | null>(null)
  // The player is genuinely PLAYING → fade the overlay in.
  const [playing, setPlaying] = React.useState(false)
  // Muted state (lease lost or autoplay blocked) — chip icon only.
  const [muted, setMuted] = React.useState(false)
  // A miss (no video for this story) — hides the Watch affordance too.
  const [missed, setMissed] = React.useState(false)
  // An article sheet is open — no NEW preview player mounts (a video
  // must never roll behind the sheet while the user watches the
  // article: user: "the video doesn't play in the article and i find out
  // it is still playing on the main page"). A player that was ALREADY
  // rolling when the sheet opened stays mounted and paused (the store
  // pauses it) so it can RESUME at its position when the article closes
  // — instead of restarting from zero.
  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [holdMounted, setHoldMounted] = React.useState(false)
  const playingRef = React.useRef(false)
  React.useEffect(() => {
    playingRef.current = playing
  }, [playing])
  // One attempt per topic per session — never refetch after the first try.
  const triedRef = React.useRef(false)
  // Dead-video swaps (embed-disallowed candidates) — the client
  // accumulates the rejected ids, the resolver excludes them, and up to
  // three swaps hunt for an embeddable candidate (finance stories often
  // have 2-3 blocked videos from Bloomberg/Reuters/CGTN before an
  // embeddable one ranks). After that the card is a miss for the
  // session; the server-side dead list persists for everyone else.
  const deadIdsRef = React.useRef<string[]>([])

  // What the sound button DISPLAYED when the user pressed it. The press
  // itself is a page gesture: the document-level pointerdown listener
  // (gesture recovery, see the store) can un-mute the preview BETWEEN
  // the press and the click — the click handler's `muted` prop would
  // then read the flipped state and toggle the sound straight back OFF,
  // the exact opposite of the user's intent. Capturing the displayed
  // state at press time makes the toggle deterministic.
  const pressedMutedRef = React.useRef(false)

  // ── Article-open tracking (reactive — see the store) ──
  React.useEffect(() => {
    setSheetOpen(isArticleSheetOpen())
    return onArticleOpenChange(setSheetOpen)
  }, [])
  // When the sheet opens: a playing preview is HELD (mounted + paused,
  // resuming at its position on close); a resolving/buffering one is
  // gated off entirely (mounts fresh after the close — it had never
  // started, so nothing is lost).
  React.useEffect(() => {
    if (sheetOpen) setHoldMounted(playingRef.current)
    else setHoldMounted(false)
  }, [sheetOpen])

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
      setMissed(true)
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
          setMissed(true)
        }
      } catch {
        setVideo(null)
        markMiss(topicId)
        setMissed(true)
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

  // ── Resolve the video (once, throttled, locale-aware) — as soon as
  //    the card is on screen (user: "remove the 0.8 second wait from
  //    the preview and show it as fast as possible"). The fetch is
  //    registered as PENDING in the store while in flight: if the user
  //    taps the card mid-flight, the article that opens gets handed the
  //    video the moment it lands (late handoff). ──
  React.useEffect(() => {
    if (!visible || triedRef.current || hadMiss(topicId)) return
    const arm = () => {
      triedRef.current = true
      markPreviewFetchPending(topicId)
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
            // landscape candidates ahead of portrait ones, and a
            // short-form video is a valid big-card preview (user spec).
            const resolved: ResolvedVideo = data
            // Tapping this card while the video is previewing opens the
            // article with the video already rolling.
            markPreviewPlaying(topicId, resolved)
            setVideo(resolved)
            // The card may have been tapped while this fetch was in
            // flight — its article is open and waiting for THIS.
            armLateIfRequested(topicId, resolved)
          } else {
            markMiss(topicId)
            setMissed(true)
          }
        } catch {
          markMiss(topicId)
          setMissed(true)
        } finally {
          markPreviewFetchSettled(topicId)
          release()
        }
      })()
    }
    // DWELL_MS = 0 → resolve immediately (still after the visibility
    // gate — an off-screen card never arms); a positive DWELL_MS keeps
    // the resettable dwell timer for future tuning.
    if (DWELL_MS > 0) {
      const timer = setTimeout(arm, DWELL_MS)
      return () => clearTimeout(timer)
    }
    arm()
  }, [visible, topicId])

  // ── Unmount: release any audio lease (the resolved-video handoff
  // marker intentionally survives — a tap right after the preview faded
  // still opens the article with the video rolling). ──
  React.useEffect(() => {
    return () => {
      releasePreviewAudio(topicId)
    }
  }, [topicId])

  // While an article sheet is open no NEW player mounts (a video must
  // never roll behind the sheet); a player that was already rolling is
  // HELD mounted + paused (resumes at position on close). Scrolling the
  // card off screen unloads the player — scrolling back remounts a fresh
  // one that must buffer again before it can fade in (otherwise the
  // overlay would flash black over the photo).
  const active = Boolean(video && visible && (!sheetOpen || holdMounted))

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 z-[1]">
      {/* Watch affordance (bottom-left, ONLY on these large cards —
          user: "so people know you can watch too"). Rendered while no
          video is rolling (the PREVIEW chip takes the corner once it
          is) and dropped for known misses. pointer-events pass through
          to the card: tapping opens the article, as always. */}
      {!playing && !missed && !sheetOpen && (
        <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/70 py-[3px] pl-1.5 pr-2 backdrop-blur-[2px]">
          <Play className="h-3 w-3 fill-current text-white/80" />
          <span className="text-[8px] font-extrabold uppercase leading-none tracking-[0.14em] text-white/90">
            Watch
          </span>
        </div>
      )}
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
            transition={{ duration: 0.25, ease: EASE_OUT }}
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

            {/* Sound button (bottom-left) — ONLY while the preview is
                actually playing (user: "ONLY when a video preview is
                playing only in the preview video make it show a sound
                button which i can press to turn on sound"). A PRESS, not
                a hover: the autoplay policy only permits sound after a
                user gesture on the page (user: "i think there is
                something so only where there is a press registered on a
                website it can do sound") — the tap IS that gesture, so
                turning sound on from the button reliably works. Tapping
                it must NOT open the article: pointer-events-auto over
                the pass-through container + stopPropagation (the card's
                own click handler would also ignore it via the
                closest('a, button') guard, but we stop it earlier). */}
            {playing && (
              <button
                type="button"
                aria-label={muted ? 'Turn on preview sound' : 'Mute preview sound'}
                title={muted ? 'Turn on sound' : 'Mute'}
                onPointerDown={(e) => {
                  // Stop the card's drag/tap machinery from seeing this
                  // press (a swipe must never double as a sound toggle),
                  // and capture what the button DISPLAYED — the press is
                  // itself a page gesture, so the store's gesture
                  // recovery may flip `muted` between here and the click
                  // (see pressedMutedRef above).
                  e.stopPropagation()
                  pressedMutedRef.current = muted
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  e.preventDefault()
                  // Displayed-muted → intent is ON; displayed-audible →
                  // intent is OFF. The click runs inside the user
                  // gesture, so the un-mute reliably sticks.
                  setPreviewAudible(topicId, pressedMutedRef.current)
                }}
                className="pointer-events-auto absolute bottom-1.5 left-1.5 z-[2] flex items-center gap-1 rounded-md bg-black/70 py-[3px] pl-1.5 pr-2 backdrop-blur-[2px] transition-transform duration-150 active:scale-95"
              >
                {muted ? (
                  <VolumeX className="h-3 w-3 text-white/80" />
                ) : (
                  <Volume1 className="h-3 w-3 text-white/80" />
                )}
                <span className="text-[8px] font-extrabold uppercase leading-none tracking-[0.14em] text-white/90">
                  Sound
                </span>
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
