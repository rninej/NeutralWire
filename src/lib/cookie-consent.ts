'use client'

/**
 * cookie-consent.ts — shared cookie-consent state for NeutralWire.
 *
 * The FIRST popup any new visitor sees (before the PWA install prompt,
 * onboarding quiz, or anything else). Exactly TWO choices, per the
 * product decision:
 *   • 'accepted'  — Accept all              → analytics + telemetry run
 *   • 'rejected'  — Reject non-necessary    → analytics + telemetry stay OFF
 *
 * Stored in localStorage (not an actual cookie) so it survives forever
 * on the device, is trivially readable pre-hydration, and never expires.
 *
 * A CustomEvent (`neutralwire:cookies-chosen`) is dispatched on every
 * choice so other components (install prompt, onboarding, analytics
 * tracker) can react INSTANTLY instead of polling.
 *
 * What counts as "necessary" (always on, cannot be rejected):
 *   - news fetching + the Firebase news cache (the service itself)
 *   - settings stored on-device (theme, interests, header style, language)
 *   - push notifications (only ever enabled by explicit user action)
 *   - referral tracking (only when the user opens a ?ref= link / shares)
 * What is "non-necessary" (OFF when rejected):
 *   - page-view analytics pings (/api/analytics/track)
 *   - Vercel Web Analytics events
 */

export type CookieChoice = 'accepted' | 'rejected'

const CHOICE_KEY = 'neutralwire:cookies-choice'
export const COOKIE_CHOICE_EVENT = 'neutralwire:cookies-chosen'

interface StoredChoice {
  v: CookieChoice
  ts: number
}

function parse(raw: string | null): StoredChoice | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as StoredChoice
    if (parsed?.v === 'accepted' || parsed?.v === 'rejected') return parsed
  } catch {
    // corrupted entry — treat as no choice so the popup re-shows
  }
  return null
}

/** The stored choice, or null if the visitor hasn't chosen yet. */
export function getCookieChoice(): CookieChoice | null {
  if (typeof window === 'undefined') return null
  try {
    return parse(localStorage.getItem(CHOICE_KEY))?.v ?? null
  } catch {
    return null
  }
}

/** True once the visitor has made ANY choice (accept or reject). */
export function hasCookieChoice(): boolean {
  return getCookieChoice() !== null
}

/** True only when the visitor explicitly accepted analytics. */
export function analyticsAllowed(): boolean {
  return getCookieChoice() === 'accepted'
}

/**
 * Persist a choice + notify every listener (install prompt, onboarding,
 * analytics tracker, …). Safe to call multiple times.
 */
export function setCookieChoice(choice: CookieChoice): void {
  if (typeof window === 'undefined') return
  try {
    const stored: StoredChoice = { v: choice, ts: Date.now() }
    localStorage.setItem(CHOICE_KEY, JSON.stringify(stored))
  } catch {
    // localStorage blocked (private mode) — keep the in-memory event flow
    // working so this session still behaves correctly.
  }
  window.dispatchEvent(
    new CustomEvent(COOKIE_CHOICE_EVENT, { detail: { choice } }),
  )
}

/**
 * Subscribe to consent decisions (fires ONLY when a choice is made —
 * not on mount). Returns an unsubscribe function.
 */
export function onCookieChoice(
  handler: (choice: CookieChoice) => void,
): () => void {
  if (typeof window === 'undefined') return () => {}
  const listener = (e: Event) => {
    const choice = (e as CustomEvent<{ choice?: CookieChoice }>).detail?.choice
    if (choice === 'accepted' || choice === 'rejected') handler(choice)
  }
  window.addEventListener(COOKIE_CHOICE_EVENT, listener)
  return () => window.removeEventListener(COOKIE_CHOICE_EVENT, listener)
}
