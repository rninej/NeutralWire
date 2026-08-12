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
  TrendingUp,
  Palette,
  Target,
  ExternalLink,
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

// Easing curve shared across the page sections.
const EASE_OUT = [0.16, 1, 0.3, 1] as const

export function UserPage({ onClose }: UserPageProps) {
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

  // Lock body scroll when open.
  React.useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
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

  // Section reveal animation: staggered fade-in + slide-up.
  const sectionMotion = (delay: number) => ({
    initial: { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.35, delay, ease: EASE_OUT },
  })

  return (
    <motion.div
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
      <div className="glass sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
        <Button variant="ghost" size="sm" onClick={onClose} className="gap-1.5 flex-shrink-0">
          <X className="h-4 w-4" />
          <span className="hidden sm:inline">Close</span>
        </Button>
        <div className="ml-auto flex items-center gap-1.5 text-sm font-semibold">
          <UserCircle className="h-4 w-4" />
          Account
        </div>
      </div>

      <div className="mx-auto max-w-2xl px-4 py-6 space-y-5">
        {/* ── Guest name ── */}
        <motion.div {...sectionMotion(0)}>
          <Card className="p-5">
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-foreground text-background">
                <UserCircle className="h-7 w-7" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold uppercase text-muted-foreground tracking-wider">
                  Signed in as
                </div>
                <div className="text-xl font-bold truncate">{guestName}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Your guest ID is used to personalize your feed + track your
                  referrals. No login required.
                </div>
              </div>
            </div>
          </Card>
        </motion.div>

        {/* ── Refer others ── */}
        <motion.div {...sectionMotion(0.05)}>
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <Gift className="h-4 w-4 text-amber-500" />
              <h2 className="text-sm font-bold">Refer others</h2>
            </div>
            <p className="mb-4 text-xs text-muted-foreground">
              Share your referral link. When friends install the app and use it
              for 3 days, you help grow the NeutralWire community.
            </p>

            {/* Stats */}
            {stats && (
              <div className="mb-4 grid grid-cols-2 gap-3">
                <div className="rounded-lg border p-3 text-center">
                  <Users className="mx-auto mb-1 h-4 w-4 text-muted-foreground" />
                  <div className="text-xl font-bold">{stats.totalClicks}</div>
                  <div className="text-[10px] text-muted-foreground">Link clicks</div>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <Check className="mx-auto mb-1 h-4 w-4 text-emerald-500" />
                  <div className="text-xl font-bold">{stats.successfulReferrals}</div>
                  <div className="text-[10px] text-muted-foreground">Successful</div>
                </div>
              </div>
            )}

            {referralLoading ? (
              <div className="rounded-lg border p-4 text-center text-xs text-muted-foreground">
                Generating your referral link…
              </div>
            ) : referralCode ? (
              <>
                <div className="mb-2 text-[10px] font-semibold uppercase text-muted-foreground">
                  Your referral code
                </div>
                <div className="mb-3 text-2xl font-bold tracking-widest text-center font-mono py-2 rounded-md bg-muted/40">
                  {referralCode}
                </div>
                <div className="mb-2 text-[10px] font-semibold uppercase text-muted-foreground">
                  Your referral link
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={referralUrl}
                    readOnly
                    className="flex-1 rounded-md border bg-muted/30 px-3 py-2 text-xs font-mono"
                    onFocus={(e) => e.target.select()}
                  />
                  <Button
                    size="sm"
                    onClick={handleCopyLink}
                    className="gap-1.5 flex-shrink-0"
                  >
                    {copied ? (
                      <>
                        <Check className="h-4 w-4" />
                        <span className="hidden sm:inline">Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-4 w-4" />
                        <span className="hidden sm:inline">Copy</span>
                      </>
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleShare}
                    className="gap-1.5 flex-shrink-0"
                  >
                    <Share2 className="h-4 w-4" />
                    <span className="hidden sm:inline">Share</span>
                  </Button>
                </div>
              </>
            ) : (
              <div className="rounded-lg border p-4 text-center text-xs text-muted-foreground">
                Could not load your referral code. Check your connection and
                reopen this page.
              </div>
            )}
          </Card>
        </motion.div>

        {/* ── Ultra-personalize feed ── */}
        <motion.div {...sectionMotion(0.1)}>
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <Target className="h-4 w-4 text-blue-500" />
              <h2 className="text-sm font-bold">Ultra-personalize feed</h2>
            </div>
            <p className="mb-4 text-xs text-muted-foreground">
              Toggle the subtopics you care about. We&apos;ll boost stories
              matching your interests in your Relevant feed. Your picks also
              shape the daily notification briefing.
            </p>

            <div className="space-y-1.5">
              {PERSONALIZE_TOPICS.map((t, i) => {
                const isOn = interests.includes(t.id)
                return (
                  <motion.div
                    key={t.id}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.25, delay: 0.12 + i * 0.03, ease: EASE_OUT }}
                    className={cn(
                      'flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                      isOn ? 'border-foreground/30 bg-foreground/5' : 'border-border hover:bg-muted/40',
                    )}
                  >
                    <span className="text-lg" aria-hidden>{t.emoji}</span>
                    <span className="flex-1 text-sm font-medium">{t.label}</span>
                    <Switch
                      checked={isOn}
                      onCheckedChange={(checked) => handleToggleInterest(t.id, checked)}
                      aria-label={`Toggle ${t.label}`}
                    />
                  </motion.div>
                )
              })}
            </div>

            <div className="mt-4 flex items-center justify-between">
              <div className="text-[11px] text-muted-foreground">
                {interests.length === 0
                  ? 'No interests selected — feed shows general news.'
                  : `${interests.length} ${interests.length === 1 ? 'interest' : 'interests'} selected.`}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleResetPersonalization}
                disabled={interests.length === 0}
                className="gap-1.5 text-muted-foreground hover:text-foreground"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset personalization
              </Button>
            </div>
          </Card>
        </motion.div>

        {/* ── Theme switcher ── */}
        <motion.div {...sectionMotion(0.15)}>
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <Palette className="h-4 w-4 text-purple-500" />
              <h2 className="text-sm font-bold">Theme</h2>
            </div>
            <p className="mb-4 text-xs text-muted-foreground">
              Pick a color scheme. Switching uses a circular reveal from where
              you tap.
            </p>
            <ThemeSwitcher />
          </Card>
        </motion.div>

        {/* ── Notifications ── */}
        <motion.div {...sectionMotion(0.2)}>
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <Bell className="h-4 w-4 text-cyan-500" />
              <h2 className="text-sm font-bold">Notifications</h2>
            </div>
            {!notifEnabled ? (
              <>
                <p className="mb-3 text-xs text-muted-foreground">
                  Get 3 news notifications every day — morning, lunch, and
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
        </motion.div>

        {/* ── Support NeutralWire (Ko-fi) ── */}
        <motion.div {...sectionMotion(0.25)}>
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <Heart className="h-4 w-4 fill-pink-400 text-pink-500" strokeWidth={2} />
              <h2 className="text-sm font-bold">Support NeutralWire</h2>
            </div>
            <p className="mb-4 text-xs text-muted-foreground">
              NeutralWire is free, ad-free, and paywall-free. If you find it
              useful, consider buying us a coffee on Ko-fi. Every contribution
              helps cover server + AI costs.
            </p>
            <a
              href="https://ko-fi.com/neutralwire"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-md bg-pink-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-pink-600 active:scale-95 transition-all"
            >
              <Heart className="h-4 w-4 fill-white" strokeWidth={2} />
              Donate on Ko-fi
              <ExternalLink className="h-3.5 w-3.5 opacity-80" />
            </a>
          </Card>
        </motion.div>

        {/* ── Footer / how-it-works hint ── */}
        <motion.div
          {...sectionMotion(0.3)}
          className="px-1 pb-4 text-center text-[11px] text-muted-foreground"
        >
          <Sparkles className="inline-block h-3 w-3 mr-1 -mt-0.5" />
          All settings are saved automatically to this device.
        </motion.div>
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
