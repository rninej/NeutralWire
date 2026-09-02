'use client'

import * as React from 'react'
import { useTheme } from 'next-themes'
import { syncThemeClassNow } from '@/lib/theme-families'

/**
 * Hook that returns a function to set the theme with a circular reveal
 * animation. Uses the View Transitions API where supported (Chrome / Edge /
 * Safari 18+); falls back to an instant theme switch on Firefox + older
 * browsers (still functional, just no animation).
 *
 * Usage (modern, family/mode controller):
 *   const setThemeWithReveal = useThemeReveal()
 *   <button onClick={(e) => setThemeWithReveal(null, e, () => controller.toggleMode())}>
 *
 * Legacy usage (direct theme value) still works:
 *   setThemeWithReveal('midnight', e)
 *
 * The click position is set as CSS custom properties on <html>
 * (--theme-reveal-x / --theme-reveal-y) so the ::view-transition-new(root)
 * rule in globals.css can use them in its clip-path animation.
 *
 * Gradient handling: when `run` is provided, gradient clearing is the
 * controller's job (theme-families.ts clears the overlay whenever the
 * effective mode is light). When a direct nextTheme value is passed, this
 * wrapper keeps the legacy behaviour: clearing the gradient for any solid
 * theme.
 *
 * ── Robustness (why the toggle "sometimes didn't click") ──
 *  1. If document.startViewTransition() throws (document not fully active,
 *     mid-navigation, …) the old code never called mutate() — the click did
 *     literally nothing. Now: try/catch with a direct mutate() fallback, so
 *     the theme ALWAYS changes.
 *  2. If a previous reveal transition is still running when a new one
 *     starts, some engines leave a frozen old-snapshot overlay over the
 *     page — clicks after that looked dead. Now: any in-flight transition
 *     is skipped (overlay torn down) before the new one starts.
 *  3. Safety net: if a transition doesn't settle within ~1.2s (stuck
 *     animation, engine bug), skipTransition() is called automatically so
 *     the page can never stay frozen.
 */

interface VtLike {
  skipTransition?: () => void
  finished?: Promise<unknown>
}

/** The currently running reveal transition (module-level: one at a time). */
let activeVt: { settled: boolean; skip: () => void } | null = null

/** How long to wait before force-skipping a stuck view transition. */
const STUCK_TRANSITION_MS = 1200

/** Tear down any in-flight reveal so its overlay can never freeze the page. */
function teardownActiveVt() {
  if (activeVt && !activeVt.settled) {
    try {
      activeVt.skip()
    } catch {}
  }
  activeVt = null
}

export function useThemeReveal() {
  const { setTheme } = useTheme()

  return React.useCallback(
    (
      nextTheme: string | null,
      event?: { clientX: number; clientY: number },
      run?: () => void,
    ) => {
      // Default to center of viewport if no event provided.
      const x = event?.clientX ?? window.innerWidth / 2
      const y = event?.clientY ?? window.innerHeight / 2

      // Set the reveal origin as CSS custom properties on <html>.
      const root = document.documentElement
      root.style.setProperty('--theme-reveal-x', `${x}px`)
      root.style.setProperty('--theme-reveal-y', `${y}px`)

      const mutate = () => {
        if (run) {
          run()
          return
        }
        if (!nextTheme) return

        // ── Legacy direct-value path ──
        // Clear the gradient when switching to a solid theme (the
        // 'gradient' theme id itself is managed by the gradient presets).
        if (nextTheme !== 'gradient') {
          root.classList.remove('gradient-theme')
          root.style.removeProperty('--gradient-bg')
          try {
            localStorage.removeItem('neutralwire:gradient')
            window.dispatchEvent(new CustomEvent('neutralwire:gradient-changed'))
          } catch {}
        }
        // Apply the class synchronously (next-themes' effect lands later),
        // then let next-themes persist + re-apply it.
        syncThemeClassNow(nextTheme)
        setTheme(nextTheme)
      }

      // If the browser supports the View Transitions API, wrap the theme
      // change in a transition so the new theme "wipes in" from the click
      // point. Otherwise, just change the theme directly (instant switch).
      const startViewTransition = (
        document as Document & {
          startViewTransition?: (cb: () => void) => VtLike
        }
      ).startViewTransition

      // A previous reveal still animating? Tear its overlay down first —
      // starting a new transition on top of a live one is exactly the
      // state where engines sometimes freeze the old snapshot over the
      // page (clicks then appear to do nothing).
      teardownActiveVt()

      if (typeof startViewTransition !== 'function') {
        mutate()
        return
      }

      try {
        const vt = startViewTransition.call(document, mutate)
        if (vt && typeof vt.skipTransition === 'function') {
          const guard = {
            settled: false,
            skip: () => {
              try {
                vt.skipTransition?.()
              } catch {}
            },
          }
          activeVt = guard
          // Force the overlay off if the transition never settles (stuck
          // animation / engine bug) so the page is never left frozen.
          const timer = setTimeout(() => {
            if (activeVt === guard && !guard.settled) guard.skip()
          }, STUCK_TRANSITION_MS)
          const settle = () => {
            guard.settled = true
            clearTimeout(timer)
            if (activeVt === guard) activeVt = null
          }
          vt.finished?.then(settle, settle)
        }
      } catch {
        // startViewTransition can throw (e.g. mid-navigation). Fall back to
        // an instant, animation-less theme change — never swallow the click.
        mutate()
      }
    },
    [setTheme],
  )
}

/**
 * Restore a saved gradient on page load.
 *
 * Call this in a useEffect on mount (e.g. in layout or page-client).
 * If the user previously applied a gradient (stored in localStorage),
 * this re-applies it: adds the 'gradient-theme' class to <html> and
 * sets the --gradient-bg CSS variable.
 *
 * This makes gradients persist across page refreshes.
 */
export function restoreGradient() {
  if (typeof window === 'undefined') return
  try {
    const saved = localStorage.getItem('neutralwire:gradient')
    if (saved) {
      const root = document.documentElement
      root.classList.add('gradient-theme')
      root.style.setProperty('--gradient-bg', saved)
    }
  } catch {
    // localStorage might be blocked — silent
  }
}

/** Remove the gradient overlay (used when a light mode becomes active —
 *  gradients are designed for dark surfaces only). Exported for
 *  theme-families.ts. */
export function clearGradientOverlay() {
  if (typeof window === 'undefined') return
  const root = document.documentElement
  if (!root.classList.contains('gradient-theme')) return
  root.classList.remove('gradient-theme')
  root.style.removeProperty('--gradient-bg')
  try {
    localStorage.removeItem('neutralwire:gradient')
    window.dispatchEvent(new CustomEvent('neutralwire:gradient-changed'))
  } catch {}
}

/** Gradient presets — pre-made gradient backgrounds that can be applied on
 *  top of the dark theme. Each preset is a CSS gradient string.
 *  When the user picks a gradient, we:
 *    1. Set the base theme to dark (neutral family, dark mode)
 *    2. Set --gradient-bg CSS variable on <html>
 *    3. Add 'gradient-theme' class to <html>
 */
export const GRADIENT_PRESETS = [
  { id: 'aurora', label: 'Aurora', gradient: 'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)' },
  { id: 'sunset-blend', label: 'Sunset', gradient: 'linear-gradient(135deg, #2b1055 0%, #7597de 100%)' },
  { id: 'fire', label: 'Fire', gradient: 'linear-gradient(135deg, #2b0a0a 0%, #8b0000 50%, #ff4500 100%)' },
  { id: 'ocean-deep', label: 'Deep Ocean', gradient: 'linear-gradient(135deg, #000428 0%, #004e92 100%)' },
  { id: 'forest-mist', label: 'Forest Mist', gradient: 'linear-gradient(135deg, #134e5e 0%, #71b280 100%)' },
  { id: 'purple-haze', label: 'Purple Haze', gradient: 'linear-gradient(135deg, #1a0033 0%, #4b0082 50%, #8a2be2 100%)' },
  { id: 'peach', label: 'Peach', gradient: 'linear-gradient(135deg, #614385 0%, #5f72bd 100%)' },
  { id: 'mint', label: 'Mint', gradient: 'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)' },
  { id: 'rose-gold', label: 'Rose Gold', gradient: 'linear-gradient(135deg, #4b1f3a 0%, #c08597 100%)' },
  { id: 'steel', label: 'Steel', gradient: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)' },
] as const

export type ThemeId = string
