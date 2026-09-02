'use client'

import * as React from 'react'
import { useTheme } from 'next-themes'

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
 */
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
        setTheme(nextTheme)
      }

      // If the browser supports the View Transitions API, wrap the theme
      // change in a transition so the new theme "wipes in" from the click
      // point. Otherwise, just change the theme directly (instant switch).
      const startViewTransition = (
        document as Document & {
          startViewTransition?: (cb: () => void) => void
        }
      ).startViewTransition

      if (typeof startViewTransition === 'function') {
        startViewTransition.call(document, mutate)
      } else {
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
