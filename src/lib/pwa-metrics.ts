'use client'

/**
 * Client-side PWA growth metrics reporter.
 *
 * Three lightweight beacons (all deduplicated in localStorage so extra
 * calls are harmless — the server dedupes by IP as well):
 *
 *   reportInstallMetric()  → 'install'    once, EVER, per browser
 *     fired on appinstalled + on the first standalone launch detected.
 *     Functional event (same precedent as /api/pwa-installed) — not
 *     consent-gated.
 *
 *   reportActiveMetric()   → 'active'     once per UTC day
 *     "this IP used NeutralWire today" (site or app). Non-necessary
 *     analytics — only sent after the visitor accepted cookies.
 *
 *   reportAppOpenMetric()  → 'app-open'   once per UTC day, PWA only
 *     "this IP opened the installed app today". Consent-gated, same
 *     rule as 'active'.
 *
 * Everything is fire-and-forget with sendBeacon → fetch keepalive
 * fallback. Metrics must never break the page.
 */

import { getCookieChoice, onCookieChoice } from '@/lib/cookie-consent'

const INSTALL_SENT_KEY = 'neutralwire:metric-install-sent'
const ACTIVE_DAY_KEY = 'neutralwire:metric-active-day'
const APP_OPEN_DAY_KEY = 'neutralwire:metric-appopen-day'

function utcDay(): string {
  return new Date().toISOString().slice(0, 10)
}

function send(type: 'install' | 'active' | 'app-open'): void {
  const payload = JSON.stringify({ type, ts: Date.now() })
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' })
      if (navigator.sendBeacon('/api/metrics/pwa', blob)) return
    }
  } catch {
    // fall through to fetch
  }
  try {
    fetch('/api/metrics/pwa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {})
  } catch {
    // silent
  }
}

/** Consent gate for analytics-class beacons. Runs fn() only when the
 *  visitor accepted cookies (or waits for the decision). */
function withConsent(fn: () => void): void {
  const choice = getCookieChoice()
  if (choice === 'accepted') {
    fn()
    return
  }
  if (choice === null) {
    // Undecided — wait for the banner answer, fire once if accepted.
    const unsub = onCookieChoice((c) => {
      if (c === 'accepted') fn()
    })
    // onCookieChoice returns an unsubscribe fn — hold it so the listener
    // can be dropped if never answered (page unload handles the rest).
    if (typeof unsub === 'function') {
      setTimeout(() => {
        try { unsub() } catch { /* already unsubscribed */ }
      }, 5 * 60 * 1000)
    }
  }
  // 'rejected' → never send analytics-class pings
}

/** Report a PWA install (functional event, no consent gate). */
export function reportInstallMetric(): void {
  if (typeof window === 'undefined') return
  try {
    if (localStorage.getItem(INSTALL_SENT_KEY) === 'true') return
    localStorage.setItem(INSTALL_SENT_KEY, 'true')
  } catch {
    // localStorage blocked — still send; server dedupes by IP/day anyway
  }
  send('install')
}

/** Report "this IP was active today" (consent-gated, 1/day). */
export function reportActiveMetric(): void {
  if (typeof window === 'undefined') return
  withConsent(() => {
    try {
      const day = localStorage.getItem(ACTIVE_DAY_KEY)
      if (day === utcDay()) return
      localStorage.setItem(ACTIVE_DAY_KEY, utcDay())
    } catch {
      // proceed — server dedupes
    }
    send('active')
  })
}

/** Report "the installed app was opened today" (consent-gated, 1/day). */
export function reportAppOpenMetric(): void {
  if (typeof window === 'undefined') return
  withConsent(() => {
    try {
      const day = localStorage.getItem(APP_OPEN_DAY_KEY)
      if (day === utcDay()) return
      localStorage.setItem(APP_OPEN_DAY_KEY, utcDay())
    } catch {
      // proceed — server dedupes
    }
    send('app-open')
  })
}

/** Public install counter for the install sheet's social proof.
 *  Resolves to null when the count is too low to be persuasive or the
 *  request failed — callers must treat null as "don't show". */
export async function fetchInstallCount(): Promise<number | null> {
  try {
    const res = await fetch('/api/metrics/pwa', { cache: 'no-store' })
    if (!res.ok) return null
    const data = (await res.json()) as { installs?: number }
    const installs = typeof data.installs === 'number' ? data.installs : 0
    // Below ~15 the number is weak social proof — hide it entirely.
    return installs >= 15 ? installs : null
  } catch {
    return null
  }
}
