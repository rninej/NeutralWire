'use client'

/**
 * premium-ui.tsx — shared Premium visual language + THE upgrade dialog.
 *
 * • PremiumDiamond — the golden diamond symbol (the user spec: the +
 *   subtopic button carries a golden diamond on its corner; badges use
 *   the same mark everywhere so "premium" reads as ONE brand idea).
 * • PremiumBadge — compact "Premium" chip for section headers.
 * • UpgradeDialog — the paywall. Opened from anywhere via
 *   openUpgradeDialog() (event bus). Shows the tier comparison with
 *   LOCALISED pricing (£3/$3/€3, £20/$20/€20), an inline account step
 *   (email+password / Google / Apple — required before subscribing), and
 *   the checkout button (Stripe redirect in live mode, instant test-mode
 *   grant until Stripe keys are configured).
 */

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Gem, Check, Loader2, Mail, Lock, LogOut, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  useSubscription,
  openUpgradeDialog,
  UPGRADE_OPEN_EVENT,
  UPGRADE_CLOSE_EVENT,
  SUBSCRIPTION_CHANGED_EVENT,
  getClientDeviceId,
  type UpgradeFeature,
} from '@/lib/subscription-client'

// ── The golden diamond ──────────────────────────────────────────────────

export function PremiumDiamond({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center text-amber-500',
        className,
      )}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-full w-full drop-shadow-[0_0_1px_rgba(245,158,11,0.6)]">
        <path d="M12 2L15 6.5H9L12 2Z" />
        <path d="M9 6.5L4.5 12L9 17.5L12 13L9 6.5Z" opacity="0.85" />
        <path d="M15 6.5L19.5 12L15 17.5L12 13L15 6.5Z" opacity="0.85" />
        <path d="M9 17.5L12 22L15 17.5L12 15.5L9 17.5Z" opacity="0.9" />
      </svg>
    </span>
  )
}

export function PremiumBadge({ ultra = false, className }: { ultra?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold',
        ultra
          ? 'bg-amber-500/15 text-amber-600 dark:text-amber-300'
          : 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
        className,
      )}
    >
      <PremiumDiamond className="h-2.5 w-2.5" />
      {ultra ? 'Ultra' : 'Premium'}
    </span>
  )
}

// ── Feature copy for the dialog headline ────────────────────────────────

const FEATURE_COPY: Record<UpgradeFeature, { title: string; blurb: string }> = {
  customSubtopics: {
    title: 'Build your own newsroom',
    blurb: 'Add any subtopic you care about — pick from 550+ ready topics or let AI create one for you.',
  },
  archiveSearchOld: {
    title: 'Unlock the full archive',
    blurb: 'Search every story NeutralWire has ever covered — not just the last 3 months.',
  },
  emailDigest: {
    title: 'The NeutralWire briefing, in your inbox',
    blurb: 'An AI-written newsletter built from your subtopics — from once a week to 3 times a day.',
  },
  gradientThemes: {
    title: 'Gradient themes',
    blurb: 'Ten exclusive gradient looks (plus a custom gradient maker) for your NeutralWire.',
  },
  personalFlags: {
    title: 'Personal feature flags',
    blurb: 'Fine-tune your NeutralWire — compact cards, hidden tabs, text size and more.',
  },
  apiAccess: {
    title: 'NeutralWire API access',
    blurb: 'Feed your own apps the NeutralWire feed with a personal API key.',
  },
  articleExport: {
    title: 'Export & download articles',
    blurb: 'Save any story as Markdown, text or a print-ready page — sources and all.',
  },
  premium: {
    title: 'NeutralWire Premium',
    blurb: 'Custom subtopics, the full archive, the email digest, gradient themes and more.',
  },
}

const PREMIUM_FEATURES = [
  'Custom subtopics — 550+ to pick from, AI creates anything else',
  'Search the full archive (older than 3 months)',
  'AI email digest — once a week up to 3 times a day',
  'Gradient themes + custom gradient maker',
  'Personal feature flags',
]
const ULTRA_FEATURES = [
  'Everything in Premium',
  'API access to the NeutralWire feed',
  'Export or download any article',
]

// ── The dialog ──────────────────────────────────────────────────────────

type AuthMode = 'choose' | 'signin' | 'register'

export function UpgradeDialog() {
  const sub = useSubscription()
  const [open, setOpen] = React.useState(false)
  const [feature, setFeature] = React.useState<UpgradeFeature>('premium')
  const [authMode, setAuthMode] = React.useState<AuthMode>('choose')
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [success, setSuccess] = React.useState<string | null>(null)
  const [selectedTier, setSelectedTier] = React.useState<'premium' | 'ultra'>('premium')

  React.useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail as { feature?: UpgradeFeature } | undefined
      setFeature(detail?.feature || 'premium')
      setOpen(true)
      setSuccess(null)
      setError(null)
      // Signed-in users skip straight to checkout; logged-out see the
      // account step first (the spec: an account is required to subscribe).
      setAuthMode(sub.loggedIn ? 'choose' : 'choose')
    }
    const onClose = () => setOpen(false)
    window.addEventListener(UPGRADE_OPEN_EVENT, onOpen)
    window.addEventListener(UPGRADE_CLOSE_EVENT, onClose)
    return () => {
      window.removeEventListener(UPGRADE_OPEN_EVENT, onOpen)
      window.removeEventListener(UPGRADE_CLOSE_EVENT, onClose)
    }
  }, [sub.loggedIn])

  // Lock body scroll while open.
  React.useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  const deviceId = getClientDeviceId()

  const submitAuth = async (mode: 'signin' | 'register') => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/auth/${mode === 'signin' ? 'login' : 'register'}`, {
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
      setSuccess(
        mode === 'register'
          ? 'Account created — pick your plan below.'
          : 'Welcome back — pick your plan below.',
      )
      setAuthMode('choose')
    } catch {
      setError('Network error — try again.')
    } finally {
      setBusy(false)
    }
  }

  const startCheckout = async (tier: 'premium' | 'ultra') => {
    setSelectedTier(tier)
    if (!sub.loggedIn) {
      setError(null)
      setAuthMode('register')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/subscription/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier, deviceId: deviceId || undefined }),
      })
      const data = (await res.json()) as {
        url?: string
        mode?: string
        error?: string
        needAccount?: boolean
      }
      if (!res.ok) {
        if (data.needAccount) {
          setAuthMode('register')
          setError('Create an account first — it takes 20 seconds.')
          return
        }
        setError(data.error || 'Checkout failed.')
        return
      }
      if (data.mode === 'test') {
        // Test mode: tier granted instantly — refresh state + celebrate.
        await sub.refresh()
        window.dispatchEvent(new CustomEvent(SUBSCRIPTION_CHANGED_EVENT))
        setSuccess(`You're ${tier === 'ultra' ? 'Ultra' : 'Premium'}! (test mode)`)
      } else if (data.url) {
        window.location.href = data.url
      }
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

  const copy = FEATURE_COPY[feature] || FEATURE_COPY.premium
  const price = sub.pricing.premium
  const ultraPrice = sub.pricing.ultra

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-4"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Upgrade to Premium"
        >
          <motion.div
            initial={{ y: 40, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 40, opacity: 0, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border bg-background p-5 shadow-2xl sm:rounded-2xl"
          >
            {/* Header */}
            <div className="mb-4 flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/15">
                <PremiumDiamond className="h-6 w-6" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-bold leading-tight">{copy.title}</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">{copy.blurb}</p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded-full p-1.5 text-muted-foreground hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {sub.tier !== 'free' && sub.model === 'subscription' ? (
              /* ── Already subscribed ── */
              <div className="space-y-3">
                <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
                  <div className="flex items-center gap-2 font-semibold">
                    <Sparkles className="h-4 w-4 text-amber-500" />
                    You&apos;re {sub.tier === 'ultra' ? 'Ultra' : 'Premium'}
                    {sub.account?.email ? (
                      <span className="truncate text-xs font-normal text-muted-foreground">
                        {sub.account.email}
                      </span>
                    ) : null}
                  </div>
                  {sub.renewsAt ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Renews {new Date(sub.renewsAt).toLocaleDateString()}
                    </p>
                  ) : null}
                </div>
                {sub.tier === 'premium' ? (
                  <Button
                    className="w-full"
                    onClick={() => startCheckout('ultra')}
                    disabled={busy}
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    Upgrade to Ultra — {ultraPrice.display}/month
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={signOut}
                  disabled={busy}
                >
                  <LogOut className="h-4 w-4" /> Sign out
                </Button>
              </div>
            ) : (
              <>
                {/* ── Tier cards ── */}
                <div className="grid grid-cols-2 gap-3">
                  <TierCard
                    selected={selectedTier === 'premium'}
                    onSelect={() => setSelectedTier('premium')}
                    name="Premium"
                    price={`${price.display}/mo`}
                    features={PREMIUM_FEATURES}
                  />
                  <TierCard
                    selected={selectedTier === 'ultra'}
                    onSelect={() => setSelectedTier('ultra')}
                    name="Ultra"
                    price={`${ultraPrice.display}/mo`}
                    features={ULTRA_FEATURES}
                    ultra
                  />
                </div>

                {/* ── Auth section (only when logged out) ── */}
                {!sub.loggedIn && (
                  <div className="mt-4">
                    {authMode === 'choose' ? (
                      <div className="space-y-2">
                        <p className="text-center text-xs text-muted-foreground">
                          An account keeps your subscription on every device.
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                          <Button variant="outline" onClick={() => setAuthMode('register')}>
                            <Mail className="h-4 w-4" /> Sign up with email
                          </Button>
                          <Button variant="outline" onClick={() => setAuthMode('signin')}>
                            <Lock className="h-4 w-4" /> Sign in
                          </Button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <Button
                            variant="outline"
                            onClick={() => {
                              const url = `/api/auth/google?tier=${selectedTier}${deviceId ? `&deviceId=${encodeURIComponent(deviceId)}` : ''}`
                              window.location.href = url
                            }}
                          >
                            <GoogleG className="h-4 w-4" /> Google
                          </Button>
                          <Button
                            variant="outline"
                            onClick={async () => {
                              const res = await fetch(
                                `/api/auth/apple?tier=${selectedTier}`,
                              ).catch(() => null)
                              if (res && res.status === 503) {
                                setError('Sign in with Apple is coming soon — use email for now.')
                              } else {
                                window.location.href = `/api/auth/apple?tier=${selectedTier}`
                              }
                            }}
                          >
                            <AppleI className="h-4 w-4" /> Apple
                          </Button>
                        </div>
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
                          autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') submitAuth(authMode)
                          }}
                        />
                        <div className="grid grid-cols-2 gap-2">
                          <Button
                            onClick={() => submitAuth(authMode)}
                            disabled={busy || !email || password.length < 4}
                          >
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                            {authMode === 'register' ? 'Create account' : 'Sign in'}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setAuthMode(authMode === 'register' ? 'signin' : 'register')
                              setError(null)
                            }}
                          >
                            {authMode === 'register' ? 'Have an account? Sign in' : 'New? Create one'}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ── Checkout ── */}
                <Button
                  className="mt-4 w-full"
                  size="lg"
                  onClick={() => startCheckout(selectedTier)}
                  disabled={busy}
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <PremiumDiamond className="h-4 w-4" />
                  )}
                  {sub.loggedIn
                    ? `Get ${selectedTier === 'ultra' ? 'Ultra' : 'Premium'} — ${(selectedTier === 'ultra' ? ultraPrice : price).display}/month`
                    : `Continue — ${(selectedTier === 'ultra' ? ultraPrice : price).display}/month`}
                </Button>

                <p className="mt-2 text-center text-[11px] text-muted-foreground">
                  {sub.payments.provider === 'stripe'
                    ? 'Secure checkout via Stripe. Cancel anytime.'
                    : 'Test mode — payments activate once Stripe keys are configured. Everything else works.'}
                </p>

                {/* Free tier reassurance */}
                <div className="mt-3 rounded-lg border border-dashed p-3 text-center text-[11px] text-muted-foreground">
                  Free NeutralWire stays full: every story, the bias bar, all sources and the PWA.
                </div>
              </>
            )}

            {/* Messages */}
            {error ? (
              <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                {error}
              </div>
            ) : null}
            {success ? (
              <div className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                {success}
              </div>
            ) : null}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function TierCard({
  selected,
  onSelect,
  name,
  price,
  features,
  ultra = false,
}: {
  selected: boolean
  onSelect: () => void
  name: string
  price: string
  features: string[]
  ultra?: boolean
}) {
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      whileTap={{ scale: 0.98 }}
      aria-pressed={selected}
      className={cn(
        'flex flex-col rounded-xl border p-3 text-left transition-all',
        selected
          ? ultra
            ? 'border-amber-500/60 bg-amber-500/10 ring-1 ring-amber-500/40'
            : 'border-amber-500/60 bg-amber-500/5 ring-1 ring-amber-500/30'
          : 'border-border hover:bg-muted/40',
      )}
    >
      <div className="flex items-center gap-1.5">
        {ultra ? (
          <PremiumDiamond className="h-4 w-4" />
        ) : (
          <Gem className="h-3.5 w-3.5 text-amber-500" />
        )}
        <span className="text-sm font-bold">{name}</span>
        {selected ? <Check className="ml-auto h-4 w-4 text-amber-500" /> : null}
      </div>
      <div className="mt-1 text-lg font-bold">{price}</div>
      <ul className="mt-2 space-y-1">
        {features.slice(0, 5).map((f) => (
          <li key={f} className="flex items-start gap-1 text-[11px] leading-snug text-muted-foreground">
            <Check className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
            {f}
          </li>
        ))}
      </ul>
    </motion.button>
  )
}

// ── Tiny brand glyphs (no external icon deps) ───────────────────────────
function GoogleG({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.1h6.5c-.1 1.1-.8 2.7-2.4 3.8l3.7 2.9c2.2-2 3.7-5 3.7-8.6z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.7-2.9c-1 .7-2.4 1.2-4.2 1.2-3.2 0-5.9-2.1-6.8-5.1L1.3 17.2C3.3 21.2 7.3 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.2 14.3c-.2-.7-.4-1.5-.4-2.3s.1-1.6.4-2.3L1.3 6.8C.5 8.4 0 10.1 0 12s.5 3.6 1.3 5.2l3.9-2.9z"
      />
      <path
        fill="#EA4335"
        d="M12 4.7c1.8 0 3 .8 3.7 1.4l3.3-3.2C17.9 1.1 15.2 0 12 0 7.3 0 3.3 2.8 1.3 6.8l3.9 2.9c.9-3 3.6-5 6.8-5z"
      />
    </svg>
  )
}

function AppleI({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8.79-.16 1.95-.9 3.33-.77.67.03 1.75.29 2.42.9-.22.14-1.42.83-1.39 2.48.03 1.98 1.74 2.5 1.76 2.5-.02.07-.27.93-1.1 1.79.9.93 1.76 1.55 2.9 1.55-.3.68-1.16 1.55-1.6 1.72zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  )
}

export { openUpgradeDialog }
