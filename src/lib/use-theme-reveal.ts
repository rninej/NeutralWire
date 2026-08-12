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
  {
    id: 'ocean',
    label: 'Ocean',
    description: 'Deep teal/cyan',
    swatch: 'linear-gradient(135deg, #0d3b4f 50%, #1a6b8a 50%)',
  },
  {
    id: 'forest',
    label: 'Forest',
    description: 'Deep green, nature',
    swatch: 'linear-gradient(135deg, #1a3326 50%, #2d6b3f 50%)',
  },
  {
    id: 'sunset',
    label: 'Sunset',
    description: 'Warm orange/pink',
    swatch: 'linear-gradient(135deg, #4a2010 50%, #c8533a 50%)',
  },
  {
    id: 'lavender',
    label: 'Lavender',
    description: 'Soft purple',
    swatch: 'linear-gradient(135deg, #3a2a4f 50%, #7a5aa8 50%)',
  },
  {
    id: 'rose',
    label: 'Rose',
    description: 'Soft pink/red',
    swatch: 'linear-gradient(135deg, #3a1a1f 50%, #b8405a 50%)',
  },
  {
    id: 'mono',
    label: 'Mono',
    description: 'Pure grayscale',
    swatch: 'linear-gradient(135deg, #2a2a2a 50%, #6a6a6a 50%)',
  },
  {
    id: 'cyber',
    label: 'Cyber',
    description: 'Neon green on dark',
    swatch: 'linear-gradient(135deg, #0a1a0f 50%, #00ff7f 50%)',
  },
] as const

/**
 * Gradient presets — pre-made gradient backgrounds that can be applied on
 * top of any dark theme. Each preset is a CSS gradient string.
 * When the user picks a gradient, we:
 *   1. Set the theme to 'dark' (as the base)
 *   2. Set --gradient-bg CSS variable on <html>
 *   3. Add 'gradient-theme' class to <html>
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
