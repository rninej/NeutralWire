'use client'

import * as React from 'react'
import {
  Download,
  X,
  Share,
  Plus,
  CheckCircle2,
  Menu,
  Sparkles,
  Smartphone,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { hasCookieChoice } from '@/lib/cookie-consent'
import { fetchInstallCount } from '@/lib/pwa-metrics'
import {
  ensureFirstSeen,
  isFirstVisitSession,
  type PopupMode,
} from '@/lib/popup-mode'

// ── localStorage keys ──
const DISMISS_KEY = 'neutralwire:pwa-install-dismissed'
const INSTALLED_KEY = 'neutralwire:pwa-installed-flag'
const NEVER_KEY = 'neutralwire:pwa-install-never'
const DISMISS_COUNT_KEY = 'neutralwire:pwa-install-dismiss-count'
const LAST_SHOWN_KEY = 'neutralwire:pwa-install-last-shown'
const ARTICLES_OPENED_KEY = 'neutralwire:articles-opened'

// ── Popup-system switch (from /debug, via Firebase + SSR) ──
// 'smart'            → this engine fully owns install prompting.
// 'smart-firstvisit'  → the legacy first-visit popup owns the visitor's
//                       very FIRST visit; this engine stands down for that
//                       session and owns everything from visit two on.
// ('original' never mounts this component at all — see page-client.)

// ── Behavioral tuning (see design notes at the bottom of this file) ──
const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000 // "Not now" → 3-day snooze
const DAILY_CAP_MS = 20 * 60 * 60 * 1000 // max ~1 impression per day
const DISMISS_PERMANENT = 4 // after 4 soft dismissals, stop asking forever
const FIRST_VISIT_MIN_DWELL = 35 * 1000 // never interrupt a brand-new visitor early
const RETURNING_MIN_DWELL = 12 * 1000
const TOPIC_THRESHOLD_NEW = 3 // web.dev: show after 2+ engagement signals
const TOPIC_THRESHOLD_RETURNING = 2
const ENGAGED_TIME_MS = 75 * 1000 // fallback trigger for quiet readers
const WELCOME_BACK_MS = 40 * 1000 // feed-scroller fallback (no story opened)
const SHARE_LINK_DELAY = 6000 // ?topic= visitor reading a shared story

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type InstallMode = 'native' | 'samsung' | 'ios' | 'none'
type TriggerKind =
  | 'read'
  | 'vote'
  | 'topics'
  | 'time'
  | 'welcome-back'
  | 'share-link'

/**
 * PWA install prompt — behaviorally-timed, research-grounded.
 *
 * ── WHEN we ask (the interesting part) ──
 * Grounded in the Fogg Behavior Model (B = MAP: a prompt only converts
 * when Motivation is already high), the peak–end rule, and web.dev's
 * install-pattern guidance ("wait for demonstrated interest"):
 *
 *   1. 'read'        — the reader just FINISHED a story (scrolled deep
 *                      or dwelled 45s+). Peak moment → highest intent.
 *   2. 'vote'        — they rated a source / voted on bias. The Hooked
 *                      model's INVESTMENT phase: they've put something
 *                      of themselves in → ownership is warm.
 *   3. 'topics'      — 2–3 stories opened this session (web.dev's
 *                      "2+ pages" rule).
 *   4. 'time'        — 75s of engaged reading (quiet-reader fallback).
 *   5. 'welcome-back'— returning visitor, early gentle eligibility.
 *   6. 'share-link'  — opened a ?topic= share: pre-qualified intent.
 *
 *   Guards: never before the cookie banner is answered, never over the
 *   Account page, never within the first 35s of a first visit, max one
 *   impression per ~day, "Not now" snoozes 3 days, an explicit
 *   "Never ask again" (or 4 dismissals) stops it forever.
 *
 * ── HOW we ask ──
 *   A bottom sheet with a phone home-screen mock whose NeutralWire icon
 *   springs into place (endowment effect: visualizing the app as THEIRS),
 *   trigger-contextual copy, three concrete benefits, and honest social
 *   proof (the real install count, only shown once it's persuasive).
 *   One-tap install via the deferred beforeinstallprompt event
 *   (user-gesture activated); iOS + Samsung get inline step guides.
 */

const TRIGGER_COPY: Record<TriggerKind, { title: string; sub: string }> = {
  read: {
    title: 'Enjoyed that story?',
    sub: 'Imagine this as an app — one tap from your home screen, every side of every story.',
  },
  vote: {
    title: 'Your votes make this yours',
    sub: 'Save that personal touch on your home screen — NeutralWire gets better every time you use it.',
  },
  topics: {
    title: "You're getting into this",
    sub: 'Readers who add NeutralWire to their home screen open it 3× more often. It takes two taps.',
  },
  time: {
    title: 'Loving the feed?',
    sub: 'Make it instant — NeutralWire on your home screen loads in under a second, even offline.',
  },
  'welcome-back': {
    title: 'Welcome back',
    sub: 'Next time, skip the browser. The app opens straight to today\u2019s balanced briefings.',
  },
  'share-link': {
    title: 'One tap from home',
    sub: 'Stories like this land in the app three times a day — left, center and right, side by side.',
  },
}

export function PwaInstallPrompt({
  popupSystem = 'smart',
}: {
  popupSystem?: PopupMode
} = {}) {
  const [deferredPrompt, setDeferredPrompt] =
    React.useState<BeforeInstallPromptEvent | null>(null)
  const [showSheet, setShowSheet] = React.useState(false)
  const [mode, setMode] = React.useState<InstallMode>('none')
  const [showInstalledToast, setShowInstalledToast] = React.useState(false)
  const [trigger, setTrigger] = React.useState<TriggerKind>('topics')
  const [installCount, setInstallCount] = React.useState<number | null>(null)
  const [showSteps, setShowSteps] = React.useState(false)

  // Captured in a ref so the mount-only effect can read the mode without
  // re-subscribing (the SSR prop is constant for a page load anyway).
  const popupSystemRef = React.useRef(popupSystem)

  const deferredPromptRef = React.useRef<BeforeInstallPromptEvent | null>(null)
  const modeRef = React.useRef<InstallMode>('none')
  const installedRef = React.useRef(false)
  const shownRef = React.useRef(false)

  React.useEffect(() => {
    // ── Hybrid-mode courtesy ──
    // In 'smart-firstvisit' the classic popup owns the visitor's very
    // first visit (high visibility, early trigger). Standing down here
    // guarantees ONE ask per visit — this engine re-arms automatically
    // on the next visit, when the first-visit session marker is gone.
    ensureFirstSeen()
    if (popupSystemRef.current === 'smart-firstvisit' && isFirstVisitSession()) {
      return
    }

    const ua = window.navigator.userAgent

    // ── Browser detection (same rules as before) ──
    const isSamsungInternet = ua.includes('SamsungBrowser')
    const isSafariIOS =
      (ua.includes('iPhone') || ua.includes('iPad')) && !ua.includes('CriOS')

    let installMode: InstallMode = 'native'
    if (isSamsungInternet) installMode = 'samsung'
    else if (isSafariIOS) installMode = 'ios'

    if (installMode === 'native') {
      const isDesktop =
        window.innerWidth >= 1024 &&
        !/android|mobile|iphone|ipad|ipod|windows phone/i.test(ua) &&
        !('ontouchstart' in window)
      if (isDesktop) installMode = 'none'
    }
    if (installMode === 'none') return

    // Already installed → never show.
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone ===
        true
    if (standalone || localStorage.getItem(INSTALLED_KEY) === 'true') {
      installedRef.current = true
      return
    }

    setMode(installMode)
    modeRef.current = installMode

    // ── Returning-visitor detection ──
    const firstSeen = ensureFirstSeen()
    const articlesOpened = parseInt(
      localStorage.getItem(ARTICLES_OPENED_KEY) || '0',
      10,
    )
    const isReturning =
      Date.now() - firstSeen > 24 * 60 * 60 * 1000 || articlesOpened > 0
    const minDwell = isReturning ? RETURNING_MIN_DWELL : FIRST_VISIT_MIN_DWELL
    const topicThreshold = isReturning
      ? TOPIC_THRESHOLD_RETURNING
      : TOPIC_THRESHOLD_NEW

    const sessionStart = Date.now()
    let topicsThisSession = 0
    let voteSignals = 0

    // ── Snooze / frequency gates ──
    const isNever = () => {
      if (localStorage.getItem(NEVER_KEY) === 'true') return true
      const count = parseInt(
        localStorage.getItem(DISMISS_COUNT_KEY) || '0',
        10,
      )
      if (count >= DISMISS_PERMANENT) return true
      return false
    }
    const isSnoozed = () => {
      const dismissedAt = localStorage.getItem(DISMISS_KEY)
      if (dismissedAt && Date.now() - parseInt(dismissedAt, 10) < SNOOZE_MS) {
        return true
      }
      const lastShown = localStorage.getItem(LAST_SHOWN_KEY)
      if (lastShown && Date.now() - parseInt(lastShown, 10) < DAILY_CAP_MS) {
        return true
      }
      return false
    }

    const canAsk = () =>
      !shownRef.current &&
      !installedRef.current &&
      !isNever() &&
      !isSnoozed() &&
      Date.now() - sessionStart >= minDwell &&
      hasCookieChoice() &&
      // Never stack on top of the full-screen Account page.
      !document.querySelector('.fixed.inset-0.z-50[aria-label="Account"]') &&
      // Native mode needs beforeinstallprompt to have fired (the Install
      // button would be dead otherwise).
      (modeRef.current !== 'native' || deferredPromptRef.current !== null)

    const tryShow = (kind: TriggerKind) => {
      if (!canAsk()) return
      shownRef.current = true
      setTrigger(kind)
      setShowSheet(true)
      localStorage.setItem(LAST_SHOWN_KEY, String(Date.now()))
    }

    // ── Fetch the real install count for social proof (once eligible) ──
    // Low counts are hidden by fetchInstallCount itself (<15 → null).
    fetchInstallCount().then(setInstallCount).catch(() => {})

    // ── Trigger: shared story link (?topic=) — pre-qualified intent ──
    const urlParams = new URLSearchParams(window.location.search)
    if (urlParams.has('topic')) {
      setTimeout(() => tryShow('share-link'), SHARE_LINK_DELAY)
    } else if (isReturning) {
      // Returning visitor who has NOT opened a story by 40s is still
      // engaged with the feed — one gentle offer. If they ARE opening
      // stories, the contextual triggers (read / vote / topics) own the
      // moment instead — a fixed timer must never preempt a peak moment.
      setTimeout(() => {
        if (topicsThisSession === 0) tryShow('welcome-back')
      }, WELCOME_BACK_MS)
    }

    // ── Trigger: stories opened this session ──
    const topicOpenedHandler = () => {
      topicsThisSession += 1
      if (topicsThisSession >= topicThreshold) tryShow('topics')
    }
    window.addEventListener('neutralwire:topic-opened', topicOpenedHandler)

    // ── Trigger: finished reading a story (peak–end moment) ──
    // Dispatched by TopicDetail at ≥65% scroll or ≥45s dwell.
    const articleReadHandler = () => {
      setTimeout(() => tryShow('read'), 900)
    }
    window.addEventListener('neutralwire:article-read', articleReadHandler)

    // ── Trigger: voted / rated (investment phase) ──
    const engagementHandler = () => {
      voteSignals += 1
      if (voteSignals <= 2) tryShow('vote')
    }
    window.addEventListener('neutralwire:engagement-changed', engagementHandler)

    // ── Trigger: quiet-reader fallback (engaged time) ──
    const timeTimer = setTimeout(() => {
      if (topicsThisSession >= 1) tryShow('time')
    }, ENGAGED_TIME_MS)

    // ── beforeinstallprompt (native mode) ──
    const beforeInstallHandler = (e: Event) => {
      if (modeRef.current !== 'native') return
      e.preventDefault()
      deferredPromptRef.current = e as BeforeInstallPromptEvent
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', beforeInstallHandler)

    // ── appinstalled — cleanup after install ──
    const installedHandler = () => {
      localStorage.setItem(INSTALLED_KEY, 'true')
      installedRef.current = true
      setShowSheet(false)
      setDeferredPrompt(null)
      deferredPromptRef.current = null
      setShowInstalledToast(true)
      setTimeout(() => setShowInstalledToast(false), 6000)
    }
    window.addEventListener('appinstalled', installedHandler)

    // ── Yield to the Account page ──
    const accountOpened = () => {
      if (shownRef.current) {
        shownRef.current = false
        setShowSheet(false)
      }
    }
    const accountClosed = () => {
      // Re-arm so the next behavioral trigger can show the sheet.
      shownRef.current = false
    }
    window.addEventListener('neutralwire:account-opened', accountOpened)
    window.addEventListener('neutralwire:account-closed', accountClosed)

    return () => {
      clearTimeout(timeTimer)
      window.removeEventListener('neutralwire:topic-opened', topicOpenedHandler)
      window.removeEventListener('neutralwire:article-read', articleReadHandler)
      window.removeEventListener('neutralwire:engagement-changed', engagementHandler)
      window.removeEventListener('beforeinstallprompt', beforeInstallHandler)
      window.removeEventListener('appinstalled', installedHandler)
      window.removeEventListener('neutralwire:account-opened', accountOpened)
      window.removeEventListener('neutralwire:account-closed', accountClosed)
    }
  }, [])

  const handleDismiss = (never: boolean) => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
    if (never) {
      localStorage.setItem(NEVER_KEY, 'true')
    } else {
      const count = parseInt(
        localStorage.getItem(DISMISS_COUNT_KEY) || '0',
        10,
      )
      localStorage.setItem(DISMISS_COUNT_KEY, String(count + 1))
    }
    setShowSheet(false)
  }

  // ── Primary CTA ──
  // Native: deferredPrompt.prompt() inside the click handler (user
  // gesture — satisfies browser activation rules).
  // iOS / Samsung: reveal the inline step guide inside the sheet.
  const handlePrimaryAction = () => {
    if (modeRef.current === 'native') {
      void handleNativeInstall()
    } else {
      setShowSteps(true)
    }
  }

  const handleNativeInstall = async () => {
    const prompt = deferredPromptRef.current
    if (!prompt) return
    try {
      await prompt.prompt()
      const choice = await prompt.userChoice
      if (choice.outcome === 'accepted') {
        localStorage.setItem(INSTALLED_KEY, 'true')
        installedRef.current = true
      } else {
        // Rejected the native dialog — treat as a soft dismissal.
        localStorage.setItem(DISMISS_KEY, String(Date.now()))
        const count = parseInt(
          localStorage.getItem(DISMISS_COUNT_KEY) || '0',
          10,
        )
        localStorage.setItem(DISMISS_COUNT_KEY, String(count + 1))
      }
      setShowSheet(false)
      setDeferredPrompt(null)
      deferredPromptRef.current = null
    } catch (err) {
      console.warn('[PWA] install prompt failed:', err)
      setShowSheet(false)
    }
  }

  // ── "Installed!" confirmation toast ──
  if (showInstalledToast) {
    return (
      <div className="fixed bottom-4 left-4 right-4 z-[70] mx-auto max-w-sm rounded-xl border-2 border-emerald-400 bg-background p-4 shadow-lg">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
            <CheckCircle2 className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <div className="font-semibold text-sm">NeutralWire installed!</div>
            <div className="mt-1 text-xs text-muted-foreground">
              The app is opening now. Look for the NeutralWire icon on your
              home screen to launch it anytime.
            </div>
          </div>
          <button
            onClick={() => setShowInstalledToast(false)}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    )
  }

  const copy = TRIGGER_COPY[trigger]

  return (
    <AnimatePresence>
      {showSheet && mode !== 'none' && (
        <motion.div
          initial={{ y: '110%', opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: '110%', opacity: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 38 }}
          className="fixed bottom-0 left-0 right-0 z-[70] flex justify-center px-3 pb-3"
        >
          <div className="w-full max-w-md overflow-hidden rounded-3xl border bg-background shadow-2xl">
          {/* Top row: phone mock + headline (the endowment visual) */}
          <div className="flex gap-4 px-5 pt-5">
            <PhoneHomeMock />
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-lg font-bold leading-snug">
                  {copy.title}
                </h2>
                <button
                  onClick={() => handleDismiss(false)}
                  className="-mt-1 -mr-1 rounded-lg p-1.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  aria-label="Not now"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                {copy.sub}
              </p>
            </div>
          </div>

          {/* Benefits */}
          <ul className="mt-4 space-y-1.5 px-5">
            <Benefit>Left · Center · Right — every side, side by side</Benefit>
            <Benefit>3 balanced briefings a day, free forever</Benefit>
            <Benefit>Instant opening, works offline</Benefit>
          </ul>

          {/* Honest social proof — the REAL install count (hidden until
              it's persuasive; see fetchInstallCount). */}
          {installCount !== null && (
            <div className="mt-3 flex items-center gap-1.5 px-5 text-xs text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5 text-emerald-500" />
              <span>
                Join <strong className="text-foreground">
                  {installCount.toLocaleString()}
                </strong>{' '}
                readers who keep NeutralWire on their home screen
              </span>
            </div>
          )}

          {/* CTA row */}
          <div className="mt-4 px-5">
            {mode === 'native' && !deferredPrompt ? (
              <div className="flex h-11 items-center justify-center rounded-xl bg-muted text-sm text-muted-foreground">
                Preparing install…
              </div>
            ) : (
              <Button
                onClick={handlePrimaryAction}
                className="h-11 w-full text-[15px] font-semibold"
              >
                <Download className="mr-2 h-4 w-4" />
                Add to Home Screen
              </Button>
            )}
          </div>

          {/* Steps (iOS / Samsung) — revealed in place, same sheet */}
          <AnimatePresence initial={false}>
            {showSteps && (mode === 'ios' || mode === 'samsung') && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="overflow-hidden"
              >
                <div className="mt-4 space-y-2 px-5">
                  <p className="text-xs font-medium text-muted-foreground">
                    Two taps in your browser menu:
                  </p>
                  {(mode === 'ios'
                    ? [
                        {
                          icon: <Share className="h-3.5 w-3.5" />,
                          text: (
                            <>
                              Tap the{' '}
                              <strong className="inline-flex items-center gap-1">
                                <Share className="inline h-3 w-3" /> Share
                              </strong>{' '}
                              button in Safari
                            </>
                          ),
                        },
                        {
                          icon: <Plus className="h-3.5 w-3.5" />,
                          text: (
                            <>
                              Scroll down and tap{' '}
                              <strong>Add to Home Screen</strong>
                            </>
                          ),
                        },
                      ]
                    : [
                        {
                          icon: <Menu className="h-3.5 w-3.5" />,
                          text: (
                            <>
                              Tap the{' '}
                              <strong className="inline-flex items-center gap-1">
                                <Menu className="inline h-3 w-3" /> menu
                              </strong>{' '}
                              button (☰)
                            </>
                          ),
                        },
                        {
                          icon: <Plus className="h-3.5 w-3.5" />,
                          text: (
                            <>
                              Tap <strong>Add to Home screen</strong> (or
                              &ldquo;Install app&rdquo;)
                            </>
                          ),
                        },
                      ]
                  ).map((step, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2.5 rounded-xl bg-muted/60 p-3"
                    >
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-foreground text-[11px] font-bold text-background">
                        {i + 1}
                      </span>
                      <div className="flex items-center gap-1.5 text-[13px] leading-snug">
                        <span className="text-muted-foreground">
                          {step.icon}
                        </span>
                        <span>{step.text}</span>
                      </div>
                    </div>
                  ))}
                  <div className="flex items-center gap-1.5 rounded-xl bg-blue-500/10 p-3 text-[12px] text-blue-600 dark:text-blue-400">
                    <Smartphone className="h-3.5 w-3.5 shrink-0" />
                    Then open NeutralWire from your home screen — that
                    &rsquo;s the app.
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Footer: dismiss options */}
          <div className="flex flex-col items-center gap-1 px-5 pb-4 pt-3">
            <button
              onClick={() => handleDismiss(false)}
              className="py-1 text-sm text-muted-foreground hover:text-foreground"
            >
              Not now
            </button>
            <button
              onClick={() => handleDismiss(true)}
              className="py-0.5 text-[11px] text-muted-foreground/60 hover:text-muted-foreground"
            >
              Never ask again
            </button>
          </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Benefit({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2 text-[13px] text-foreground/85">
      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
      {children}
    </li>
  )
}

// ── Phone home-screen mock (the endowment visual) ──
// A tiny phone showing a home-screen grid; the NeutralWire icon SPRINGS
// into the highlighted slot — the user literally watches the app become
// theirs. Pure div/CSS — works in light + dark, no asset dependencies
// beyond /icon-192.png.
function PhoneHomeMock() {
  return (
    <div className="relative h-[104px] w-[64px] shrink-0 rounded-[14px] border-2 border-foreground/15 bg-gradient-to-b from-muted/80 to-muted/40 dark:from-zinc-800 dark:to-zinc-900">
      {/* status bar hint */}
      <div className="mx-auto mt-1 h-[3px] w-6 rounded-full bg-foreground/15" />
      {/* app grid */}
      <div className="mt-1.5 grid grid-cols-3 gap-[5px] px-1.5">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-[13px] rounded-[4px] bg-foreground/10" />
        ))}
        {/* The NeutralWire icon springs into the 7th slot */}
        <motion.div
          initial={{ scale: 0, y: -14, opacity: 0, rotate: -8 }}
          animate={{ scale: 1, y: 0, opacity: 1, rotate: 0 }}
          transition={{
            delay: 0.55,
            type: 'spring',
            stiffness: 420,
            damping: 17,
          }}
          className="relative h-[13px] overflow-visible rounded-[4px]"
        >
          <img
            src="/icon-192.png"
            alt=""
            className="h-full w-full rounded-[4px] object-cover"
          />
          {/* arrival glow */}
          <motion.div
            initial={{ opacity: 0.9, scale: 1 }}
            animate={{ opacity: 0, scale: 2.1 }}
            transition={{ delay: 0.75, duration: 0.8, ease: 'easeOut' }}
            className="absolute inset-0 rounded-[4px] bg-emerald-400"
          />
        </motion.div>
        <div className="h-[13px] rounded-[4px] bg-foreground/10" />
      </div>
      {/* dock */}
      <div className="absolute bottom-1 left-1 right-1 flex justify-center gap-[4px] rounded-[6px] bg-foreground/[0.06] py-[3px]">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[9px] w-[13px] rounded-[3px] bg-foreground/10" />
        ))}
      </div>
    </div>
  )
}
