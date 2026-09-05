'use client'

/**
 * video-preview.tsx — the experimental "top story video preview".
 *
 * Enabled from /debug (featureFlags/videoPreview, default OFF) and passed
 * ONLY to the home feed's TOP news card (the big hero card with the NW
 * icon — see MobileTopicLayout). Behaviour (user spec):
 *
 *   1. The card's image renders normally.
 *   2. Once the image has been CONTINUOUSLY on screen for 0.8s (an
 *      IntersectionObserver ≥ 50% visible + a dwell timer — a card the
 *      user is actively scrolling past never triggers it), we fetch the
 *      story's video (/api/video, same resolver + quality rules as the
 *      article's Watch button).
 *   3. When it resolves, the video starts playing INSIDE the image —
 *      MUTED, no controls, looping softly. A tiny "muted preview" chip
 *      marks it; tapping the card still opens the article (with sound,
 *      via the Watch button) as always.
 *   4. Scrolling the card off screen UNLOADS the player (no bandwidth
 *      burn); scrolling back re-plays it without re-fetching.
 *   5. A "no video" result is remembered for the tab session — scrolling
 *      back never re-fetches a known miss.
 *
 * Bandwidth/CPU guards: at most ONE card in the feed carries the prop,
 * resolution results are Firebase-cached (24h found / 6h miss) server-side,
 * and the whole feature rides behind the videoWatch flag too — /api/video
 * refuses while the master video feature is off.
 */

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { VolumeX, Loader2 } from 'lucide-react'

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

/** User spec: the image must be viewed for 0.8s before the preview arms. */
const DWELL_MS = 800

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

export function HeroVideoPreview({ topicId }: { topicId: string }) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  // ≥50% on screen (updated by the IntersectionObserver).
  const [visible, setVisible] = React.useState(false)
  // Resolved video (null until found).
  const [video, setVideo] = React.useState<VideoApiResponse | null>(null)
  // Resolution in flight (shows the tiny loading chip).
  const [fetching, setFetching] = React.useState(false)
  // One attempt per topic per session — never refetch after the first try.
  const triedRef = React.useRef(false)

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

  // ── 0.8s dwell → resolve the video (once) ──
  // The timer RESETS every time the card dips below 50% visibility, so a
  // card the user is actively scrolling past never arms.
  React.useEffect(() => {
    if (!visible || triedRef.current || hadMiss(topicId)) return
    const timer = setTimeout(() => {
      triedRef.current = true
      setFetching(true)
      fetch(`/api/video/${encodeURIComponent(topicId)}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((data: VideoApiResponse) => {
          if (data?.ok) {
            setVideo(data)
          } else {
            markMiss(topicId)
          }
        })
        .catch(() => {
          markMiss(topicId)
        })
        .finally(() => setFetching(false))
    }, DWELL_MS)
    return () => clearTimeout(timer)
  }, [visible, topicId])

  const playing = Boolean(video && visible)

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 z-[1]">
      <AnimatePresence>
        {playing && (
          <motion.div
            key="preview-player"
            className="absolute inset-0 overflow-hidden bg-black"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease: EASE_OUT }}
          >
            {video?.kind === 'youtube' && video.videoId ? (
              <iframe
                key={video.videoId}
                src={`https://www.youtube-nocookie.com/embed/${video.videoId}?autoplay=1&mute=1&controls=0&loop=1&playlist=${video.videoId}&rel=0&modestbranding=1&playsinline=1&fs=0`}
                title="Video preview"
                className="h-full w-full"
                allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
                // No allowFullScreen: it's a PREVIEW — the full player
                // (sound + controls) lives inside the article.
                tabIndex={-1}
                referrerPolicy="strict-origin-when-cross-origin"
              />
            ) : video?.kind === 'video' && video.url ? (
              <video
                key={video.url}
                src={video.url}
                className="h-full w-full object-cover"
                muted
                autoPlay
                playsInline
                loop
                // onError → fall back to the image silently (unload).
                onError={() => setVideo(null)}
              />
            ) : null}

            {/* Muted-preview chip (bottom-left) — matches the NW mark's
                styling so the video area stays on-brand. */}
            <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/70 py-[3px] pl-1.5 pr-2 backdrop-blur-[2px]">
              <VolumeX className="h-3 w-3 text-white/80" />
              <span className="text-[8px] font-extrabold uppercase leading-none tracking-[0.14em] text-white/90">
                Preview
              </span>
            </div>
          </motion.div>
        )}

        {/* Resolving chip — small, bottom-left, over the image. */}
        {!playing && fetching && visible && (
          <motion.div
            key="preview-loading"
            className="absolute bottom-1.5 left-1.5 flex items-center gap-1.5 rounded-md bg-black/70 py-[3px] pl-2 pr-2.5 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            <Loader2 className="h-3 w-3 animate-spin text-white/80" />
            <span className="text-[8px] font-extrabold uppercase leading-none tracking-[0.14em] text-white/90">
              Finding video…
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
