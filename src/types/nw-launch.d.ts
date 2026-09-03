/**
 * Window.__NW_LAUNCH — the PWA launch-splash contract.
 *
 * Set synchronously in <head> by the launch-gate script in layout.tsx
 * BEFORE first paint; the adaptive controller script (also in layout.tsx)
 * then augments it. page-client consumes it to hand off the splash.
 *
 * Gate (immediately available):
 *   standalone — display-mode is standalone/minimal-ui (installed PWA)
 *   navType    — NavigationTiming type of this document load
 *   playing    — the splash is showing this load (standalone + fresh
 *                'navigate'); false in every browser tab, on every
 *                reload/back-forward.
 *
 * Controller (only defined when playing):
 *   ready()    — called ONCE by page-client after the first feed content
 *                has rendered; releases the splash (after the minimum
 *                brand beat) so it fades into a fully loaded page.
 *   released   — set true when the release fired (debug/testing).
 *   reason     — 'ready' (app signal) or 'timeout' (2.6s hard cap).
 */
export {}

declare global {
  interface Window {
    __NW_LAUNCH?: {
      standalone?: boolean
      navType?: string
      playing?: boolean
      ready?: () => void
      released?: boolean
      reason?: 'ready' | 'timeout'
    }
  }
}
