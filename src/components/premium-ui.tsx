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
import { X, Check, Loader2, Mail, Lock, LogOut, Sparkles } from 'lucide-react'
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
  dispatchPremiumWelcome,
  getClientDeviceId,
  type UpgradeFeature,
} from '@/lib/subscription-client'

// ── The golden diamond ──────────────────────────────────────────────────

/** The global premium mark: a brilliant-cut golden DIAMOND — flat crown
 *  top, wide girdle, pointed pavilion — faceted via layered opacities so
 *  it reads as cut stone even at 10px. One symbol everywhere a premium
 *  feature appears (header button, + chip badge, badges, tier cards). */
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
        {/* Crown — flat table edge widening out to the girdle */}
        <path d="M7.2 3.5h9.6L14.7 9H9.3L7.2 3.5Z" opacity="0.95" />
        <path d="M7.2 3.5L3 9h6.3L7.2 3.5Z" opacity="0.8" />
        <path d="M16.8 3.5L21 9h-6.3l2.1-5.5Z" opacity="0.8" />
        {/* Pavilion — facets converging to the culet point */}
        <path d="M3 9h6.3L12 20.5 3 9Z" opacity="0.85" />
        <path d="M9.3 9h5.4L12 20.5 9.3 9Z" />
        <path d="M14.7 9H21L12 20.5 14.7 9Z" opacity="0.85" />
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
    title: 'Pick your own header style',
    blurb: 'Choose how NeutralWire looks to you — big chips, bold tabs, maxi pills and 7 more designs.',
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

const FREE_FEATURES = [
  'Every story, the bias bar & all sources',
  'All 11 subtopic feeds',
  'The PWA — install & offline',
]
const PREMIUM_FEATURES = [
  'Custom subtopics — 550+ or AI-made',
  'Your header style — 10 designs',
  'Full archive search',
  'AI email digest',
  'Gradient themes',
]
const ULTRA_FEATURES = [
  'Everything in Premium',
  'Feed API access',
  'Export & download articles',
]

// ── The dialog ──────────────────────────────────────────────────────────

type AuthMode = 'choose' | 'signin' | 'register'

/** Shared tier ids for the 3-tier grid (Free / Premium / Ultra). */
export type TierId = 'free' | 'premium' | 'ultra'

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
  const [selectedTier, setSelectedTier] = React.useState<TierId>('premium')

  React.useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { feature?: UpgradeFeature; tier?: TierId }
        | undefined
      setFeature(detail?.feature || 'premium')
      if (detail?.tier === 'premium' || detail?.tier === 'ultra') {
        setSelectedTier(detail.tier)
      }
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
        // Test mode: tier granted instantly — refresh state, close this
        // dialog and hand the stage to the PremiumWelcome guided tour
        // (add subtopics, pick a header style, themes…). The provider's
        // tier-increase detection fires the welcome event too — the
        // welcome sheet guards against double-open itself.
        await sub.refresh()
        window.dispatchEvent(new CustomEvent(SUBSCRIPTION_CHANGED_EVENT))
        setOpen(false)
        dispatchPremiumWelcome(tier)
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
            className="max-h-[92dvh] w-full max-w-lg overflow-y-auto overscroll-contain rounded-t-2xl border bg-background p-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-2xl sm:p-5 sm:pb-5"
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
                {/* ── Tier cards: all three levels, side by side on sm+,
                    stacked full-width rows on mobile (no squeezed 3-column
                    cramming on a 390px screen). Free shows what stays
                    included; Premium/Ultra are the selectable plans. */}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-2.5">
                  <TierCard3
                    id="free"
                    selected={false}
                    current={sub.tier === 'free'}
                    onSelect={() => {}}
                    name="Free"
                    price={`${sub.pricing.premium.symbol}0`}
                    tag="forever"
                    features={FREE_FEATURES}
                  />
                  <TierCard3
                    id="premium"
                    selected={selectedTier === 'premium'}
                    current={sub.tier === 'premium'}
                    onSelect={() => setSelectedTier('premium')}
                    name="Premium"
                    price={`${price.display}/mo`}
                    tag="most popular"
                    features={PREMIUM_FEATURES}
                    highlight
                  />
                  <TierCard3
                    id="ultra"
                    selected={selectedTier === 'ultra'}
                    current={sub.tier === 'ultra'}
                    onSelect={() => setSelectedTier('ultra')}
                    name="Ultra"
                    price={`${ultraPrice.display}/mo`}
                    tag="for builders"
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
                  onClick={() => startCheckout(selectedTier === 'ultra' ? 'ultra' : 'premium')}
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

/** The 3-level tier card — Free / Premium / Ultra share one component.
 *
 * Mobile: a full-width row (name + price on one line, features in a
 * 2-column mini-grid underneath) so nothing ever crams. sm+: one of
 * three columns. `current` marks the visitor's plan; `highlight` is the
 * “most popular” ribbon on Premium. */
function TierCard3({
  id,
  selected,
  current,
  onSelect,
  name,
  price,
  tag,
  features,
  highlight = false,
  ultra = false,
}: {
  id: TierId
  selected: boolean
  current: boolean
  onSelect: () => void
  name: string
  price: string
  tag?: string
  features: string[]
  highlight?: boolean
  ultra?: boolean
}) {
  const isFree = id === 'free'
  return (
    <motion.button
      type="button"
      onClick={isFree ? undefined : onSelect}
      whileTap={isFree ? undefined : { scale: 0.98 }}
      aria-pressed={isFree ? undefined : selected}
      disabled={isFree && current}
      className={cn(
        'relative flex w-full flex-col rounded-xl border p-3 text-left transition-all',
        isFree
          ? 'border-dashed border-border bg-muted/20'
          : selected
            ? ultra
              ? 'border-amber-500/70 bg-amber-500/10 ring-1 ring-amber-500/40'
              : 'border-amber-500/70 bg-amber-500/5 ring-1 ring-amber-500/35'
            : 'border-border hover:bg-muted/40',
      )}
    >
      {/* Header line — mark, name, badge; the check marks selection */}
      <div className="flex items-center gap-1.5">
        {ultra ? (
          <PremiumDiamond className="h-4 w-4 shrink-0" />
        ) : isFree ? (
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <PremiumDiamond className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="text-sm font-bold">{name}</span>
        {highlight ? (
          <span className="ml-auto inline-flex shrink-0 items-center rounded-full bg-amber-500 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white shadow-sm">
            Popular
          </span>
        ) : null}
        {!highlight && tag ? (
          <span className="ml-auto shrink-0 text-[10px] font-medium text-muted-foreground">{tag}</span>
        ) : null}
        {selected && !highlight ? (
          <Check className="ml-auto h-4 w-4 shrink-0 text-amber-500" />
        ) : null}
        {current ? (
          <span
            className={cn(
              'inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide',
              highlight ? 'ml-1.5' : 'ml-auto',
              isFree
                ? 'bg-muted text-muted-foreground'
                : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
            )}
          >
            Current
          </span>
        ) : null}
      </div>

      {/* Price line */}
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="text-lg font-extrabold tabular-nums">{price}</span>
      </div>

      {/* Features — 2-column mini-grid on mobile keeps each row short;
         single column once the cards sit side-by-side (sm+). */}
      <ul className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 sm:grid-cols-1">
        {features.map((f) => (
          <li
            key={f}
            className="flex items-start gap-1 text-[11px] leading-snug text-muted-foreground"
          >
            <Check
              className={cn(
                'mt-0.5 h-3 w-3 shrink-0',
                isFree ? 'text-muted-foreground/70' : 'text-amber-500',
              )}
            />
            <span className="min-w-0">{f}</span>
          </li>
        ))}
      </ul>
    </motion.button>
  )
}

// ── The Account-page tier comparison (Free / Premium / Ultra) ───────────
// A read-only version of the dialog grid: each level gets its card, the
// visitor's CURRENT plan is marked, and the paid cards open the upgrade
// dialog with that tier pre-selected. Stacked rows on mobile, 3 columns
// on sm+ — same geometry as the dialog, one visual language.

export function TierComparisonGrid() {
  const sub = useSubscription()
  const current = sub.tier

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-2.5">
      <TierCard3
        id="free"
        selected={false}
        current={current === 'free'}
        onSelect={() => {}}
        name="Free"
        price={`${sub.pricing.premium.symbol}0`}
        tag="forever"
        features={FREE_FEATURES}
      />
      <TierCard3
        id="premium"
        selected={false}
        current={current === 'premium'}
        onSelect={() =>
          window.dispatchEvent(
            new CustomEvent(UPGRADE_OPEN_EVENT, {
              detail: { feature: 'premium', tier: 'premium' },
            }),
          )
        }
        name="Premium"
        price={`${sub.pricing.premium.display}/mo`}
        tag="most popular"
        features={PREMIUM_FEATURES}
        highlight
      />
      <TierCard3
        id="ultra"
        selected={false}
        current={current === 'ultra'}
        onSelect={() =>
          window.dispatchEvent(
            new CustomEvent(UPGRADE_OPEN_EVENT, {
              detail: { feature: 'apiAccess', tier: 'ultra' },
            }),
          )
        }
        name="Ultra"
        price={`${sub.pricing.ultra.display}/mo`}
        tag="for builders"
        features={ULTRA_FEATURES}
        ultra
      />
    </div>
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
