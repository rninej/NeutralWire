'use client'

/**
 * subscription-account.tsx — the Account page's subscription surfaces.
 *
 * • SubscriptionAccountSection (Profile tab) — the tier card: sign in /
 *   create account (email+password, Google, Apple), current tier + renewal,
 *   cancel, upgrade/change tier, and for Ultra the API key manager.
 * • DigestPrefsCard (Alerts tab) — the AI email digest: enabled toggle,
 *   frequency (weekly → 3x daily) + send-hour picker. Premium gate.
 * • PersonalFlagsCard (Feed tab) — Premium personal feature flags that
 *   actually DO things: compact cards, hide Blindspots, larger text.
 */

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  Loader2, LogOut, Check, Copy, KeyRound, Mail, Lock, Crown, Sparkles, Send,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { PremiumDiamond, PremiumBadge, TierComparisonGrid, CurrentPlanFeatures } from '@/components/premium-ui'
import {
  useSubscription,
  openUpgradeDialog,
  SUBSCRIPTION_CHANGED_EVENT,
  getClientDeviceId,
} from '@/lib/subscription-client'

const EASE_OUT = [0.16, 1, 0.3, 1] as const

/** Fired by the Account-page guest banner ("Create an account") to open
 *  the auth form in this card with the wanted mode. */
export const OPEN_AUTH_EVENT = 'neutralwire:open-auth'

// ── Profile tab: the tier card ──────────────────────────────────────────

export function SubscriptionAccountSection() {
  const sub = useSubscription()
  const [mode, setMode] = React.useState<'none' | 'signin' | 'register'>('none')
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [apiKey, setApiKey] = React.useState<string | null>(null)
  const [keyBusy, setKeyBusy] = React.useState(false)
  const [keyCopied, setKeyCopied] = React.useState(false)
  const [cancelBusy, setCancelBusy] = React.useState(false)
  // Brief highlight when the guest banner routes here — the form flipping
  // in BELOW THE FOLD used to look like "the button did nothing".
  const [spotlit, setSpotlit] = React.useState(false)
  const cardRef = React.useRef<HTMLDivElement | null>(null)

  const deviceId = getClientDeviceId()

  // The guest banner (top of Profile) opens the auth form here — and now
  // scrolls the card into view with a highlight so the flip is VISIBLE.
  React.useEffect(() => {
    const onOpenAuth = (e: Event) => {
      const mode = (e as CustomEvent<{ mode?: 'signin' | 'register' }>).detail?.mode
      setMode(mode === 'signin' ? 'signin' : 'register')
      setSpotlit(true)
      setTimeout(() => setSpotlit(false), 1800)
      requestAnimationFrame(() => {
        cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    }
    window.addEventListener(OPEN_AUTH_EVENT, onOpenAuth)
    return () => window.removeEventListener(OPEN_AUTH_EVENT, onOpenAuth)
  }, [])

  const submitAuth = async (m: 'signin' | 'register') => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/auth/${m === 'signin' ? 'login' : 'register'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          deviceId: deviceId || undefined,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) {
        setError(data.error || 'Something went wrong.')
        return
      }
      await sub.refresh()
      window.dispatchEvent(new CustomEvent(SUBSCRIPTION_CHANGED_EVENT))
      setMode('none')
    } catch {
      setError('Network error — try again.')
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    setBusy(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
      await sub.refresh()
      window.dispatchEvent(new CustomEvent(SUBSCRIPTION_CHANGED_EVENT))
    } finally {
      setBusy(false)
    }
  }

  const cancelSub = async () => {
    setCancelBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/subscription/cancel', { method: 'POST' })
      const data = (await res.json()) as { error?: string; effective?: string }
      if (!res.ok) {
        setError(data.error || 'Cancel failed.')
        return
      }
      await sub.refresh()
      window.dispatchEvent(new CustomEvent(SUBSCRIPTION_CHANGED_EVENT))
    } catch {
      setError('Network error — try again.')
    } finally {
      setCancelBusy(false)
    }
  }

  const issueKey = async () => {
    setKeyBusy(true)
    try {
      const res = await fetch('/api/subscription/apikey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'issue' }),
      })
      const data = (await res.json()) as { key?: string; error?: string }
      if (res.ok && data.key) setApiKey(data.key)
      else setError(data.error || 'Could not create the key.')
    } finally {
      setKeyBusy(false)
    }
  }

  const revokeKeys = async () => {
    setKeyBusy(true)
    try {
      await fetch('/api/subscription/apikey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'revoke' }),
      })
      setApiKey(null)
    } finally {
      setKeyBusy(false)
    }
  }

  const tierLabel =
    sub.tier === 'ultra' ? 'Ultra' : sub.tier === 'premium' ? 'Premium' : 'Free'

  return (
    <Card
      ref={cardRef}
      className={cn(
        'p-4 transition-shadow duration-500',
        spotlit && 'ring-2 ring-amber-500/70 shadow-[0_0_24px_rgba(245,158,11,0.25)]',
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <PremiumDiamond className="h-4 w-4" />
        <h2 className="text-sm font-bold">Subscription</h2>
        <PremiumBadge ultra={sub.tier === 'ultra'} className="ml-auto" />
      </div>

      {/* ── Signed-in tier state ── */}
      {sub.loggedIn ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{sub.account?.email}</div>
              <div className="text-[11px] text-muted-foreground">
                {sub.tier === 'free'
                  ? 'Free — every story, bias bar, sources & PWA'
                  : `${tierLabel} · ${sub.renewsAt ? `renews ${new Date(sub.renewsAt).toLocaleDateString()}` : 'active'}`}
              </div>
            </div>
            {sub.tier !== 'free' && sub.model === 'subscription' ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-600 dark:text-amber-400">
                <Crown className="h-3 w-3" />
                {tierLabel}
              </span>
            ) : null}
          </div>

          {/* ── The current plan's features (owner request): ON a plan, the
              card shows WHAT the tier includes — not just the tier +
              renewal + the 3-tier comparison grid. */}
          {sub.model === 'subscription' && sub.tier !== 'free' ? (
            <CurrentPlanFeatures />
          ) : null}

          {/* ── The 3-tier comparison (Free / Premium / Ultra) — always
              visible in the subscription model so the whole system reads
              at a glance; each card's own "Current" badge marks the
              visitor's plan. */}
          {sub.model === 'subscription' ? <TierComparisonGrid /> : null}

          {sub.tier === 'free' && sub.model === 'subscription' ? (
            <Button className="w-full" onClick={() => openUpgradeDialog('premium')}>
              <Sparkles className="h-4 w-4" />
              Get Premium — {sub.pricing.premium.display}/month
            </Button>
          ) : null}

          {sub.tier === 'premium' && sub.model === 'subscription' ? (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => openUpgradeDialog('apiAccess')}
            >
              <PremiumDiamond className="h-4 w-4" />
              Upgrade to Ultra — {sub.pricing.ultra.display}/month
            </Button>
          ) : null}

          {sub.tier !== 'free' && sub.model === 'subscription' ? (
            <Button
              variant="ghost"
              className="w-full text-muted-foreground"
              onClick={cancelSub}
              disabled={cancelBusy}
            >
              {cancelBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Cancel subscription
            </Button>
          ) : null}

          {/* ── Ultra API key manager ── */}
          {sub.tier === 'ultra' ? (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <KeyRound className="h-4 w-4 text-amber-500" />
                Feed API access
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Your key unlocks <code className="rounded bg-muted px-1">/api/v1/feed?topic=top</code> —
                Bearer auth. Stored hashed; shown once.
              </p>
              {apiKey ? (
                <div className="mt-2 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 text-[11px]">
                    {apiKey}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      await navigator.clipboard.writeText(apiKey).catch(() => {})
                      setKeyCopied(true)
                      setTimeout(() => setKeyCopied(false), 1500)
                    }}
                  >
                    {keyCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              ) : (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Button size="sm" onClick={issueKey} disabled={keyBusy}>
                    {keyBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    Create key
                  </Button>
                  <Button size="sm" variant="outline" onClick={revokeKeys} disabled={keyBusy}>
                    Revoke keys
                  </Button>
                </div>
              )}
            </div>
          ) : null}

          <Button variant="ghost" className="w-full text-muted-foreground" onClick={signOut} disabled={busy}>
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </div>
      ) : (
        /* ── Logged out: the 3-tier preview + sign in / create account ── */
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Create an account to subscribe, keep Premium on every device and unlock the
            email digest.
          </p>
          {sub.model === 'subscription' ? <TierComparisonGrid /> : null}
          {mode === 'none' ? (
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={() => setMode('register')}>
                <Mail className="h-4 w-4" /> Sign up
              </Button>
              <Button variant="outline" onClick={() => setMode('signin')}>
                <Lock className="h-4 w-4" /> Sign in
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
              <Input
                type="password"
                placeholder="Password (8+ characters)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitAuth(mode)
                }}
              />
              <div className="grid grid-cols-2 gap-2">
                <Button onClick={() => submitAuth(mode)} disabled={busy || !email || password.length < 4}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {mode === 'register' ? 'Create account' : 'Sign in'}
                </Button>
                <Button variant="ghost" onClick={() => { setMode('none'); setError(null) }}>
                  Back
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {error ? (
        <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      ) : null}
    </Card>
  )
}

// ── Alerts tab: the email digest prefs ──────────────────────────────────

const FREQ_OPTIONS: Array<{ id: 'weekly' | 'daily' | '2x' | '3x'; label: string; desc: string }> = [
  { id: 'weekly', label: 'Weekly', desc: 'Mondays, your chosen hour' },
  { id: 'daily', label: 'Daily', desc: 'Once a day, your chosen hour' },
  { id: '2x', label: 'Twice daily', desc: 'Morning + evening' },
  { id: '3x', label: '3× daily', desc: 'Breakfast, lunch & evening' },
]

export function DigestPrefsCard() {
  const sub = useSubscription()
  const [digest, setDigest] = React.useState<{
    enabled: boolean
    freq: string
    hour: number
    email?: string
  }>({
    enabled: false,
    freq: 'daily',
    hour: 8,
  })
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [msg, setMsg] = React.useState<string | null>(null)

  React.useEffect(() => {
    fetch('/api/subscription/digest')
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          d: {
            digest?: { enabled?: boolean; freq?: string; hour?: number; email?: string }
          } | null,
        ) => {
          if (d?.digest) {
            setDigest({
              enabled: d.digest.enabled !== false,
              freq: d.digest.freq || 'daily',
              hour: typeof d.digest.hour === 'number' ? d.digest.hour : 8,
              ...(d.digest.email ? { email: d.digest.email } : {}),
            })
          }
        },
      )
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const save = async (next: { enabled?: boolean; freq?: string; hour?: number; email?: string }) => {
    const merged = { ...digest, ...next }
    setDigest(merged)
    setSaving(true)
    setMsg(null)
    try {
      const res = await fetch('/api/subscription/digest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(merged),
      })
      const data = (await res.json()) as { error?: string; needUpgrade?: boolean; needAccount?: boolean }
      if (res.status === 402 || data.needUpgrade) {
        openUpgradeDialog('emailDigest')
        return
      }
      if (res.status === 401 || data.needAccount) {
        setMsg('Sign in first (Profile tab) to save digest preferences.')
        return
      }
      if (!res.ok) {
        setMsg(data.error || 'Could not save.')
        return
      }
      setMsg(
        merged.enabled
          ? `Saved — you'll get your digest ${merged.freq === 'weekly' ? 'on Mondays' : merged.freq === 'daily' ? 'every day' : merged.freq === '2x' ? 'twice a day' : '3 times a day'}${process.env.NODE_ENV === 'production' ? '' : ' (deliveries start once the email API key is configured)'}.`
          : 'Saved — digest off.',
      )
    } catch {
      setMsg('Network error — try again.')
    } finally {
      setSaving(false)
    }
  }

  const gated = sub.model === 'subscription' && !sub.entitlements.emailDigest

  // ── FLAGSHIP premium card ──
  // The AI email newsletter is a headline Premium feature, so the entry
  // itself is designed like one: an amber gradient slab with the golden
  // diamond, a one-line pitch, and — for free visitors — the FULL
  // frequency control set rendered as a teaser where every tap opens the
  // upgrade dialog (visible-but-locked, like every other premium surface).
  return (
    <Card
      className={cn(
        'relative overflow-hidden p-0',
        'border border-amber-500/40',
        'bg-gradient-to-br from-amber-500/15 via-amber-500/5 to-transparent',
      )}
    >
      {/* Soft radial glow behind the header mark */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-8 -top-8 h-40 w-40 rounded-full bg-amber-500/10 blur-2xl"
      />

      {/* Header — the flagship treatment */}
      <div className="relative flex items-start gap-3 p-4 pb-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-amber-600 text-white shadow-md shadow-amber-500/25">
          <Mail className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="text-base font-bold leading-tight">The AI Email Newsletter</h2>
            {sub.model === 'subscription' ? (
              <PremiumBadge ultra={sub.tier === 'ultra'} />
            ) : null}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            An AI-written briefing built from <b>your</b> subtopics — how every side
            covered the day, in one email. From once a week to 3× a day.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 pb-4 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : gated ? (
        <div className="relative px-4 pb-4">
          {/* Teaser: the real frequency options, visible-but-locked —
              tapping any of them (or the CTA) opens the upgrade dialog. */}
          <div className="mb-2 text-xs font-semibold text-muted-foreground">
            Choose your cadence — {sub.pricing.premium.display}/month:
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {FREQ_OPTIONS.map((o) => (
              <motion.button
                key={o.id}
                type="button"
                whileTap={{ scale: 0.97 }}
                onClick={() => openUpgradeDialog('emailDigest')}
                aria-label={`${o.label} — Premium`}
                className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-background/60 px-2.5 py-2 text-left transition-all hover:border-amber-500/50 hover:bg-amber-500/10"
              >
                <PremiumDiamond className="h-3 w-3 shrink-0 opacity-70" />
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold leading-tight">{o.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-tight text-muted-foreground">
                    {o.desc}
                  </span>
                </span>
              </motion.button>
            ))}
          </div>
          <Button
            className="mt-3 w-full gap-1.5 bg-gradient-to-r from-amber-500 to-amber-600 text-white shadow-sm hover:from-amber-600 hover:to-amber-700"
            onClick={() => openUpgradeDialog('emailDigest')}
          >
            <PremiumDiamond className="h-3.5 w-3.5" />
            Unlock the newsletter — {sub.pricing.premium.display}/month
          </Button>
        </div>
      ) : (
        <div className="relative space-y-3 px-4 pb-4">
          {/* Delivery address — the custom newsletter email (set/changed in
              the Profile tab) or the account email by default. */}
          <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 px-2.5 py-2">
            <div className="flex min-w-0 items-center gap-2 text-[11px]">
              <Send className="h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span className="text-muted-foreground">Delivering to</span>
              <span className="truncate font-medium">{digest.email || sub.account?.email || 'your account email'}</span>
            </div>
            {digest.email ? (
              <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                custom
              </span>
            ) : null}
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">Enabled</span>
            <Switch checked={digest.enabled} onCheckedChange={(v) => save({ enabled: v })} />
          </div>
          {digest.enabled ? (
            <>
              <div className="grid grid-cols-2 gap-1.5">
                {FREQ_OPTIONS.map((o) => (
                  <motion.button
                    key={o.id}
                    type="button"
                    whileTap={{ scale: 0.97 }}
                    onClick={() => save({ freq: o.id })}
                    aria-pressed={digest.freq === o.id}
                    className={cn(
                      'rounded-lg border px-2.5 py-2 text-left transition-all',
                      digest.freq === o.id
                        ? 'border-amber-500/50 bg-amber-500/10 ring-1 ring-amber-500/30'
                        : 'border-border hover:bg-muted/40',
                    )}
                  >
                    <div className="text-[13px] font-semibold">{o.label}</div>
                    <div className="text-[11px] text-muted-foreground">{o.desc}</div>
                  </motion.button>
                ))}
              </div>
              {digest.freq !== '3x' ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Send at</span>
                  <select
                    value={digest.hour}
                    onChange={(e) => save({ hour: Number(e.target.value) })}
                    className="rounded-md border bg-background px-2 py-1 text-xs"
                    aria-label="Send hour"
                  >
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>
                        {String(h).padStart(2, '0')}:00
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </>
          ) : null}
          {saving ? (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Saving…
            </div>
          ) : null}
          {msg ? <div className="text-[11px] text-muted-foreground">{msg}</div> : null}
        </div>
      )}
    </Card>
  )
}

// ── Feed tab: personal feature flags (Premium, all functional) ──────────

export interface PersonalFlag {
  id: string
  label: string
  desc: string
}

export const PERSONAL_FLAGS: PersonalFlag[] = [
  { id: 'compactFeed', label: 'Compact cards', desc: 'Denser feed — more stories per screen' },
  { id: 'hideBlindspots', label: 'Hide Blindspots tab', desc: 'Remove the Blindspots header chip' },
  { id: 'bigText', label: 'Larger text', desc: 'Bump base article text size' },
]

const FLAGS_KEY = 'neutralwire:my-flags'
export const MY_FLAGS_EVENT = 'neutralwire:my-flags-changed'

export function getMyFlags(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}
  try {
    return JSON.parse(localStorage.getItem(FLAGS_KEY) || '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}

function setFlag(id: string, on: boolean) {
  const flags = getMyFlags()
  if (on) flags[id] = true
  else delete flags[id]
  try {
    localStorage.setItem(FLAGS_KEY, JSON.stringify(flags))
  } catch {}
  window.dispatchEvent(new CustomEvent(MY_FLAGS_EVENT))
}

export function PersonalFlagsCard() {
  const sub = useSubscription()
  const [flags, setFlags] = React.useState<Record<string, boolean>>({})

  React.useEffect(() => {
    setFlags(getMyFlags())
    const onChanged = () => setFlags(getMyFlags())
    window.addEventListener(MY_FLAGS_EVENT, onChanged)
    return () => window.removeEventListener(MY_FLAGS_EVENT, onChanged)
  }, [])

  const gated = sub.model === 'subscription' && !sub.entitlements.personalFlags

  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-amber-500" />
        <h2 className="text-sm font-bold">My feature flags</h2>
        <PremiumBadge className="ml-auto" />
      </div>
      <p className="text-xs text-muted-foreground">
        Personal tweaks — applied instantly, saved on this device.
      </p>
      {gated ? (
        <button
          type="button"
          onClick={() => openUpgradeDialog('personalFlags')}
          className="mt-3 flex w-full items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-left text-xs"
        >
          <PremiumDiamond className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">Personal flags are Premium — {sub.pricing.premium.display}/month.</span>
        </button>
      ) : (
        <div className="mt-3 space-y-2.5">
          {PERSONAL_FLAGS.map((f) => (
            <div key={f.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">{f.label}</div>
                <div className="text-[11px] text-muted-foreground">{f.desc}</div>
              </div>
              <Switch
                checked={Boolean(flags[f.id])}
                onCheckedChange={(v) => setFlag(f.id, v)}
                aria-label={f.label}
              />
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

// ── Profile tab: the newsletter delivery address ────────────────────────

/** NewsletterEmailCard — WHERE the AI email newsletter is delivered.
 *
 * The user spec: "make it so you can set a custom email to the emailing
 * newsletter and put that thing in the profile section." Lives in the
 * Profile tab right under the subscription card. Default = the account
 * email; any valid address can replace it (saved server-side into
 * prefs.digest.email + mirrored to digestSubscribers so the cron needs no
 * changes). Free visitors get the standard teaser; logged-out visitors
 * are pointed at the sign-in form below. */
export function NewsletterEmailCard() {
  const sub = useSubscription()
  const [addr, setAddr] = React.useState('')
  const [custom, setCustom] = React.useState<string | null>(null)
  const [accountEmail, setAccountEmail] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null)

  const load = React.useCallback(() => {
    fetch('/api/subscription/digest')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { digest?: { email?: string }; email?: string } | null) => {
        if (!d) return
        setAccountEmail(d.email || '')
        setCustom(d.digest?.email || null)
        setAddr(d.digest?.email || d.email || '')
      })
      .catch(() => {})
  }, [])

  React.useEffect(() => {
    if (!sub.loading) load()
  }, [sub.loading, sub.loggedIn, load])

  const gated = sub.model === 'subscription' && !sub.entitlements.emailDigest

  const save = async (nextAddr: string) => {
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch('/api/subscription/digest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Partial save — the route MERGES with stored prefs (cadence etc.
        // untouched). Empty string clears the override.
        body: JSON.stringify({ email: nextAddr }),
      })
      const data = (await res.json()) as { error?: string; needUpgrade?: boolean; needAccount?: boolean }
      if (res.status === 402 || data.needUpgrade) {
        openUpgradeDialog('emailDigest')
        return
      }
      if (res.status === 401 || data.needAccount) {
        setMsg({ ok: false, text: 'Sign in first — the sign-in form is just below.' })
        return
      }
      if (!res.ok) {
        setMsg({ ok: false, text: data.error || 'Could not save.' })
        return
      }
      const trimmed = nextAddr.trim()
      if (trimmed === '') {
        setCustom(null)
        setAddr(accountEmail)
        setMsg({ ok: true, text: `Delivering to your account email${accountEmail ? ` (${accountEmail})` : ''}.` })
      } else {
        setCustom(trimmed.toLowerCase())
        setMsg({ ok: true, text: `Saved — every newsletter goes to ${trimmed}.` })
      }
    } catch {
      setMsg({ ok: false, text: 'Network error — try again.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <Send className="h-4 w-4 text-amber-500" />
        <h2 className="text-sm font-bold">Newsletter email</h2>
        {sub.model === 'subscription' ? <PremiumBadge className="ml-auto" /> : null}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Where the AI email newsletter is delivered — your account address by default, or any
        inbox you prefer.
      </p>

      {gated ? (
        <button
          type="button"
          onClick={() => openUpgradeDialog('emailDigest')}
          className="mt-3 flex w-full items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-left text-xs"
        >
          <PremiumDiamond className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            The newsletter is Premium — {sub.pricing.premium.display}/month.
          </span>
        </button>
      ) : !sub.loggedIn ? (
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(new CustomEvent(OPEN_AUTH_EVENT, { detail: { mode: 'signin' } }))
          }
          className="mt-3 flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-xs"
        >
          <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1">Sign in below to choose your newsletter address.</span>
        </button>
      ) : (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <Input
              type="email"
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
              placeholder={accountEmail || 'you@example.com'}
              aria-label="Newsletter delivery address"
              className="min-w-0 flex-1"
            />
            <Button size="sm" onClick={() => save(addr)} disabled={busy || !addr.trim()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Save
            </Button>
          </div>
          {custom ? (
            <button
              type="button"
              onClick={() => save('')}
              className="text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Reset to my account email{accountEmail ? ` (${accountEmail})` : ''}
            </button>
          ) : null}
          {msg ? (
            <div
              className={cn(
                'text-[11px]',
                msg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
              )}
            >
              {msg.text}
            </div>
          ) : null}
        </div>
      )}
    </Card>
  )
}
