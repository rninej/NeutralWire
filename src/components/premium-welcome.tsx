'use client'

/**
 * premium-welcome.tsx — the post-upgrade guided tour.
 *
 * When a visitor's tier just went UP (checkout grant — test mode or the
 * Stripe `?subscribed=1&tier=` return — /debug grant, or signing in to a
 * higher-tier account) this sheet celebrates the upgrade and WALKS THEM
 * THROUGH what they just unlocked, with a button on every step that does
 * the thing directly:
 *
 *   1. Add premium subtopics  → opens the SubtopicPicker right here
 *   2. Pick a header style    → Account → Feed (10 designs, Premium-gated)
 *   3. Gradient themes        → Account → Theme
 *   4. AI email digest        → Account → Alerts
 *   5. (Ultra) API + export   → Account → Profile
 *
 * Triggers:
 *   • PREMIUM_WELCOME_EVENT (fired by the SubscriptionProvider's
 *     tier-increase detection + the UpgradeDialog's test-mode grant)
 *   • mount-time URL param ?subscribed=1&tier=premium|ultra (the Stripe
 *     checkout return redirect — a full page reload, so the provider's
 *     baseline fetch IS the upgraded state and the event never fires).
 *
 * Shown ONCE per tier (localStorage `neutralwire:premium-welcome:<tier>`),
 * stamped at OPEN so a mid-tour navigation never re-triggers it.
 * Donation model: never shows (nothing is gated).
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Sparkles, Palette, Bell, KeyRound, LayoutGrid, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { PremiumDiamond } from '@/components/premium-ui'
import {
  useSubscription,
  PREMIUM_WELCOME_EVENT,
  type Tier,
} from '@/lib/subscription-client'

export type AccountTab = 'profile' | 'feed' | 'theme' | 'alerts'

const DISMISS_KEY = (tier: Tier) => `neutralwire:premium-welcome:${tier}`

function dismissed(tier: Tier): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY(tier)) === '1'
  } catch {
    return false
  }
}

export function PremiumWelcome({
  onOpenAccount,
}: {
  /** Opens the Account sheet at the given tab (parent owns the sheet). */
  onOpenAccount: (tab: AccountTab) => void
}) {
  const sub = useSubscription()
  const [tier, setTier] = React.useState<'premium' | 'ultra'>('premium')
  const [open, setOpen] = React.useState(false)
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

  // Lazy-load the picker only when first opened (code-splitting) — the
  // same lazy import AddTopicChip uses.
  const SubtopicPicker = React.useMemo(
    () =>
      React.lazy(() =>
        import('@/components/subtopic-picker').then((m) => ({
          default: m.SubtopicPicker,
        })),
      ),
    [],
  )

  const openFor = React.useCallback((t: 'premium' | 'ultra') => {
    // Stamp the dismissal AT OPEN — the tour shows once per tier even if
    // the visitor navigates away mid-tour or refreshes.
    try {
      localStorage.setItem(DISMISS_KEY(t), '1')
    } catch {}
    setTier(t)
    setOpen(true)
    setPickerOpen(false)
  }, [])

  // ── Trigger 1: the welcome event (provider tier-increase detection,
  //    UpgradeDialog test-mode grant, /debug grants). ──
  React.useEffect(() => {
    const onWelcome = (e: Event) => {
      const detail = (e as CustomEvent).detail as { tier?: Tier } | undefined
      const t = detail?.tier === 'ultra' ? 'ultra' : 'premium'
      if (dismissed(t)) return
      openFor(t)
    }
    window.addEventListener(PREMIUM_WELCOME_EVENT, onWelcome)
    return () => window.removeEventListener(PREMIUM_WELCOME_EVENT, onWelcome)
  }, [openFor])

  // ── Trigger 2: Stripe checkout return — ?subscribed=1&tier=… ──
  // A full page reload lands here with the session cookie already set;
  // wait for the provider's first /me fetch to confirm the tier, then
  // celebrate. The param is stripped either way (no re-trigger on
  // refresh).
  React.useEffect(() => {
    if (sub.loading) return
    const params = new URLSearchParams(window.location.search)
    if (params.get('subscribed') !== '1') return
    const t = params.get('tier') === 'ultra' ? 'ultra' : 'premium'
    // Clean the URL FIRST so a later navigation/refresh never re-fires.
    params.delete('subscribed')
    params.delete('tier')
    const qs = params.toString()
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`,
    )
    // Only celebrate when the account really IS on that tier (the GET
    // return leg already granted it; belt-and-suspenders for webhook lag
    // is NOT wanted here — a lagging webhook shows the account still
    // free, in which case skip: the provider detection will catch the
    // tier landing later).
    if (sub.model === 'subscription' && sub.tier === t && !dismissed(t)) {
      openFor(t)
    }
  }, [sub.loading, sub.tier, sub.model])

  // Escape closes.
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // Lock body scroll while open (the picker locks it too — the previous
  // value is restored by whoever unlocks last, and both save/restore the
  // same pre-lock value, so nesting is safe).
  React.useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  if (!mounted) return null

  const isUltra = tier === 'ultra'

  const steps: Array<{
    icon: React.ReactNode
    title: string
    body: string
    action: string
    onClick: () => void
    accent?: boolean
  }> = [
    {
      icon: <Sparkles className="h-5 w-5" />,
      title: 'Add premium subtopics',
      body: 'Chess, Mars missions, quantum computing — 550+ topics for your header, or let AI create any topic you can name.',
      action: 'Add subtopics',
      onClick: () => setPickerOpen(true),
      accent: true,
    },
    {
      icon: <LayoutGrid className="h-5 w-5" />,
      title: 'Pick your header style',
      body: 'Big chips, bold tabs, maxi pills… 10 header designs — your pick, saved to your account.',
      action: 'Choose a style',
      onClick: () => {
        setOpen(false)
        onOpenAccount('feed')
      },
    },
    {
      icon: <Palette className="h-5 w-5" />,
      title: 'Gradient themes',
      body: 'Colour the feed your way — Premium unlocks every gradient theme, light and dark.',
      action: 'Browse themes',
      onClick: () => {
        setOpen(false)
        onOpenAccount('theme')
      },
    },
    {
      icon: <Bell className="h-5 w-5" />,
      title: 'AI email digest',
      body: 'A neutral briefing of YOUR topics in your inbox — weekly, daily, or 3× a day.',
      action: 'Set up digest',
      onClick: () => {
        setOpen(false)
        onOpenAccount('alerts')
      },
    },
    ...(isUltra
      ? [
          {
            icon: <KeyRound className="h-5 w-5" />,
            title: 'Feed API + article export',
            body: 'Your Ultra API key serves the live feed to any app — and every article exports as Markdown, text or JSON.',
            action: 'Get your API key',
            onClick: () => {
              setOpen(false)
              onOpenAccount('profile')
            },
          },
        ]
      : []),
  ]

  return (
    <>
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-4"
              onClick={() => setOpen(false)}
              role="dialog"
              aria-modal="true"
              aria-label={`Welcome to ${isUltra ? 'Ultra' : 'Premium'}`}
            >
              <motion.div
                initial={{ y: 40, opacity: 0, scale: 0.98 }}
                animate={{ y: 0, opacity: 1, scale: 1 }}
                exit={{ y: 40, opacity: 0, scale: 0.98 }}
                transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                onClick={(e) => e.stopPropagation()}
                className="flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-2xl border bg-background shadow-2xl sm:rounded-2xl"
              >
                {/* Celebration header */}
                <div className="relative overflow-hidden border-b p-4 pb-4 sm:p-5">
                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-amber-500/15 via-transparent to-amber-500/5" />
                  {/* drifting diamonds */}
                  <motion.div
                    className="pointer-events-none absolute left-6 top-2 opacity-30"
                    animate={{ y: [0, 6, 0], rotate: [0, 10, 0] }}
                    transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                  >
                    <PremiumDiamond className="h-4 w-4" />
                  </motion.div>
                  <motion.div
                    className="pointer-events-none absolute right-10 top-4 opacity-20"
                    animate={{ y: [0, -5, 0], rotate: [0, -12, 0] }}
                    transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
                  >
                    <PremiumDiamond className="h-3 w-3" />
                  </motion.div>
                  <div className="relative flex items-start gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/20">
                      <PremiumDiamond className="h-7 w-7" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h2 className="text-lg font-bold leading-tight">
                        Welcome to {isUltra ? 'Ultra' : 'Premium'}!
                      </h2>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        You just unlocked the full NeutralWire. Here&apos;s your 60-second
                        setup — every button below does the thing.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setOpen(false)}
                      aria-label="Close"
                      className="relative rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {/* Guide steps */}
                <div className="nw-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-3 sm:p-4">
                  {steps.map((s, i) => (
                    <motion.div
                      key={s.title}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.06 * i, duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                      className={cn(
                        'flex items-start gap-3 rounded-xl border p-3 sm:p-3.5',
                        s.accent
                          ? 'border-amber-500/40 bg-amber-500/[0.07]'
                          : 'border-border bg-muted/20',
                      )}
                    >
                      <div
                        className={cn(
                          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                          s.accent ? 'bg-amber-500/20 text-amber-500' : 'bg-muted text-foreground/70',
                        )}
                      >
                        {s.icon}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold">{s.title}</div>
                        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground sm:text-[13px]">
                          {s.body}
                        </p>
                        <button
                          type="button"
                          onClick={s.onClick}
                          className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-amber-600 transition-colors hover:text-amber-500 dark:text-amber-400 dark:hover:text-amber-300"
                        >
                          {s.action}
                          <ArrowRight className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </motion.div>
                  ))}
                  <p className="px-1 pb-1 pt-0.5 text-center text-[11px] text-muted-foreground">
                    Manage or cancel anytime from your Account page.
                  </p>
                </div>

                {/* Footer */}
                <div className="border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4">
                  <Button onClick={() => setOpen(false)} className="w-full" size="default">
                    Start reading
                  </Button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}

      {/* The picker instance: opened by the first guide step, portalled to
          body by SubtopicPicker itself (backdrop-filter trap — the same
          lesson as every other sheet). The welcome stays behind it — the
          picker's z-[75] stacks above the welcome's z-[70]. */}
      {pickerOpen && (
        <React.Suspense fallback={null}>
          <SubtopicPicker onClose={() => setPickerOpen(false)} />
        </React.Suspense>
      )}
    </>
  )
}
