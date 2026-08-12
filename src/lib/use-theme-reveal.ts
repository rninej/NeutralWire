'use client'

import * as React from 'react'
import { useTheme } from 'next-themes'

/**
 * Hook that returns a function to set the theme with a circular reveal
 * animation. Uses the View Transitions API where supported (Chrome / Edge /
 * Safari 18+); falls back to an instant theme switch on Firefox + older
 * browsers (still functional, just no animation).
 *
 * Usage:
 *   const setThemeWithReveal = useThemeReveal()
 *   <button onClick={(e) => setThemeWithReveal('midnight', e)}>...</button>
 *
 * The reveal expands outward from the click position (e.clientX / e.clientY),
 * so the new theme "wipes in" from where the user tapped. This gives a
 * Material-style circular reveal similar to Android's theme picker.
 *
 * The click position is set as CSS custom properties on <html>
 * (--theme-reveal-x / --theme-reveal-y) so the ::view-transition-new(root)
 * rule in globals.css can use them in its clip-path animation.
 */
export function useThemeReveal() {
  const { setTheme } = useTheme()

  return React.useCallback(
    (nextTheme: string, event?: { clientX: number; clientY: number }) => {
      // Default to center of viewport if no event provided.
      const x = event?.clientX ?? window.innerWidth / 2
      const y = event?.clientY ?? window.innerHeight / 2

      // Set the reveal origin as CSS custom properties on <html>. The
      // ::view-transition-new(root) rule in globals.css uses these in its
      // clip-path: circle(150% at var(--theme-reveal-x) var(--theme-reveal-y)).
      const root = document.documentElement
      root.style.setProperty('--theme-reveal-x', `${x}px`)
      root.style.setProperty('--theme-reveal-y', `${y}px`)

      // If the browser supports the View Transitions API, wrap the theme
      // change in a transition so the new theme "wipes in" from the click
      // point. Otherwise, just set the theme directly (instant switch).
      const startViewTransition = (
        document as Document & {
          startViewTransition?: (cb: () => void) => void
        }
      ).startViewTransition

      if (typeof startViewTransition === 'function') {
        startViewTransition.call(document, () => {
          setTheme(nextTheme)
        })
      } else {
        setTheme(nextTheme)
      }
    },
    [setTheme],
  )
}

/**
 * Get the list of available themes with metadata for rendering a theme
 * picker UI. Used by both the header ThemeToggle and the user page
 * ThemeSwitcher.
 */
export const THEME_OPTIONS = [
  {
    id: 'light',
    label: 'Light',
    description: 'Default bright white',
    // A small CSS gradient swatch shown next to each theme option.
    swatch: 'linear-gradient(135deg, #ffffff 50%, #e5e5e5 50%)',
  },
  {
    id: 'dark',
    label: 'Dark',
    description: 'Classic dark grey',
    swatch: 'linear-gradient(135deg, #1c1c1e 50%, #2c2c2e 50%)',
  },
  {
    id: 'midnight',
    label: 'Midnight',
    description: 'Deep navy blue',
    swatch: 'linear-gradient(135deg, #0a0f1e 50%, #1a2440 50%)',
  },
  {
    id: 'sepia',
    label: 'Sepia',
    description: 'Warm beige, easy on eyes',
    swatch: 'linear-gradient(135deg, #f1e7d4 50%, #d6c4a0 50%)',
  },
  {
    id: 'high-contrast',
    label: 'High Contrast',
    description: 'Pure black on white',
    swatch: 'linear-gradient(135deg, #ffffff 50%, #000000 50%)',
  },
] as const

export type ThemeId = (typeof THEME_OPTIONS)[number]['id']
