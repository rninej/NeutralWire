'use client'

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X,
  UserCircle,
  Gift,
  Users,
  Share2,
  Check,
  Copy,
  Sparkles,
  RotateCcw,
  Heart,
  Bell,
  Palette,
  Target,
  ExternalLink,
  ChevronDown,
  ShieldCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { getDeviceId, buildReferralUrl } from '@/lib/referral'
import {
  getInterests,
  setInterestsLocal,
  syncInterestsWithFirebase,
} from '@/lib/user-interests'
import { getOrCreateGuestName } from '@/lib/guest-name'
import { ThemeSwitcher } from '@/components/theme-toggle'
import { FeatureFlagsCard } from '@/components/feature-flags'
import { GRADIENT_PRESETS } from '@/lib/use-theme-reveal'
import {
  setThemeFamilyStored,
  setThemeModeStored,
} from '@/lib/theme-families'
import { useTheme } from 'next-themes'

interface UserPageProps {
  onClose: () => void
}

// ── 8 subtopics the user can toggle for ultra-personalization ──
// Mirrors the subtopic tabs in the main feed (minus "Relevant", "My
// Country", "Blindspots" which are auto-computed views, not user-
// selectable interests). Aligns with the SECTORS list in user-interests.ts.
const PERSONALIZE_TOPICS = [
  { id: 'world', label: 'World', emoji: '🌍' },
  { id: 'politics', label: 'Politics', emoji: '🏛️' },
  { id: 'business', label: 'Business', emoji: '📈' },
  { id: 'technology', label: 'Technology', emoji: '💻' },
  { id: 'science', label: 'Science', emoji: '🔬' },
  { id: 'health', label: 'Health', emoji: '🏥' },
  { id: 'sports', label: 'Sports', emoji: '⚽' },
  { id: 'top', label: 'Top Stories', emoji: '📰' },
] as const

// ── Tabs ──
// The Account page used to be one very long column (identity → referral
// → interests → feature flags → theme → gradients → notifications →
// support) — over a screen's worth of scrolling on mobile. It is now a
// fixed 4-tab layout with a tab bar pinned UNDER the header: every
// section is exactly ONE tap away, and each tab's content fits roughly
// one screen. Everything is reachable without "scrolling a meter".
type TabId = 'profile' | 'feed' | 'theme' | 'alerts'

const TABS: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
  { id: 'profile', label: 'Profile', icon: <UserCircle className="h-4 w-4" /> },
  { id: 'feed', label: 'Feed', icon: <Target className="h-4 w-4" /> },
  { id: 'theme', label: 'Theme', icon: <Palette className="h-4 w-4" /> },
  { id: 'alerts', label: 'Alerts', icon: <Bell className="h-4 w-4" /> },
]

// Easing curve shared across the page sections.
const EASE_OUT = [0.16, 1, 0.3, 1] as const

export function UserPage({ onClose }: UserPageProps) {
  const pageRef = React.useRef<HTMLDivElement | null>(null)

  // ── Active tab (persisted for the session so reopening lands where
  // the user left off — nice touch, zero cost) ──
  const [tab, setTab] = React.useState<TabId>(() => {
    try {
      const saved = sessionStorage.getItem('neutralwire:account-tab')
      if (saved === 'profile' || saved === 'feed' || saved === 'theme' || saved === 'alerts') {
        return saved
      }
    } catch {}
    return 'profile'
  })

  const switchTab = (t: TabId) => {
    setTab(t)
    try {
      sessionStorage.setItem('neutralwire:account-tab', t)
    } catch {}
    // Tabs replace long scrolling — jump back to the top of the new
    // section so the tab bar + content always start aligned.
    pageRef.current?.scrollTo({ top: 0 })
  }

  // ── Guest name ──
  // getOrCreateGuestName is synchronous (reads localStorage) — no flicker.
  const [guestName] = React.useState<string>(() => getOrCreateGuestName())

  // ── Referral code + stats ──
  const [referralCode, setReferralCode] = React.useState<string | null>(null)
  const [referralUrl, setReferralUrl] = React.useState<string>('')
  const [stats, setStats] = React.useState<{ totalClicks: number; successfulReferrals: number } | null>(null)
  const [referralLoading, setReferralLoading] = React.useState(true)
  const [copied, setCopied] = React.useState(false)

  // ── Personalization ──
  // Each subtopic is a boolean toggle. Loaded from getInterests() on mount.
  const [interests, setInterests] = React.useState<string[]>([])

  // ── Notifications ──
  const [notifEnabled, setNotifEnabled] = React.useState(false)
  const [notifFrequency, setNotifFrequency] = React.useState<'daily3' | 'all'>('daily3')
  const [notifLoading, setNotifLoading] = React.useState(false)

  // ── Collapsible custom gradient maker (Theme tab) ──
  const [showGradientMaker, setShowGradientMaker] = React.useState(false)

  // Lock body scroll when open. Also announce open/close so other
  // overlays (PWA install banner, z-60/70) can yield while the Account
  // page is up instead of stacking on top of it.
  React.useEffect(() => {
    document.body.style.overflow = 'hidden'
    window.dispatchEvent(new CustomEvent('neutralwire:account-opened'))
    return () => {
      document.body.style.overflow = ''
      window.dispatchEvent(new CustomEvent('neutralwire:account-closed'))
    }
  }, [])

  // Close on Escape.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Load interests on mount + listen for external changes (e.g. onboarding).
  React.useEffect(() => {
    const load = () => setInterests(getInterests())
    load()
    window.addEventListener('neutralwire:interests-changed', load)
    return () => window.removeEventListener('neutralwire:interests-changed', load)
  }, [])

  // Fetch referral code + stats on mount.
  React.useEffect(() => {
    let cancelled = false
    let pollInterval: ReturnType<typeof setInterval> | null = null

    ;(async () => {
      const deviceId = getDeviceId()
      const existingCode =
        typeof window !== 'undefined'
          ? localStorage.getItem('neutralwire:my-referral-code')
          : null

      try {
        const res = await fetch('/api/referral/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId, existingCode }),
        })
        const data = await res.json()
        if (cancelled) return
        if (data.code) {
          setReferralCode(data.code)
          setReferralUrl(data.url || buildReferralUrl(data.code))
          localStorage.setItem('neutralwire:my-referral-code', data.code)
        }

        // Fetch stats + poll for live updates (every 15s — less aggressive
        // than referral-dialog's 10s, since the user page is open longer).
        const fetchStats = async () => {
          if (!data.code) return
          try {
            const statsRes = await fetch(`/api/referral/stats?code=${data.code}`)
            if (statsRes.ok) {
              const statsData = await statsRes.json()
              if (!cancelled) setStats(statsData)
            }
          } catch {
            // silent
          }
        }
        fetchStats()
        pollInterval = setInterval(fetchStats, 15000)
      } catch {
        // silent
      } finally {
        if (!cancelled) setReferralLoading(false)
      }
    })()

    return () => {
      cancelled = true
      if (pollInterval) clearInterval(pollInterval)
    }
  }, [])

  // Load notification preference from Firebase on mount.
  React.useEffect(() => {
    const deviceId = getDeviceId()
    if ('Notification' in window) {
      setNotifEnabled(Notification.permission === 'granted')
    }
    fetch(`/api/notifications?deviceId=${deviceId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.enabled) setNotifEnabled(true)
        if (data.frequency === 'all') setNotifFrequency('all')
      })
      .catch(() => {})
  }, [])

  // ── Toggle a subtopic interest on/off ──
  // Uses the existing interests system: setInterestsLocal + syncInterestsWithFirebase.
  // Dispatches the 'neutralwire:interests-changed' event so the main feed
  // (page-client.tsx) picks up the change immediately and re-personalizes.
  const handleToggleInterest = (id: string, checked: boolean) => {
    const current = new Set(interests)
    if (checked) {
      current.add(id)
    } else {
      current.delete(id)
    }
    const next = Array.from(current)
    setInterests(next)
    setInterestsLocal(next)
    const deviceId = getDeviceId()
    if (deviceId) {
      syncInterestsWithFirebase(deviceId, next)
    }
    window.dispatchEvent(new CustomEvent('neutralwire:interests-changed'))
  }

  // ── Reset personalization ──
  // Clears all interests + dispatches the change event.
  const handleResetPersonalization = () => {
    setInterests([])
    setInterestsLocal([])
    const deviceId = getDeviceId()
    if (deviceId) {
      syncInterestsWithFirebase(deviceId, [])
    }
    window.dispatchEvent(new CustomEvent('neutralwire:interests-changed'))
  }

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(referralUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // silent
    }
  }

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Join me on NeutralWire',
          text: 'Get neutral news from across the political spectrum. Compare how left, center, and right outlets cover the same stories.',
          url: referralUrl,
        })
      } catch {
        // cancelled
      }
    } else {
      handleCopyLink()
    }
  }

  // ── Notifications ──
  const syncNotifToFirebase = (newEnabled: boolean, newFrequency?: 'daily3' | 'all') => {
    const deviceId = getDeviceId()
    fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        enabled: newEnabled,
        frequency: newFrequency || notifFrequency,
      }),
    }).catch(() => {})
  }

  const handleEnableNotifications = async () => {
    setNotifLoading(true)
    try {
      if ('Notification' in window) {
        const permission = await Notification.requestPermission()
        if (permission === 'granted') {
          setNotifEnabled(true)
          syncNotifToFirebase(true)
          // Subscribe to push (same logic as referral-dialog NotificationEnabler).
          if ('serviceWorker' in navigator && 'PushManager' in window) {
            const reg = await navigator.serviceWorker.ready
            let subscription = await reg.pushManager.getSubscription()
            if (!subscription) {
              const vapidRes = await fetch('/api/push/vapid')
              const { publicKey } = await vapidRes.json()
              if (publicKey) {
                const key = urlBase64ToUint8Array(publicKey)
                subscription = await reg.pushManager.subscribe({
                  userVisibleOnly: true,
                  applicationServerKey: key,
                })
              }
            }
            if (subscription) {
              const deviceId = getDeviceId()
              await fetch('/api/push/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  deviceId,
                  subscription: subscription.toJSON(),
                }),
              })
            }
          }
        }
      }
    } catch {
      // silent
    } finally {
      setNotifLoading(false)
    }
  }

  const handleFrequencyChange = (newFreq: 'daily3' | 'all') => {
    setNotifFrequency(newFreq)
    syncNotifToFirebase(notifEnabled, newFreq)
    if ('serviceWorker' in navigator && notifEnabled) {
      navigator.serviceWorker.ready
        .then((reg) =>
          reg.active?.postMessage({
            type: 'SET_FREQUENCY',
            frequency: newFreq,
          }),
        )
        .catch(() => {})
    }
  }

  return (
    <motion.div
      ref={pageRef}
      className="fixed inset-0 z-50 overflow-y-auto bg-background"
      role="dialog"
      aria-modal="true"
      aria-label="Account"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 24 }}
      transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
    >
      {/* Sticky top bar */}
      <div className="glass sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
        <Button variant="ghost" size="sm" onClick={onClose} className="gap-1.5 flex-shrink-0">
          <X className="h-4 w-4" />
          <span className="hidden sm:inline">Close</span>
        </Button>
        <div className="ml-auto flex items-center gap-1.5 text-sm font-semibold">
          <UserCircle className="h-4 w-4" />
          Account
        </div>
      </div>

      {/* ── Sticky tab bar ──
          Pinned directly under the header, ALWAYS in view. Four tabs, one
          tap each — replaces the old "scroll a meter to reach the
          notification settings" experience. */}
      <div className="sticky top-14 z-10 border-b bg-background/95 backdrop-blur">
        <div
          className="mx-auto grid max-w-2xl grid-cols-4 gap-1 px-2 py-1.5"
          role="tablist"
          aria-label="Account sections"
        >
          {TABS.map((t) => {
            const isActive = tab === t.id
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => switchTab(t.id)}
                className={cn(
                  'relative flex flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1.5 text-[11px] font-semibold transition-colors',
                  isActive
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <span
                  className={cn(
                    'flex h-7 w-9 items-center justify-center rounded-md transition-colors',
                    isActive ? 'bg-foreground/10' : '',
                  )}
                >
                  {t.icon}
                </span>
                {t.label}
                {/* Active indicator — slides under the active tab. */}
                {isActive && (
                  <motion.span
                    layoutId="account-tab-underline"
                    className="absolute bottom-0 left-3 right-3 h-0.5 rounded-full bg-foreground"
                    transition={{ duration: 0.25, ease: EASE_OUT }}
                  />
                )}
              </button>
            )
          })}
        </div>
      </div>

      <div className="mx-auto max-w-2xl px-4 pb-8 pt-4">
        {/* Tab content — quick fade/slide on switch, no long staggered
            reveals (the page is meant to feel instant now). */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: EASE_OUT }}
            role="tabpanel"
          >
            {/* ═══════════════════ PROFILE ═══════════════════ */}
            {tab === 'profile' && (
              <div className="space-y-4">
                {/* Identity — compact single row */}
                <Card className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
                      <UserCircle className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-semibold uppercase text-muted-foreground tracking-wider">
                        Signed in as
                      </div>
                      <div className="truncate text-lg font-bold leading-tight">{guestName}</div>
                    </div>
                    <div className="hidden sm:block">
                      <Badge variant="secondary" className="text-[10px]">Guest — no login</Badge>
                    </div>
                  </div>
                  <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
                    Your guest ID keeps your feed, streaks, and referrals on this
                    device — no account, no email, nothing personal.
                  </p>
                </Card>

                {/* Refer others — compact */}
                <Card className="p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <Gift className="h-4 w-4 text-amber-500" />
                    <h2 className="text-sm font-bold">Refer others</h2>
                    {stats && (
                      <div className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <Users className="h-3 w-3" />
                          {stats.totalClicks}
                        </span>
                        <span aria-hidden>·</span>
                        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                          <Check className="h-3 w-3" />
                          {stats.successfulReferrals}
                        </span>
                      </div>
                    )}
                  </div>

                  {referralLoading ? (
                    <div className="rounded-lg border p-4 text-center text-xs text-muted-foreground">
                      Generating your referral link…
                    </div>
                  ) : referralCode ? (
                    <>
                      {/* Code + link + actions — one compact block */}
                      <div className="mb-2 flex items-center justify-center gap-2 rounded-lg bg-muted/40 py-2">
                        <span className="text-[10px] font-semibold uppercase text-muted-foreground">
                          Code
                        </span>
                        <span className="font-mono text-base font-bold tracking-widest">
                          {referralCode}
                        </span>
                      </div>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={referralUrl}
                          readOnly
                          className="min-w-0 flex-1 rounded-md border bg-muted/30 px-3 py-2 text-xs font-mono"
                          onFocus={(e) => e.target.select()}
                        />
                        <Button
                          size="sm"
                          onClick={handleCopyLink}
                          className="gap-1.5 flex-shrink-0"
                          aria-label="Copy referral link"
                        >
                          {copied ? (
                            <Check className="h-4 w-4" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                          <span className="hidden sm:inline">{copied ? 'Copied!' : 'Copy'}</span>
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleShare}
                          className="gap-1.5 flex-shrink-0"
                          aria-label="Share referral link"
                        >
                          <Share2 className="h-4 w-4" />
                          <span className="hidden sm:inline">Share</span>
                        </Button>
                      </div>
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        When friends install the app and use it for 3 days, it
                        counts as a successful referral.
                      </p>
                    </>
                  ) : (
                    <div className="rounded-lg border p-4 text-center text-xs text-muted-foreground">
                      Could not load your referral code. Check your connection
                      and reopen this page.
                    </div>
                  )}
                </Card>

                {/* Privacy — link row (full policy lives at /privacy) */}
                <a
                  href="/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 rounded-xl border p-3.5 transition-colors hover:bg-muted/40"
                >
                  <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">Privacy policy</div>
                    <div className="text-[11px] text-muted-foreground">
                      Everything NeutralWire collects, where it lives, how to
                      delete it.
                    </div>
                  </div>
                  <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </a>
              </div>
            )}

            {/* ═══════════════════ FEED ═══════════════════ */}
            {tab === 'feed' && (
              <div className="space-y-4">
                {/* Ultra-personalize — chip grid instead of 9 tall rows */}
                <Card className="p-4">
                  <div className="mb-1 flex items-center gap-2">
                    <Target className="h-4 w-4 text-blue-500" />
                    <h2 className="text-sm font-bold">Personalize your feed</h2>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {interests.length}/8 selected
                    </span>
                  </div>
                  <p className="mb-3 text-xs text-muted-foreground">
                    Tap the subtopics you care about — stories matching them get
                    boosted in your Relevant feed and daily briefing.
                  </p>

                  <div className="grid grid-cols-3 gap-2">
                    {PERSONALIZE_TOPICS.map((t, i) => {
                      const isOn = interests.includes(t.id)
                      return (
                        <motion.button
                          key={t.id}
                          type="button"
                          onClick={() => handleToggleInterest(t.id, !isOn)}
                          aria-pressed={isOn}
                          aria-label={`Toggle ${t.label}`}
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.2, delay: i * 0.02, ease: EASE_OUT }}
                          className={cn(
                            'relative flex flex-col items-center gap-1 rounded-lg border py-2.5 transition-all active:scale-95',
                            isOn
                              ? 'border-foreground/30 bg-foreground/5 ring-1 ring-foreground/20'
                              : 'border-border hover:bg-muted/40',
                          )}
                        >
                          <span className="text-lg" aria-hidden>{t.emoji}</span>
                          <span className="text-xs font-medium leading-tight text-center">
                            {t.label}
                          </span>
                          {isOn && (
                            <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-[8px] font-bold text-background">
                              ✓
                            </span>
                          )}
                        </motion.button>
                      )
                    })}
                  </div>

                  <div className="mt-3 flex items-center justify-between">
                    <div className="text-[11px] text-muted-foreground">
                      {interests.length === 0
                        ? 'No interests — feed shows general news.'
                        : 'Saved. Your feed updates instantly.'}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleResetPersonalization}
                      disabled={interests.length === 0}
                      className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Reset
                    </Button>
                  </div>
                </Card>

                {/* Feature flags — your header style + admin default */}
                <FeatureFlagsCard />
              </div>
            )}

            {/* ═══════════════════ THEME ═══════════════════ */}
            {tab === 'theme' && (
              <div className="space-y-4">
                <Card className="p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <Palette className="h-4 w-4 text-purple-500" />
                    <h2 className="text-sm font-bold">Theme</h2>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      Auto follows your device
                    </span>
                  </div>

                  {/* Solid themes (mode control + family grid) */}
                  <ThemeSwitcher />

                  {/* Gradient presets */}
                  <div className="mt-4 border-t pt-4">
                    <h3 className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Gradient backgrounds
                    </h3>
                    <div className="grid grid-cols-3 gap-2">
                      {GRADIENT_PRESETS.map((g) => (
                        <GradientPreset key={g.id} id={g.id} label={g.label} gradient={g.gradient} />
                      ))}
                    </div>
                  </div>

                  {/* Custom gradient maker — collapsed by default (it's the
                      longest control; one tap unfolds it). */}
                  <button
                    type="button"
                    onClick={() => setShowGradientMaker((v) => !v)}
                    aria-expanded={showGradientMaker}
                    className="mt-3 flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Custom gradient maker
                    <ChevronDown
                      className={cn(
                        'ml-auto h-4 w-4 transition-transform',
                        showGradientMaker && 'rotate-180',
                      )}
                    />
                  </button>
                  <AnimatePresence initial={false}>
                    {showGradientMaker && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.25, ease: EASE_OUT }}
                        className="overflow-hidden"
                      >
                        <CustomGradientMaker />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </Card>
              </div>
            )}

            {/* ═══════════════════ ALERTS ═══════════════════ */}
            {tab === 'alerts' && (
              <div className="space-y-4">
                <Card className="p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <Bell className="h-4 w-4 text-cyan-500" />
                    <h2 className="text-sm font-bold">Notifications</h2>
                  </div>
                  {!notifEnabled ? (
                    <>
                      <p className="mb-3 text-xs text-muted-foreground">
                        3 news notifications every day — morning, lunch, and
                        evening. Never miss an important story.
                      </p>
                      <Button
                        size="sm"
                        onClick={handleEnableNotifications}
                        disabled={notifLoading}
                        className="gap-1.5"
                      >
                        <Bell className="h-4 w-4" />
                        {notifLoading ? 'Enabling…' : 'Enable notifications'}
                      </Button>
                    </>
                  ) : (
                    <>
                      <div className="mb-3 flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
                        <Check className="h-3.5 w-3.5" />
                        Notifications enabled
                      </div>
                      <div className="mb-2 text-xs font-medium text-muted-foreground">
                        How often do you want news alerts?
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={() => handleFrequencyChange('daily3')}
                          className={cn(
                            'rounded-lg border p-3 text-left transition-all',
                            notifFrequency === 'daily3'
                              ? 'border-foreground bg-foreground/5 ring-1 ring-foreground/20'
                              : 'hover:bg-muted/50',
                          )}
                        >
                          <div className="text-sm font-semibold">3 per day</div>
                          <div className="text-[10px] text-muted-foreground">
                            Morning, lunch & evening
                          </div>
                        </button>
                        <button
                          onClick={() => handleFrequencyChange('all')}
                          className={cn(
                            'rounded-lg border p-3 text-left transition-all',
                            notifFrequency === 'all'
                              ? 'border-foreground bg-foreground/5 ring-1 ring-foreground/20'
                              : 'hover:bg-muted/50',
                          )}
                        >
                          <div className="text-sm font-semibold">All news</div>
                          <div className="text-[10px] text-muted-foreground">
                            Every new story (non-stop)
                          </div>
                        </button>
                      </div>
                    </>
                  )}
                </Card>

                {/* Support — compact single row + button */}
                <Card className="p-4">
                  <div className="mb-2.5 flex items-center gap-2">
                    <Heart className="h-4 w-4 fill-pink-400 text-pink-500" strokeWidth={2} />
                    <h2 className="text-sm font-bold">Support NeutralWire</h2>
                  </div>
                  <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                    Free, ad-free, paywall-free. A coffee on Ko-fi covers the
                    server + AI costs.
                  </p>
                  <a
                    href="https://ko-fi.com/neutralwire"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 rounded-md bg-pink-500 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-pink-600 active:scale-95 transition-all"
                  >
                    <Heart className="h-4 w-4 fill-white" strokeWidth={2} />
                    Donate on Ko-fi
                    <ExternalLink className="h-3.5 w-3.5 opacity-80" />
                  </a>
                </Card>

                {/* Footer note */}
                <div className="px-1 pb-2 text-center text-[11px] text-muted-foreground">
                  <Sparkles className="inline-block h-3 w-3 mr-1 -mt-0.5" />
                  All settings are saved automatically to this device.
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

/**
 * Convert a base64 URL string to a Uint8Array (needed for the Push API).
 * Local copy of the same helper in referral-dialog.tsx — keeps the user
 * page self-contained.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const output = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    output[i] = rawData.charCodeAt(i)
  }
  return output
}

// Re-export so consumers can use AnimatePresence with the user page (the
// exit animation needs to be wrapped).
export const UserPageAnimatePresence = AnimatePresence

// ── Gradient preset button ──
// Shows the gradient as a swatch; clicking it applies the gradient as a
// background overlay on top of the dark theme.
function GradientPreset({ id, label, gradient }: {
  id: string
  label: string
  gradient: string
}) {
  const { setTheme } = useTheme()
  const [active, setActive] = React.useState(false)

  // Check if this gradient is the active one on mount + when any gradient changes
  const checkActive = React.useCallback(() => {
    try {
      const stored = localStorage.getItem('neutralwire:gradient')
      setActive(stored === gradient)
    } catch {}
  }, [gradient])

  React.useEffect(() => {
    checkActive()
    // Listen for gradient changes from other components (CustomGradientMaker,
    // other GradientPresets) so only one shows as active at a time.
    window.addEventListener('neutralwire:gradient-changed', checkActive)
    return () => window.removeEventListener('neutralwire:gradient-changed', checkActive)
  }, [checkActive])

  const handleClick = () => {
    try {
      // Gradients sit on a dark base: record neutral-family + dark mode
      // so the mode toggle / auto system flips behave correctly.
      setThemeFamilyStored('neutral')
      setThemeModeStored('dark')
      // Set dark theme as the base (clears any solid theme via next-themes)
      setTheme('dark')
      // Apply the gradient
      document.documentElement.classList.add('gradient-theme')
      document.documentElement.style.setProperty('--gradient-bg', gradient)
      localStorage.setItem('neutralwire:gradient', gradient)
      // Notify all gradient components to update their active state
      window.dispatchEvent(new CustomEvent('neutralwire:gradient-changed'))
    } catch {}
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'group relative flex flex-col items-center gap-1 rounded-lg border p-1.5 transition-all active:scale-95',
        active
          ? 'border-foreground ring-2 ring-foreground/20'
          : 'border-border hover:border-foreground/30',
      )}
    >
      <span
        className="h-8 w-full rounded-md"
        style={{ background: gradient }}
        aria-hidden
      />
      <span className="text-[10px] font-medium leading-tight text-center">{label}</span>
      {active && (
        <span className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-background text-[8px] font-bold">
          ✓
        </span>
      )}
    </button>
  )
}

// ── Custom gradient maker ──
// Lets the user pick 2-3 colors + angle and creates a custom gradient.
function CustomGradientMaker() {
  const { setTheme } = useTheme()
  const [color1, setColor1] = React.useState('#1a1a2e')
  const [color2, setColor2] = React.useState('#16213e')
  const [color3, setColor3] = React.useState('#0f3460')
  const [useThirdColor, setUseThirdColor] = React.useState(true)
  const [angle, setAngle] = React.useState(135)

  const gradient = useThirdColor
    ? `linear-gradient(${angle}deg, ${color1} 0%, ${color2} 50%, ${color3} 100%)`
    : `linear-gradient(${angle}deg, ${color1} 0%, ${color2} 100%)`

  const handleApply = () => {
    try {
      // Gradients sit on a dark base: record neutral-family + dark mode.
      setThemeFamilyStored('neutral')
      setThemeModeStored('dark')
      setTheme('dark')
      document.documentElement.classList.add('gradient-theme')
      document.documentElement.style.setProperty('--gradient-bg', gradient)
      localStorage.setItem('neutralwire:gradient', gradient)
      // Notify all gradient components to update their active state
      window.dispatchEvent(new CustomEvent('neutralwire:gradient-changed'))
    } catch {}
  }

  return (
    <div className="mt-3">
      <p className="mb-2 text-xs text-muted-foreground">
        Pick your own colors + angle for a unique gradient background.
      </p>

      {/* Live preview */}
      <div
        className="mb-3 h-14 w-full rounded-lg border border-border"
        style={{ background: gradient }}
      />

      {/* Color pickers */}
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div>
          <label className="text-[10px] text-muted-foreground block mb-1">Color 1</label>
          <input
            type="color"
            value={color1}
            onChange={(e) => setColor1(e.target.value)}
            className="w-full h-9 rounded-md border border-border cursor-pointer bg-transparent"
          />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground block mb-1">Color 2</label>
          <input
            type="color"
            value={color2}
            onChange={(e) => setColor2(e.target.value)}
            className="w-full h-9 rounded-md border border-border cursor-pointer bg-transparent"
          />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground block mb-1">
            Color 3 {useThirdColor ? '' : '(off)'}
          </label>
          <input
            type="color"
            value={color3}
            onChange={(e) => setColor3(e.target.value)}
            disabled={!useThirdColor}
            className={cn(
              'w-full h-9 rounded-md border border-border cursor-pointer bg-transparent',
              !useThirdColor && 'opacity-30',
            )}
          />
        </div>
      </div>

      {/* Toggle 3rd color + angle slider */}
      <div className="flex items-center gap-4 mb-3">
        <label className="flex items-center gap-2 text-xs">
          <Switch checked={useThirdColor} onCheckedChange={setUseThirdColor} />
          <span>3rd color</span>
        </label>
        <label className="flex items-center gap-2 text-xs flex-1">
          <span className="text-muted-foreground whitespace-nowrap">Angle: {angle}°</span>
          <input
            type="range"
            min={0}
            max={360}
            value={angle}
            onChange={(e) => setAngle(Number(e.target.value))}
            className="flex-1 accent-foreground"
          />
        </label>
      </div>

      <Button onClick={handleApply} size="sm" className="w-full">
        Apply Custom Gradient
      </Button>
    </div>
  )
}
