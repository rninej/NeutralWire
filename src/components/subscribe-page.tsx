'use client'

/**
 * subscribe-page.tsx — the DEDICATED subscription page (/subscribe).
 *
 * The header's Premium button lands here (the user spec: a real page, not
 * a dialog buried in Settings). One screen holds everything: the three
 * plans (Free / Premium / Ultra with the meteor-shower mark), the inline
 * account step for logged-out visitors, and the live Ko-fi checkout with
 * the claim-code panel. Teaser clicks elsewhere in the app still open the
 * compact UpgradeDialog; this page is the full-fat destination.
 */

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  ArrowLeft,
  Check,
  Loader2,
  Lock,
  LogOut,
  Mail,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  MeteorShower,
  PremiumDiamond,
  TierCard3,
  KofiCheckoutPanel,
  FREE_FEATURES,
  PREMIUM_FEATURES,
  ULTRA_FEATURES,
  type TierId,
} from '@/components/premium-ui'
import {
  SubscriptionProvider,
  useSubscription,
  SUBSCRIPTION_CHANGED_EVENT,
  getClientDeviceId,
  KOFI_PAGE_URL,
} from '@/lib/subscription-client'

type AuthMode = 'choose' | 'signin' | 'register'

export function SubscribePage() {
  return (
    <SubscriptionProvider>
      <SubscribePageInner />
    </SubscriptionProvider>
  )
}

function SubscribePageInner() {
  const router = useRouter()
  const sub = useSubscription()
  const [selectedTier, setSelectedTier] = React.useState<TierId>('premium')
  const [authMode, setAuthMode] = React.useState<AuthMode>('choose')
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [kofi, setKofi] = React.useState<{
    tier: 'premium' | 'ultra'
    code: string
    url: string
    email?: string
  } | null>(null)

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
      setAuthMode('choose')
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

  const startCheckout = async (tier: 'premium' | 'ultra') => {
    setSelectedTier(tier)
    if (!sub.loggedIn) {
      setError(null)
      setAuthMode('register')
      // Scroll the auth card into view on mobile.
      document.getElementById('nw-auth-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
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
      if (data.mode === 'kofi' && data.code) {
        setKofi({ tier, code: data.code, url: data.url || KOFI_PAGE_URL, email: data.email })
        window.scrollTo({ top: 0, behavior: 'smooth' })
      }
    } catch {
      setError('Network error — try again.')
    } finally {
      setBusy(false)
    }
  }

  const premium = sub.tier === 'premium' || sub.tier === 'ultra'
  const price = sub.pricing.premium
  const ultraPrice = sub.pricing.ultra

  // The inline account step — shared by BOTH page states (a logged-out
  // visitor with a device-granted tier ALSO needs it to upgrade).
  const authCard = !sub.loggedIn ? (
    <div id="nw-auth-card" className="mt-4 rounded-2xl border bg-muted/20 p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Lock className="h-4 w-4 text-muted-foreground" />
        An account keeps your subscription on every device
      </div>
      {authMode === 'choose' ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={() => setAuthMode('register')}>
              <Mail className="h-4 w-4" /> Sign up with email
            </Button>
            <Button variant="outline" onClick={() => setAuthMode('signin')}>
              <Lock className="h-4 w-4" /> Sign in
            </Button>
          </div>
          <p className="text-center text-[11px] text-muted-foreground">
            Google &amp; Apple sign-in arrive with their API keys — email works today.
          </p>
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
  ) : null

  return (
    <div className="min-h-dvh bg-background">
      {/* ── Top bar ── */}
      <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-2 px-4">
          <Button variant="ghost" size="sm" onClick={() => router.push('/')} className="gap-1.5">
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">Back to your feed</span>
            <span className="sm:hidden">Back</span>
          </Button>
          <div className="ml-auto flex items-center gap-1.5 text-sm font-bold">
            <PremiumDiamond className="h-4 w-4" />
            Plans
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-16 pt-6">
        {/* ── Hero ── */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="text-center"
        >
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400/20 to-amber-600/10 ring-1 ring-amber-500/30">
            <MeteorShower className="h-9 w-9" />
          </div>
          <h1 className="text-2xl font-extrabold leading-tight sm:text-3xl">
            Support NeutralWire, unlock the newsroom
          </h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            Free stays free — every story, the bias bar, all sources. Premium builds your own
            newsroom; Ultra opens the pipes. Prices localise automatically
            ({price.display} / {ultraPrice.display} shown for you).
          </p>
        </motion.div>

        {/* ── Ko-fi pay panel (after checkout starts) ── */}
        {kofi ? (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-6"
          >
            <KofiCheckoutPanel
              tier={kofi.tier}
              code={kofi.code}
              url={kofi.url}
              email={kofi.email}
              onDone={() => router.push(`/?subscribed=1&tier=${kofi.tier}`)}
            />
            <button
              type="button"
              onClick={() => setKofi(null)}
              className="mx-auto mt-3 block text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              ← Back to the plans
            </button>
          </motion.div>
        ) : sub.tier !== 'free' && sub.model === 'subscription' ? (
          /* ── Already subscribed ── */
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-6 space-y-3"
          >
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4">
              <div className="flex min-w-0 items-center gap-3">
                {sub.tier === 'ultra' ? (
                  <MeteorShower className="h-8 w-8 shrink-0" />
                ) : (
                  <PremiumDiamond className="h-8 w-8 shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="font-bold">
                    You&apos;re {sub.tier === 'ultra' ? 'Ultra' : 'Premium'}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {sub.account?.email}
                    {sub.renewsAt ? ` · renews ${new Date(sub.renewsAt).toLocaleDateString()}` : ''}
                  </div>
                </div>
              </div>
            </div>
            {sub.tier === 'premium' ? (
              <Button className="w-full" size="lg" onClick={() => startCheckout('ultra')} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MeteorShower className="h-5 w-5" />}
                Upgrade to Ultra — {ultraPrice.display}/month
              </Button>
            ) : null}
            {authCard}
            {error ? (
              <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                {error}
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={() => router.push('/')}>
                Back to my feed
              </Button>
              <Button variant="ghost" onClick={signOut} disabled={busy} className="text-muted-foreground">
                <LogOut className="h-4 w-4" /> Sign out
              </Button>
            </div>
          </motion.div>
        ) : (
          <>
            {/* ── Tier cards ── */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
              className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-2.5"
            >
              <TierCard3
                id="free"
                selected={false}
                current={sub.tier === 'free'}
                onSelect={() => {}}
                name="Free"
                price={`${price.symbol}0`}
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
            </motion.div>

            {/* ── Auth (logged out) — the shared inline account step ── */}
            {authCard}

            {/* ── Checkout CTA ── */}
            <Button
              className="mt-4 w-full"
              size="lg"
              onClick={() => startCheckout(selectedTier === 'ultra' ? 'ultra' : 'premium')}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : selectedTier === 'ultra' ? (
                <MeteorShower className="h-5 w-5" />
              ) : (
                <PremiumDiamond className="h-5 w-5" />
              )}
              {sub.loggedIn
                ? `Get ${selectedTier === 'ultra' ? 'Ultra' : 'Premium'} — ${(selectedTier === 'ultra' ? ultraPrice : price).display}/month`
                : `Continue — ${(selectedTier === 'ultra' ? ultraPrice : price).display}/month`}
            </Button>

            {error ? (
              <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                {error}
              </div>
            ) : null}

            {/* ── Trust lines ── */}
            <div className="mt-5 space-y-1.5 text-center text-[11px] text-muted-foreground">
              <p className="flex items-center justify-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                Payments run through Ko-fi — cancel anytime, keep the rest of the month.
              </p>
              <p className="flex items-center justify-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                Every premium feature stays VISIBLE while free — you always know what you&apos;re
                unlocking.
              </p>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
