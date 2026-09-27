/**
 * popup-mode.ts — which popup system the whole site runs.
 *
 * THREE selectable systems, flipped for ALL users from /debug (stored in
 * Firebase at featureFlags/popupSystem, read server-side in page.tsx so
 * the first paint already knows which components to mount):
 *
 *   'original'          — the classic popups from before the behavioral
 *                         rewrite: the early install banner (3s nudge /
 *                         first story / 400px scroll, 1-hour re-ask) on the
 *                         mobile website, plus the Ko-fi donation popup in
 *                         the installed PWA (every 10 stories opened).
 *
 *   'smart'             — the research-grounded system (default, live):
 *                         install sheet that only asks at peak-motivation
 *                         moments (finished story, voted, 2–3 stories
 *                         opened, 75s engaged) with the phone home-screen
 *                         mock + honest social proof; inside the PWA, a
 *                         milestone celebration replaces the donate popup.
 *
 *   'smart-firstvisit'  — the smart system, but a brand-new visitor's
 *                         VERY FIRST visit still shows the classic install
 *                         popup (the early, high-visibility one). The smart
 *                         engine politely stands down during that first
 *                         visit and owns everything from visit two on.
 *
 * WHY A SEPARATE DISMISS MEMORY: the classic first-visit popup uses
 * ':fv'-suffixed localStorage keys (see pwa-install-prompt-legacy.tsx), so
 * dismissing it during visit #1 does NOT snooze the smart engine — the
 * behavioral memory stays pristine for visit #2.
 */

export type PopupMode = 'original' | 'smart' | 'smart-firstvisit'

export const POPUP_MODES: PopupMode[] = ['original', 'smart', 'smart-firstvisit']

/** Anything unknown (or a not-yet-set flag) safely degrades to the live
 *  behavioral system — a missing flag must never resurrect the old popups. */
export const DEFAULT_POPUP_MODE: PopupMode = 'smart'

export function normalizePopupMode(v: unknown): PopupMode {
  return POPUP_MODES.includes(v as PopupMode) ? (v as PopupMode) : DEFAULT_POPUP_MODE
}

// ── First-visit session tracking ────────────────────────────────────────
// "First visit" = the very first time this browser ever loads NeutralWire,
// INCLUDING same-tab refreshes, and ENDING when the tab closes (the
// sessionStorage marker dies) or a story has been opened on an earlier
// occasion.

export const FIRST_SEEN_KEY = 'neutralwire:first-seen'
const FV_SESSION_KEY = 'neutralwire:first-visit-live'

/**
 * Create the first-seen timestamp if this browser has never been here
 * before, and (at that same moment) mark the CURRENT TAB as hosting the
 * first visit. Idempotent — every popup component calls it on mount.
 * Returns the first-seen timestamp.
 */
export function ensureFirstSeen(): number {
  try {
    let firstSeen = parseInt(localStorage.getItem(FIRST_SEEN_KEY) || '0', 10)
    if (!firstSeen) {
      firstSeen = Date.now()
      localStorage.setItem(FIRST_SEEN_KEY, String(firstSeen))
    }
    // The session marker is only ever written while no first-seen existed
    // a moment ago — i.e. only on the true first visit.
    if (!sessionStorage.getItem(FV_SESSION_KEY)) {
      const articlesOpened = parseInt(
        localStorage.getItem('neutralwire:articles-opened') || '0',
        10,
      )
      // A browser that has already opened stories has been here before —
      // never (re)arm the first-visit popup for it.
      if (!articlesOpened) {
        try {
          sessionStorage.setItem(FV_SESSION_KEY, '1')
        } catch {}
      }
    }
    return firstSeen
  } catch {
    return Date.now()
  }
}

/** Is the CURRENT TAB still inside the user's very first visit? */
export function isFirstVisitSession(): boolean {
  try {
    return sessionStorage.getItem(FV_SESSION_KEY) === '1'
  } catch {
    return false
  }
}

/** Kill the marker (used when the visitor answers the first-visit popup
 *  by installing, so nothing else asks again in this session). */
export function endFirstVisitSession(): void {
  try {
    sessionStorage.removeItem(FV_SESSION_KEY)
  } catch {}
}
