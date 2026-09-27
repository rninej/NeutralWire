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
import { X, Check, Loader2, Mail, Lock, LogOut, Sparkles, ExternalLink, Copy } from 'lucide-react'
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
  KOFI_PAGE_URL,
  type UpgradeFeature,
} from '@/lib/subscription-client'

// ── The golden diamond ──────────────────────────────────────────────────

/** The global premium mark — a real cut GEM: a flat table across the top,
 *  a crown that flares out to the wide girdle, and a pavilion that tapers
 *  to a single point. Six golden planes whose opacity steps draw the
 *  facet LINES through the stone (bright table, deeper wings) so it reads
 *  as a drawn, lined diamond — not a filled blob, not a kite — even at
 *  10px. One symbol everywhere a premium feature appears. */
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
        {/* crown — left corner facet */}
        <path d="M6 3.5H11L8 9H2L6 3.5Z" opacity="0.78" />
        {/* crown — the bright table facet (the stone's flat top) */}
        <path d="M11 3.5H13L16 9H8L11 3.5Z" opacity="1" />
        {/* crown — right corner facet */}
        <path d="M13 3.5H18L22 9H16L13 3.5Z" opacity="0.78" />
        {/* pavilion — left wing */}
        <path d="M2 9H8L12 21.5L2 9Z" opacity="0.6" />
        {/* pavilion — the deep centre facet down to the point */}
        <path d="M8 9H16L12 21.5L8 9Z" opacity="0.92" />
        {/* pavilion — right wing */}
        <path d="M16 9H22L12 21.5L16 9Z" opacity="0.6" />
      </svg>
    </span>
  )
}

/** The ULTRA mark — a meteor shower: three golden streaks raining at
 *  staggered angles down-left, each capped by a bright round head, plus
 *  a far sparkle and landing shimmers. The streaks are drawn THICK (they
 *  must survive 16px renders — thin tails vanish and the mark would read
 *  as random sparkles). Used on the Ultra tier card wherever plans are
 *  shown (upgrade dialog, /subscribe, Account). */
export function MeteorShower({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-flex items-center justify-center text-amber-500', className)}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" fill="none" className="h-full w-full">
        {/* far sparkle */}
        <path d="M4.4 4.4l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5.5-1.3Z" fill="currentColor" opacity="0.7" />
        {/* streak 1 — the long one, top right */}
        <path d="M14.1 2.2l2.2 2.2-8.3 8.3-2.2-2.2 8.3-8.3Z" fill="currentColor" opacity="0.55" />
        <circle cx="15.2" cy="3.3" r="2" fill="currentColor" />
        {/* streak 2 — middle */}
        <path d="M19.3 8l1.8 1.8-5.6 5.6-1.8-1.8L19.3 8Z" fill="currentColor" opacity="0.45" />
        <circle cx="20.2" cy="8.9" r="1.6" fill="currentColor" opacity="0.95" />
        {/* streak 3 — short, lower left */}
        <path d="M8.6 12.4l1.5 1.5-4.2 4.2-1.5-1.5 4.2-4.2Z" fill="currentColor" opacity="0.4" />
        <circle cx="9.4" cy="13.2" r="1.3" fill="currentColor" opacity="0.9" />
        {/* landing shimmer */}
        <path d="M4.5 19.6h5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.5" />
        <path d="M11.5 21.3h4.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.35" />
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

export { FREE_FEATURES, PREMIUM_FEATURES, ULTRA_FEATURES }

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
  // ── Ko-fi checkout state (mode 'kofi' replaces the old test/stripe
  //    modes — the claim-code panel below renders while a payment is
  //    outstanding) ──
  const [kofi, setKofi] = React.useState<{
    tier: 'premium' | 'ultra'
    code: string
    url: string
    email?: string
  } | null>(null)

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
      setKofi(null)
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
        code?: string
        url?: string
        mode?: string
        email?: string
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
      // Ko-fi flow: show the claim-code panel — the supporter pays on
      // Ko-fi and the webhook grants the tier (code or email match). The
      // panel polls + listens for the grant and hands the stage to the
      // PremiumWelcome guided tour the moment it lands.
      if (data.mode === 'kofi' && data.code) {
        setKofi({ tier, code: data.code, url: data.url || KOFI_PAGE_URL, email: data.email })
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
                {/* ── Ko-fi pay panel: claim code + waiting state ── */}
                {kofi ? (
                  <KofiCheckoutPanel
                    tier={kofi.tier}
                    code={kofi.code}
                    url={kofi.url}
                    email={kofi.email}
                    onDone={() => {
                      setKofi(null)
                      setOpen(false)
                    }}
                    compact
                  />
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
                            onClick={async () => {
                              // Pre-check the OAuth route FIRST (the old
                              // flow navigated blindly to a raw JSON 503
                              // when Google env keys are missing — the
                              // "popup button doesn't work" report).
                              const res = await fetch(
                                `/api/auth/google?tier=${selectedTier}`,
                                { redirect: 'manual' },
                              ).catch(() => null)
                              // 503 = not configured; an opaque redirect
                              // (status 0) means the OAuth flow IS live.
                              if (!res || res.status === 503) {
                                setError('Google Sign-In is not configured yet — use email for now.')
                                return
                              }
                              window.location.href = `/api/auth/google?tier=${selectedTier}${deviceId ? `&deviceId=${encodeURIComponent(deviceId)}` : ''}`
                            }}
                          >
                            <GoogleG className="h-4 w-4" /> Google
                          </Button>
                          <Button
                            variant="outline"
                            onClick={async () => {
                              const res = await fetch(
                                `/api/auth/apple?tier=${selectedTier}`,
                                { redirect: 'manual' },
                              ).catch(() => null)
                              if (!res || res.status === 503) {
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
                  Payments via Ko-fi — cancel anytime.
                </p>
                <a
                  href="/subscribe"
                  className="mt-1 flex items-center justify-center gap-1 text-[11px] font-medium text-amber-600 hover:underline dark:text-amber-400"
                >
                  See the full plans page <ExternalLink className="h-3 w-3" />
                </a>
                  </>
                )}
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

/** The Ko-fi pay panel — the middle step of the live checkout.
 *
 * Shown by the UpgradeDialog AND the /subscribe page after
 * /api/subscription/checkout hands out a claim code. Three things at
 * once — and the EASIEST path needs nothing copied at all: pay on Ko-fi
 * with your NeutralWire account email (shown, copyable) and the webhook
 * auto-matches it. A link CODE is offered as the fallback for supporters
 * paying with a different email. The WAITING state polls /api/kofi/claim
 * plus the live tier so both paths land automatically — the grant fires
 * SUBSCRIPTION_CHANGED + PremiumWelcome from the provider the moment it
 * lands — and a "different email" finder claims payments made with an
 * address that isn't the account email. */
export function KofiCheckoutPanel({
  tier,
  code,
  url,
  email,
  onDone,
  compact = false,
}: {
  tier: 'premium' | 'ultra'
  code: string
  url: string
  /** The account email — paying on Ko-fi with THIS address auto-matches,
  *  so it's presented as the zero-effort primary path. */
  email?: string
  /** Called once the grant is confirmed (panel shows a beat of success
   *  first, then the caller closes/refreshes). */
  onDone?: () => void
  /** Dialog variant (tighter paddings). */
  compact?: boolean
}) {
  const sub = useSubscription()
  const [copied, setCopied] = React.useState<'email' | 'code' | null>(null)
  const [checking, setChecking] = React.useState(false)
  const [granted, setGranted] = React.useState<'premium' | 'ultra' | null>(null)
  const [note, setNote] = React.useState<string | null>(null)
  const [altEmail, setAltEmail] = React.useState('')
  // The tier when the pay panel opened — the poll succeeds when the live
  // tier RISES past it (or /api/kofi/claim lands an unclaimed payment).
  const startTierRef = React.useRef<'free' | 'premium' | 'ultra'>(sub.tier)

  const check = React.useCallback(
    async (email?: string) => {
      if (granted) return
      setChecking(true)
      try {
        let grantTier: 'premium' | 'ultra' | null = null
        let claimMsg: string | undefined
        // 1) The claim sweep — catches payments matched by EMAIL only
        //    (the webhook leaves those unclaimed for exactly this call).
        try {
          const res = await fetch('/api/kofi/claim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(email ? { email } : {}),
          })
          const data = (await res.json()) as {
            granted?: 'premium' | 'ultra' | null
            message?: string
            error?: string
          }
          if (data.granted) grantTier = data.granted
          else if (email) claimMsg = data.message || data.error
        } catch {}
        // 2) The live tier — a CODE-matched payment is claimed by the
        //    webhook itself (invisible to the sweep), so also re-read
        //    /me and compare against the panel's starting tier.
        let rose = false
        try {
          const me = (await fetch('/api/subscription/me', { cache: 'no-store' })) as Response
          const meJson = (await me.json()) as { tier?: string }
          const now = meJson.tier || 'free'
          const start = startTierRef.current
          rose =
            (now === 'premium' && start === 'free') ||
            (now === 'ultra' && (start === 'free' || start === 'premium'))
          if (rose && !grantTier) grantTier = now === 'ultra' ? 'ultra' : 'premium'
        } catch {}
        if (grantTier) {
          setGranted(grantTier)
          await sub.refresh()
          window.dispatchEvent(new CustomEvent(SUBSCRIPTION_CHANGED_EVENT))
          dispatchPremiumWelcome(grantTier)
          setTimeout(() => onDone?.(), 1400)
        } else if (email && claimMsg) {
          setNote(claimMsg)
        }
      } finally {
        setChecking(false)
      }
    },
    [granted, onDone, sub],
  )

  // Poll while the panel is open (the webhook usually lands the grant
  // before the supporter even returns; the claim sweep catches the
  // email-matched ones). Stops once granted.
  React.useEffect(() => {
    if (granted) return
    const t = setInterval(() => void check(), 12000)
    void check()
    return () => clearInterval(t)
  }, [check, granted])

  const copy = async (text: string, which: 'email' | 'code') => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(which)
      setTimeout(() => setCopied(null), 2000)
    } catch {}
  }

  if (granted) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        className={cn(
          'flex flex-col items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-center',
          compact ? 'p-4' : 'p-6',
        )}
      >
        {granted === 'ultra' ? (
          <MeteorShower className="h-8 w-8" />
        ) : (
          <PremiumDiamond className="h-8 w-8" />
        )}
        <div className="text-base font-bold">{granted === 'ultra' ? 'Ultra' : 'Premium'} is live</div>
        <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
          Payment received — welcome aboard. Adding your first subtopics, picking a header
          style and themes is next.
        </p>
      </motion.div>
    )
  }

  return (
    <div className={cn('space-y-3', compact && 'space-y-2.5')}>
      {/* 1 · THE path — go pay. Email auto-match: nothing to copy. */}
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
        <div className="text-xs font-semibold">
          1 · Continue to Ko-fi and choose {tier === 'ultra' ? 'Ultra' : 'Premium'}
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {tier === 'ultra' ? 'Ultra' : 'Premium'} unlocks here automatically the moment the
          payment lands{email ? ' — pay with your NeutralWire email and there is nothing to copy or paste' : ''}.
        </p>
        {email ? (
          <button
            type="button"
            onClick={() => copy(email, 'email')}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-amber-500/50 bg-background/70 px-2 py-2 transition-colors hover:bg-amber-500/10"
            aria-label="Copy your account email"
          >
            <span className="truncate text-xs font-medium">{email}</span>
            {copied === 'email' ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            ) : (
              <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
          </button>
        ) : null}
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-pink-500 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-all hover:bg-pink-600 active:scale-[0.98]"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.07-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93Zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39Z" />
          </svg>
          Continue to Ko-fi
          <ExternalLink className="h-3.5 w-3.5 opacity-80" />
        </a>
      </div>

      {/* 2 · Fallback — the link code for different-email payments */}
      <div className="rounded-xl border p-3">
        <div className="text-xs font-semibold">2 · Paying with a different email?</div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Copy this code into the Ko-fi message box — the payment still links to your account.
        </p>
        <button
          type="button"
          onClick={() => copy(code, 'code')}
          className="mt-1.5 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 py-2 transition-colors hover:bg-muted/60"
          aria-label="Copy claim code"
        >
          <span className="font-mono text-base font-bold tracking-[0.2em] text-amber-600 dark:text-amber-400">
            {code}
          </span>
          {copied === 'code' ? (
            <Check className="h-4 w-4 text-emerald-500" />
          ) : (
            <Copy className="h-4 w-4 text-muted-foreground" />
          )}
        </button>
      </div>

      {/* 3 · Waiting state — polls + manual check */}
      <div className="rounded-xl border bg-muted/30 p-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          {checking ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5 text-amber-500" />
          )}
          {checking ? 'Checking for your payment…' : '3 · Waiting for your payment'}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            type="email"
            value={altEmail}
            onChange={(e) => setAltEmail(e.target.value)}
            placeholder="Paid with a different email?"
            className="min-w-0 flex-1 rounded-md border bg-background px-2.5 py-1.5 text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => altEmail.trim() && check(altEmail.trim())}
            disabled={checking || !altEmail.trim()}
          >
            Find
          </Button>
        </div>
        <button
          type="button"
          onClick={() => void check()}
          disabled={checking}
          className="mt-1.5 text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
        >
          {checking ? 'Checking…' : "I've paid — check now"}
        </button>
        {note ? <p className="mt-1.5 text-[11px] text-muted-foreground">{note}</p> : null}
      </div>
    </div>
  )
}

/** The 3-level tier card — Free / Premium / Ultra share one component.
 *
 * Mobile: a full-width row (name + price on one line, features in a
 * 2-column mini-grid underneath) so nothing ever crams. sm+: one of
 * three columns. `current` marks the visitor's plan; `highlight` is the
 * “most popular” ribbon on Premium. */
export function TierCard3({
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
          <MeteorShower className="h-4 w-4 shrink-0" />
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
