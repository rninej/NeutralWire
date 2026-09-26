'use client'

/**
 * subscription-client.tsx — client-side subscription state for every gate.
 *
 * One provider mounted high in page-client (and reused by the story page's
 * export button). Fetches /api/subscription/me ONCE per load (+ on demand
 * refresh after login/checkout) and exposes:
 *
 *   useSubscription() → { tier, model, entitlements, pricing, account,
 *                          refresh, openUpgrade, closeUpgrade }
 *
 * Any component can ALSO open the upgrade dialog without prop drilling:
 *   window.dispatchEvent(new CustomEvent('neutralwire:upgrade-open',
 *     { detail: { feature: 'archiveSearch' } }))
 */

import * as React from 'react'

export type Tier = 'free' | 'premium' | 'ultra'
export type Model = 'donation' | 'subscription'

export interface Entitlements {
  customSubtopics: boolean
  archiveSearchOld: boolean
  emailDigest: boolean
  gradientThemes: boolean
  personalFlags: boolean
  apiAccess: boolean
  articleExport: boolean
}

export interface PriceQuote {
  currency: string
  symbol: string
  amount: number
  display: string
}

export interface SubscriptionState {
  loading: boolean
  tier: Tier
  model: Model
  account: { email: string } | null
  loggedIn: boolean
  renewsAt: number | null
  entitlements: Entitlements
  pricing: { premium: PriceQuote; ultra: PriceQuote; country: string }
  payments: { provider: string }
}

const DEFAULT_STATE: SubscriptionState = {
  loading: true,
  tier: 'free',
  model: 'subscription',
  account: null,
  loggedIn: false,
  renewsAt: null,
  entitlements: {
    customSubtopics: false,
    archiveSearchOld: false,
    emailDigest: false,
    gradientThemes: false,
    personalFlags: false,
    apiAccess: false,
    articleExport: false,
  },
  pricing: {
    premium: { currency: 'USD', symbol: '$', amount: 3, display: '$3' },
    ultra: { currency: 'USD', symbol: '$', amount: 20, display: '$20' },
    country: 'US',
  },
  payments: { provider: 'test' },
}

// ── Device id (mirrors referral.ts — same localStorage key) ──
export function getClientDeviceId(): string {
  if (typeof window === 'undefined') return ''
  try {
    let id = localStorage.getItem('neutralwire:device-id')
    return id || ''
  } catch {
    return ''
  }
}

// ── The upgrade-dialog open/close event bus ──
export const UPGRADE_OPEN_EVENT = 'neutralwire:upgrade-open'
export const UPGRADE_CLOSE_EVENT = 'neutralwire:upgrade-close'
/** Fired after login/checkout/logout so every consumer re-reads state. */
export const SUBSCRIPTION_CHANGED_EVENT = 'neutralwire:subscription-changed'

export type UpgradeFeature =
  | 'customSubtopics'
  | 'archiveSearchOld'
  | 'emailDigest'
  | 'gradientThemes'
  | 'personalFlags'
  | 'apiAccess'
  | 'articleExport'
  | 'premium'

export function openUpgradeDialog(feature?: UpgradeFeature): void {
  window.dispatchEvent(
    new CustomEvent(UPGRADE_OPEN_EVENT, { detail: { feature: feature || 'premium' } }),
  )
}

// ── Context ──
interface SubscriptionContextValue extends SubscriptionState {
  refresh: () => Promise<void>
}

const SubscriptionContext = React.createContext<SubscriptionContextValue>({
  ...DEFAULT_STATE,
  refresh: async () => {},
})

export function SubscriptionProvider({
  children,
  initialModel,
}: {
  children: React.ReactNode
  /** SSR-provided monetization model ('donation' | 'subscription') so the
   *  first paint already knows which popup system runs — the /me fetch
   *  refines it (plus tier/account) right after. */
  initialModel?: 'donation' | 'subscription'
}) {
  const [state, setState] = React.useState<SubscriptionState>({
    ...DEFAULT_STATE,
    model: initialModel || 'subscription',
  })

  const refresh = React.useCallback(async () => {
    try {
      const deviceId = getClientDeviceId()
      const url = `/api/subscription/me${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''}`
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error('failed')
      const data = (await res.json()) as Partial<SubscriptionState>
      setState((prev) => ({ ...prev, ...data, loading: false }))
    } catch {
      setState((prev) => ({ ...prev, loading: false }))
    }
  }, [])

  React.useEffect(() => {
    void refresh()
    const onChanged = () => void refresh()
    window.addEventListener(SUBSCRIPTION_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(SUBSCRIPTION_CHANGED_EVENT, onChanged)
  }, [refresh])

  return (
    <SubscriptionContext.Provider value={{ ...state, refresh }}>
      {children}
    </SubscriptionContext.Provider>
  )
}

export function useSubscription(): SubscriptionContextValue {
  return React.useContext(SubscriptionContext)
}

/** Convenience: is a given premium feature unlocked for this visitor? */
export function useFeatureUnlocked(feature: UpgradeFeature): boolean {
  const { model, entitlements, loading } = useSubscription()
  if (model === 'donation') return true // donation model = everything unlocked
  if (loading) return false
  return Boolean(entitlements[feature])
}
