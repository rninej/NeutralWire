'use client'

import * as React from 'react'
import {
  X,
  Gift,
  Users,
  Smartphone,
  Calendar,
  Clock,
  Share2,
  Check,
  Copy,
  TrendingUp,
  Bell,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { getDeviceId, buildReferralUrl } from '@/lib/referral'

interface ReferralDialogProps {
  onClose: () => void
}

interface ReferralStats {
  totalClicks: number
  successfulReferrals: number
}

export function ReferralDialog({ onClose }: ReferralDialogProps) {
  const [referralCode, setReferralCode] = React.useState<string | null>(null)
  const [referralUrl, setReferralUrl] = React.useState<string>('')
  const [stats, setStats] = React.useState<ReferralStats | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  React.useEffect(() => {
    let cancelled = false
    let pollInterval: ReturnType<typeof setInterval>

    ;(async () => {
      const deviceId = getDeviceId()
      // Check localStorage for an existing code (persisted across sessions).
      const existingCode =
        typeof window !== 'undefined'
          ? localStorage.getItem('neutralwire:my-referral-code')
          : null

      try {
        // Create or retrieve referral code. Send existingCode so the
        // server can verify and return it instead of generating a new one.
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
          // Persist in localStorage so we never regenerate it.
          localStorage.setItem('neutralwire:my-referral-code', data.code)
        }

        // Fetch stats — and poll every 10 seconds for live updates.
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
        pollInterval = setInterval(fetchStats, 10000)
      } catch {
        // silent
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      clearInterval(pollInterval)
    }
  }, [])

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

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-background"
      role="dialog"
      aria-modal="true"
      aria-label="Refer a friend"
    >
      {/* Top bar */}
      <div className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
        <Button variant="ghost" size="sm" onClick={onClose} className="gap-1.5">
          <X className="h-4 w-4" />
          <span className="hidden sm:inline">Close</span>
        </Button>
        <div className="ml-auto flex items-center gap-1.5 text-sm font-semibold">
          <Gift className="h-4 w-4" />
          Refer & Earn
        </div>
      </div>

      <div className="mx-auto max-w-2xl px-4 py-6">
        {/* Header */}
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-foreground text-background">
            <Gift className="h-8 w-8" />
          </div>
          <h1 className="text-2xl font-bold">Refer Friends to NeutralWire</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Share your referral link. When friends install the app and use it
            for 3 days, you both help grow the NeutralWire community.
          </p>
        </div>

        {/* Stats */}
        {stats && (
          <div className="mb-6 grid grid-cols-2 gap-3">
            <Card className="p-4 text-center">
              <Users className="mx-auto mb-1 h-5 w-5 text-muted-foreground" />
              <div className="text-2xl font-bold">{stats.totalClicks}</div>
              <div className="text-xs text-muted-foreground">Link clicks</div>
            </Card>
            <Card className="p-4 text-center">
              <Check className="mx-auto mb-1 h-5 w-5 text-emerald-500" />
              <div className="text-2xl font-bold">{stats.successfulReferrals}</div>
              <div className="text-xs text-muted-foreground">Successful</div>
            </Card>
          </div>
        )}

        {/* Referral link */}
        {loading ? (
          <Card className="mb-6 p-6 text-center text-sm text-muted-foreground">
            Generating your referral link…
          </Card>
        ) : referralCode ? (
          <Card className="mb-6 p-5">
            <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
              Your referral code
            </div>
            <div className="mb-4 text-3xl font-bold tracking-widest text-center">
              {referralCode}
            </div>
            <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
              Your referral link
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={referralUrl}
                readOnly
                className="flex-1 rounded-md border bg-muted/30 px-3 py-2 text-xs"
                onFocus={(e) => e.target.select()}
              />
              <Button size="sm" onClick={handleCopyLink} className="gap-1.5">
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
              <Button size="sm" variant="outline" onClick={handleShare} className="gap-1.5">
                <Share2 className="h-4 w-4" />
                <span className="hidden sm:inline">Share</span>
              </Button>
            </div>
          </Card>
        ) : null}

        {/* Rules */}
        <Card className="mb-6 p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold">
            <TrendingUp className="h-4 w-4" />
            How it works
          </h2>
          <div className="space-y-3">
            <Rule
              icon={<Share2 className="h-4 w-4" />}
              title="Share your link"
              desc="Send your referral link to friends via WhatsApp, text, or social media."
            />
            <Rule
              icon={<Smartphone className="h-4 w-4" />}
              title="They install the app"
              desc="Your friend opens the link on their phone and installs the NeutralWire PWA."
            />
            <Rule
              icon={<Calendar className="h-4 w-4" />}
              title="They use it for 3 days"
              desc="Your friend needs to open the app on 3 different days (doesn't need to be consecutive)."
            />
            <Rule
              icon={<Clock className="h-4 w-4" />}
              title="At least 15 seconds per day"
              desc="Each day they need to spend at least 15 seconds reading news."
            />
            <Rule
              icon={<Users className="h-4 w-4" />}
              title="Different device or IP"
              desc="Each referral must come from a different device or IP address to count."
            />
          </div>
        </Card>

        {/* Notifications */}
        <Card className="p-5">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-bold">
            <Bell className="h-4 w-4" />
            Daily Notifications
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Get 3 news notifications every day — morning, lunch, and evening.
            Enable them below so you don't miss important stories.
          </p>
          <NotificationEnabler />
        </Card>
      </div>
    </div>
  )
}

function Rule({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode
  title: string
  desc: string
}) {
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
        {icon}
      </div>
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{desc}</div>
      </div>
    </div>
  )
}

function NotificationEnabler() {
  const [enabled, setEnabled] = React.useState(false)
  const [frequency, setFrequency] = React.useState<'daily3' | 'all'>('daily3')
  const [loading, setLoading] = React.useState(false)
  const [deviceChecked, setDeviceChecked] = React.useState(false)

  // Check both browser permission AND Firebase status.
  React.useEffect(() => {
    const deviceId = getDeviceId()
    // Check browser permission.
    if ('Notification' in window) {
      setEnabled(Notification.permission === 'granted')
    }
    // Check Firebase for the stored status + frequency preference.
    fetch(`/api/notifications?deviceId=${deviceId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.enabled) setEnabled(true)
        if (data.frequency === 'all') setFrequency('all')
      })
      .catch(() => {})
      .finally(() => setDeviceChecked(true))
  }, [])

  const syncToFirebase = (
    newEnabled: boolean,
    newFrequency?: 'daily3' | 'all',
  ) => {
    const deviceId = getDeviceId()
    fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        enabled: newEnabled,
        frequency: newFrequency || frequency,
      }),
    }).catch(() => {})
  }

  const handleEnable = async () => {
    setLoading(true)
    try {
      if ('Notification' in window) {
        const permission = await Notification.requestPermission()
        if (permission === 'granted') {
          setEnabled(true)
          syncToFirebase(true)
          if ('serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.ready
            reg.active?.postMessage({ type: 'SCHEDULE_NOTIFICATIONS' })
          }
        }
      }
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }

  const handleFrequencyChange = (newFreq: 'daily3' | 'all') => {
    setFrequency(newFreq)
    syncToFirebase(enabled, newFreq)
    // Tell the service worker about the frequency change.
    if ('serviceWorker' in navigator && enabled) {
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

  if (!enabled) {
    return (
      <Button size="sm" onClick={handleEnable} disabled={loading} className="gap-1.5">
        <Bell className="h-4 w-4" />
        {loading ? 'Enabling…' : 'Enable notifications'}
      </Button>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-emerald-600">
        <Check className="h-4 w-4" />
        Notifications enabled
      </div>
      <div className="text-xs font-medium text-muted-foreground">
        How often do you want news alerts?
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => handleFrequencyChange('daily3')}
          className={cn(
            'flex-1 rounded-lg border p-3 text-left transition-colors',
            frequency === 'daily3'
              ? 'border-foreground bg-foreground/5'
              : 'hover:bg-muted',
          )}
        >
          <div className="text-sm font-semibold">3 per day</div>
          <div className="text-[11px] text-muted-foreground">
            Morning, lunch & evening
          </div>
        </button>
        <button
          onClick={() => handleFrequencyChange('all')}
          className={cn(
            'flex-1 rounded-lg border p-3 text-left transition-colors',
            frequency === 'all'
              ? 'border-foreground bg-foreground/5'
              : 'hover:bg-muted',
          )}
        >
          <div className="text-sm font-semibold">All news</div>
          <div className="text-[11px] text-muted-foreground">
            Every new story (non-stop)
          </div>
        </button>
      </div>
    </div>
  )
}
