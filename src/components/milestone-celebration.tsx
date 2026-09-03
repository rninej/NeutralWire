'use client'

import * as React from 'react'
import { Heart, X, Share2, Check, Sparkles } from 'lucide-react'
import { motion, AnimatePresence, animate } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { getDeviceId, createReferral, buildReferralUrl } from '@/lib/referral'

const ARTICLES_OPENED_KEY = 'neutralwire:articles-opened'
const CELEBRATED_KEY = 'neutralwire:milestone-celebrated'
const LOVE_SENT_KEY = 'neutralwire:love-sent'

// Milestones: early wins keep the habit loop tight, then widen out.
const MILESTONES = [10, 30, 60, 100, 150, 200, 300, 400, 500]

// Tri-color brand palette (matches the launch splash).
const CONFETTI_COLORS = [
  'rgb(59,130,246)', // blue
  'rgb(138,138,138)', // gray
  'rgb(239,68,68)', // red
]

function nextMilestone(count: number): number | null {
  for (const m of MILESTONES) {
    if (count < m) return m
  }
  // Past 500 — celebrate every 100.
  return Math.ceil((count + 1) / 100) * 100
}

/**
 * Milestone Celebration — the love moment that replaced the old
 * donation popup inside the installed PWA.
 *
 * WHY THIS DESIGN (behavioral research):
 *  - Peak–end rule: readers remember the most intense moment and the END
 *    of an experience. Interrupting a happy reading session with an ASK
 *    (donate) ends the session on guilt. Celebrating their progress ends
 *    it on pride — the memory they'll return for.
 *  - Variable reward (Hooked model): the celebration appears at
 *    unpredictable story counts, not every session — a genuine surprise.
 *  - Investment + progress: "you've read N stories" frames their own
 *    accumulated effort — the strongest retention driver there is.
 *  - Social proof + contribution: the community heart count ("you and M
 *    others") is REAL data; one tap adds theirs. Small investments
 *    create attachment.
 *  - Referral share: the one "ask" is optional and framed as a gift to
 *    a friend ("know someone stuck in a bubble?"), which is also the
 *    top-of-funnel for new installs.
 *
 * There is NO donate ask here, ever. The Ko-fi card stays tucked away
 * in Account → Support for those who go looking.
 */
export function MilestoneCelebration() {
  const [show, setShow] = React.useState(false)
  const [count, setCount] = React.useState(0)
  const [displayCount, setDisplayCount] = React.useState(0)
  const [loveCount, setLoveCount] = React.useState<number | null>(null)
  const [loveSent, setLoveSent] = React.useState(false)
  const [loveBurst, setLoveBurst] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone ===
        true

    // ── Count story opens on EVERY surface (browser + PWA) ──
    // The counter feeds both the milestone progress and the install
    // sheet's returning-visitor detection. Celebrations themselves are
    // PWA-only (the browser gets the install sheet instead — the two
    // moments must never compete on the same surface).
    const handleOpened = () => {
      const n =
        parseInt(localStorage.getItem(ARTICLES_OPENED_KEY) || '0', 10) + 1
      localStorage.setItem(ARTICLES_OPENED_KEY, String(n))
    }
    window.addEventListener('neutralwire:topic-opened', handleOpened)

    if (!isStandalone) {
      return () => {
        window.removeEventListener('neutralwire:topic-opened', handleOpened)
      }
    }

    setLoveSent(localStorage.getItem(LOVE_SENT_KEY) === 'true')

    // Current community love count (public endpoint).
    fetch('/api/love')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d.count === 'number') setLoveCount(d.count)
      })
      .catch(() => {})

    const check = () => {
      const n = parseInt(localStorage.getItem(ARTICLES_OPENED_KEY) || '0', 10)
      if (n <= 0) return
      const celebrated = parseInt(
        localStorage.getItem(CELEBRATED_KEY) || '0',
        10,
      )
      // Only celebrate NEWLY-crossed milestones (one at a time).
      const crossed = MILESTONES.find((m) => n >= m && celebrated < m)
      if (!crossed) return
      localStorage.setItem(CELEBRATED_KEY, String(crossed))
      setCount(n)
      setShow(true)
    }

    // The celebration fires on the article-read signal — the peak
    // moment: they just finished a story. Small beat after finishing so
    // the moment feels earned, not automated.
    const handleRead = () => {
      setTimeout(check, 1200)
    }

    window.addEventListener('neutralwire:article-read', handleRead)
    return () => {
      window.removeEventListener('neutralwire:topic-opened', handleOpened)
      window.removeEventListener('neutralwire:article-read', handleRead)
    }
  }, [])

  // ── Count-up animation ──
  React.useEffect(() => {
    if (!show) return
    const controls = animate(0, count, {
      duration: 1.1,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => setDisplayCount(Math.round(v)),
    })
    return () => controls.stop()
  }, [show, count])

  const handleLove = async () => {
    if (loveSent) return
    setLoveSent(true)
    localStorage.setItem(LOVE_SENT_KEY, 'true')
    setLoveBurst(true)
    setLoveCount((c) => (c === null ? 1 : c + 1))
    setTimeout(() => setLoveBurst(false), 900)
    try {
      const res = await fetch('/api/love', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: getDeviceId() }),
      })
      const d = await res.json()
      if (typeof d.count === 'number') setLoveCount(d.count)
    } catch {
      // keep optimistic value
    }
  }

  const handleShare = async () => {
    try {
      const deviceId = getDeviceId()
      const code = await createReferral(deviceId)
      const url = buildReferralUrl(code)
      const shareData = {
        title: 'NeutralWire',
        text: 'Every side of every story — left, center and right, side by side. Free, no ads.',
        url,
      }
      if (navigator.share) {
        await navigator.share(shareData)
      } else {
        await navigator.clipboard.writeText(url)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    } catch {
      // user cancelled / share failed — silent
    }
  }

  const prev = (() => {
    const past = MILESTONES.filter((m) => m < count)
    return past.length ? past[past.length - 1] : 0
  })()
  const next = nextMilestone(count) ?? count + 50
  const progress = Math.min(1, Math.max(0, (count - prev) / (next - prev)))

  return (
    <AnimatePresence>
      {show && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <TriConfetti />
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 12 }}
            transition={{ type: 'spring', stiffness: 320, damping: 26 }}
            className="relative w-full max-w-sm overflow-hidden rounded-3xl border bg-background shadow-2xl"
          >
            {/* Tri-color top accent — the brand signature */}
            <div className="flex h-1.5 w-full">
              <div className="flex-1 bg-blue-500" />
              <div className="flex-1 bg-zinc-400" />
              <div className="flex-1 bg-red-500" />
            </div>

            <button
              onClick={() => setShow(false)}
              className="absolute right-3 top-3 rounded-lg p-1.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="px-6 pb-6 pt-7 text-center">
              {/* Count-up hero */}
              <motion.div
                initial={{ scale: 0.7, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.1, type: 'spring', stiffness: 260, damping: 18 }}
                className="mx-auto flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl"
              >
                <img src="/icon-192.png" alt="NeutralWire" className="h-full w-full object-cover" />
              </motion.div>

              <h2 className="mt-4 text-2xl font-bold tabular-nums">
                {displayCount.toLocaleString()} stories read
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                Each one shown from the left, the center{' '}
                <span className="text-blue-500">and</span> the right.
                That&rsquo;s {displayCount.toLocaleString()} times you saw
                through the bubble.
              </p>

              {/* Progress to next milestone */}
              <div className="mt-5">
                <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Sparkles className="h-3 w-3 text-emerald-500" />
                    next milestone
                  </span>
                  <span className="tabular-nums">
                    {count} / {next}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${progress * 100}%` }}
                    transition={{ delay: 0.5, duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
                    className="h-full rounded-full bg-gradient-to-r from-blue-500 via-zinc-400 to-red-500"
                  />
                </div>
              </div>

              {/* Community love — one tap, once ever */}
              <div className="mt-6">
                {(() => {
                  const others = Math.max(
                    0,
                    (loveCount ?? 0) - (loveSent ? 1 : 0),
                  )
                  return (
                    <p className="mb-2 text-xs text-muted-foreground">
                      {others === 0 ? (
                        loveSent ? (
                          <>
                            You&rsquo;re the first to love balanced news —
                            others will follow 💙
                          </>
                        ) : (
                          'Be the first to love balanced news'
                        )
                      ) : (
                        <>
                          You and{' '}
                          <strong className="text-foreground">
                            {others.toLocaleString()}
                          </strong>{' '}
                          {others === 1 ? 'reader' : 'readers'}{' '}
                          {others === 1 ? 'loves' : 'love'} balanced news
                        </>
                      )}
                    </p>
                  )
                })()}
                <div className="relative inline-block">
                  <button
                    onClick={handleLove}
                    disabled={loveSent}
                    className={`relative flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-all active:scale-95 ${
                      loveSent
                        ? 'bg-red-500/10 text-red-500'
                        : 'bg-red-500 text-white shadow-lg shadow-red-500/25 hover:bg-red-600'
                    }`}
                  >
                    <Heart
                      className={`h-4 w-4 ${loveSent ? 'fill-red-500' : 'fill-white'} ${
                        loveBurst ? 'animate-ping' : ''
                      }`}
                    />
                    {loveSent ? 'Loved' : 'Love NeutralWire'}
                  </button>
                  {/* Heart burst on press */}
                  <AnimatePresence>
                    {loveBurst && (
                      <>
                        {[0, 1, 2, 3, 4].map((i) => (
                          <motion.span
                            key={i}
                            initial={{ opacity: 1, x: 0, y: 0, scale: 0.5 }}
                            animate={{
                              opacity: 0,
                              x: Math.cos((i / 5) * 2 * Math.PI) * 46,
                              y: Math.sin((i / 5) * 2 * Math.PI) * 46 - 12,
                              scale: 1.1,
                            }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.8, ease: 'easeOut' }}
                            className="pointer-events-none absolute left-1/2 top-1/2 -ml-2 -mt-2 text-lg"
                          >
                            ❤️
                          </motion.span>
                        ))}
                      </>
                    )}
                  </AnimatePresence>
                </div>
              </div>

              {/* Share the balance (referral — top of the install funnel) */}
              <div className="mt-5">
                <Button
                  onClick={handleShare}
                  variant="outline"
                  className="h-10 w-full text-sm font-medium"
                >
                  {copied ? (
                    <>
                      <Check className="mr-2 h-4 w-4 text-emerald-500" />
                      Link copied
                    </>
                  ) : (
                    <>
                      <Share2 className="mr-2 h-4 w-4" />
                      Know someone in a bubble? Share this
                    </>
                  )}
                </Button>
              </div>

              <button
                onClick={() => setShow(false)}
                className="mt-4 text-sm text-muted-foreground hover:text-foreground"
              >
                Keep reading
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}

// ── Tri-color confetti burst (brand blue / gray / red) ──
// Pure framer-motion particles, pointer-events: none, auto-fades.
function TriConfetti() {
  const particles = React.useMemo(
    () =>
      Array.from({ length: 26 }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        delay: Math.random() * 0.35,
        duration: 1.7 + Math.random() * 0.9,
        size: 5 + Math.random() * 5,
        rotate: Math.random() * 720 - 360,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        round: Math.random() > 0.5,
      })),
    [],
  )
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden">
      {particles.map((p) => (
        <motion.div
          key={p.id}
          initial={{ y: -30, opacity: 1, rotate: 0 }}
          animate={{
            y: '105vh',
            opacity: [1, 1, 0],
            rotate: p.rotate,
          }}
          transition={{
            delay: p.delay,
            duration: p.duration,
            ease: [0.25, 0.6, 0.7, 1],
          }}
          style={{
            position: 'absolute',
            left: `${p.left}%`,
            top: 0,
            width: p.size,
            height: p.size * (p.round ? 1 : 0.45),
            backgroundColor: p.color,
            borderRadius: p.round ? '9999px' : '2px',
          }}
        />
      ))}
    </div>
  )
}
