'use client'

/**
 * theme-families.ts — family + mode theme system.
 *
 * Every theme now has BOTH a light and a dark variant, and the mode
 * (which variant you're in) is controlled separately from the family
 * (which colour scheme you're in):
 *
 *   neutralwire:theme-family → 'neutral' | 'midnight' | 'sepia' | …
 *   neutralwire:theme-mode   → 'auto' | 'light' | 'dark'   (default 'auto')
 *
 * - 'auto' follows the DEVICE light/dark setting live (matchMedia
 *   listener re-applies the right variant the moment the phone flips).
 * - The header light/dark button toggles the MODE while KEEPING the
 *   family — so pressing it while on Ocean switches to Ocean-light (the
 *   light version of the theme you chose), NOT plain white.
 * - The applied class is still stored by next-themes in
 *   neutralwire:theme, so page loads render the right theme with no
 *   flash (next-themes' pre-hydration script reads that key).
 */

import * as React from 'react'
import { useTheme } from 'next-themes'
import { clearGradientOverlay } from '@/lib/use-theme-reveal'

// ── localStorage keys ──
export const FAMILY_KEY = 'neutralwire:theme-family'
export const MODE_KEY = 'neutralwire:theme-mode'

export type ThemeMode = 'auto' | 'light' | 'dark'
export type EffectiveMode = 'light' | 'dark'

export interface ThemeFamily {
  id: string
  label: string
  /** CSS class for the family's DARK variant. */
  dark: string
  /** CSS class for the family's LIGHT variant. */
  light: string
  /** Swatch previews (dark side / light side) for the picker UI. */
  swatchDark: string
  swatchLight: string
  description: string
}

export const THEME_FAMILIES: ThemeFamily[] = [
  {
    id: 'neutral',
    label: 'Neutral',
    dark: 'dark',
    light: 'light',
    swatchDark: 'linear-gradient(135deg, #1c1c1e 50%, #2c2c2e 50%)',
    swatchLight: 'linear-gradient(135deg, #ffffff 50%, #e5e5e5 50%)',
    description: 'Classic grey dark + white light',
  },
  {
    id: 'midnight',
    label: 'Midnight',
    dark: 'midnight',
    light: 'midnight-light',
    swatchDark: 'linear-gradient(135deg, #0a0f1e 50%, #1a2440 50%)',
    swatchLight: 'linear-gradient(135deg, #eef2fb 50%, #cdd9f0 50%)',
    description: 'Deep navy night / misty blue day',
  },
  {
    id: 'sepia',
    label: 'Sepia',
    dark: 'sepia-dark',
    light: 'sepia',
    swatchDark: 'linear-gradient(135deg, #241a0e 50%, #4a3820 50%)',
    swatchLight: 'linear-gradient(135deg, #f1e7d4 50%, #d6c4a0 50%)',
    description: 'Warm beige day / candle-lit night',
  },
  {
    id: 'high-contrast',
    label: 'High Contrast',
    dark: 'high-contrast-dark',
    light: 'high-contrast',
    swatchDark: 'linear-gradient(135deg, #000000 50%, #1a1a1a 50%)',
    swatchLight: 'linear-gradient(135deg, #ffffff 50%, #000000 50%)',
    description: 'Maximum legibility both modes',
  },
  {
    id: 'ocean',
    label: 'Ocean',
    dark: 'ocean',
    light: 'ocean-light',
    swatchDark: 'linear-gradient(135deg, #0d3b4f 50%, #1a6b8a 50%)',
    swatchLight: 'linear-gradient(135deg, #dff0f5 50%, #a8d4e6 50%)',
    description: 'Deep teal night / pale cyan day',
  },
  {
    id: 'forest',
    label: 'Forest',
    dark: 'forest',
    light: 'forest-light',
    swatchDark: 'linear-gradient(135deg, #1a3326 50%, #2d6b3f 50%)',
    swatchLight: 'linear-gradient(135deg, #e6f0e8 50%, #bcd9c3 50%)',
    description: 'Deep green night / sage day',
  },
  {
    id: 'sunset',
    label: 'Sunset',
    dark: 'sunset',
    light: 'sunset-light',
    swatchDark: 'linear-gradient(135deg, #4a2010 50%, #c8533a 50%)',
    swatchLight: 'linear-gradient(135deg, #fdeee2 50%, #f4c7a8 50%)',
    description: 'Ember night / warm apricot day',
  },
  {
    id: 'lavender',
    label: 'Lavender',
    dark: 'lavender',
    light: 'lavender-light',
    swatchDark: 'linear-gradient(135deg, #3a2a4f 50%, #7a5aa8 50%)',
    swatchLight: 'linear-gradient(135deg, #eee9f8 50%, #cfbff0 50%)',
    description: 'Deep violet night / lilac day',
  },
  {
    id: 'rose',
    label: 'Rose',
    dark: 'rose',
    light: 'rose-light',
    swatchDark: 'linear-gradient(135deg, #3a1a1f 50%, #b8405a 50%)',
    swatchLight: 'linear-gradient(135deg, #fbeaee 50%, #f2c3d0 50%)',
    description: 'Wine night / blush day',
  },
  {
    id: 'mono',
    label: 'Mono',
    dark: 'mono',
    light: 'mono-light',
    swatchDark: 'linear-gradient(135deg, #2a2a2a 50%, #6a6a6a 50%)',
    swatchLight: 'linear-gradient(135deg, #f2f2f2 50%, #c4c4c4 50%)',
    description: 'Pure grayscale, both modes',
  },
  {
    id: 'cyber',
    label: 'Cyber',
    dark: 'cyber',
    light: 'cyber-light',
    swatchDark: 'linear-gradient(135deg, #0a1a0f 50%, #00ff7f 50%)',
    swatchLight: 'linear-gradient(135deg, #eefaf1 50%, #a3e8bd 50%)',
    description: 'Neon green night / mint day',
  },
]

export const FAMILY_IDS = THEME_FAMILIES.map((f) => f.id)

/** All class names the theme system can apply (for next-themes' themes list). */
export const ALL_THEME_CLASSES: string[] = [
  'light',
  'dark',
  'system',
  ...THEME_FAMILIES.filter((f) => f.id !== 'neutral').flatMap((f) => [
    f.dark,
    f.light,
  ]),
]

// ── localStorage helpers (safe) ──
export function getThemeFamily(): string {
  try {
    const v = localStorage.getItem(FAMILY_KEY)
    if (v && FAMILY_IDS.includes(v)) return v
    // Migration: a legacy stored theme (e.g. 'ocean') IS the family id.
    const legacy = localStorage.getItem('neutralwire:theme')
    if (legacy && FAMILY_IDS.includes(legacy)) {
      localStorage.setItem(FAMILY_KEY, legacy)
      localStorage.setItem(MODE_KEY, 'auto')
      return legacy
    }
  } catch {}
  return 'neutral'
}

export function getThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(MODE_KEY)
    if (v === 'auto' || v === 'light' || v === 'dark') return v
  } catch {}
  return 'auto'
}

export function setThemeFamilyStored(family: string) {
  try {
    localStorage.setItem(FAMILY_KEY, family)
    window.dispatchEvent(new CustomEvent('neutralwire:theme-family-changed'))
  } catch {}
}

export function setThemeModeStored(mode: ThemeMode) {
  try {
    localStorage.setItem(MODE_KEY, mode)
    window.dispatchEvent(new CustomEvent('neutralwire:theme-mode-changed'))
  } catch {}
}

/** The system's current dark/light preference. */
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined') return true
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Resolve 'auto' against the device setting. */
export function effectiveMode(mode: ThemeMode): EffectiveMode {
  if (mode === 'auto') return systemPrefersDark() ? 'dark' : 'light'
  return mode
}

/** The next-themes theme value for a family + effective mode. */
export function themeValueFor(familyId: string, mode: EffectiveMode): string {
  const family = THEME_FAMILIES.find((f) => f.id === familyId) || THEME_FAMILIES[0]
  return mode === 'dark' ? family.dark : family.light
}

/**
 * The core controller hook. Returns the current family/mode plus actions,
 * and keeps the applied theme in sync:
 *  - on mount (applies stored family+mode — also fixes the case where the
 *    device mode changed between visits while set to 'auto')
 *  - live, via a matchMedia listener, when mode is 'auto'
 */
export function useThemeController() {
  const { setTheme } = useTheme()
  const [family, setFamily] = React.useState<string>('neutral')
  const [mode, setMode] = React.useState<ThemeMode>('auto')
  const [systemDark, setSystemDark] = React.useState<boolean>(true)
  const [mounted, setMounted] = React.useState(false)

  // Load stored preferences on mount.
  React.useEffect(() => {
    setFamily(getThemeFamily())
    setMode(getThemeMode())
    setSystemDark(systemPrefersDark())
    setMounted(true)
  }, [])

  const apply = React.useCallback(
    (f: string, m: ThemeMode) => {
      const eff = effectiveMode(m)
      // Gradients are designed for dark surfaces — strip the overlay when
      // a light variant becomes active (covers toggles, family picks AND
      // auto mode flipping to day).
      if (eff === 'light') clearGradientOverlay()
      // For the neutral family in auto mode we use next-themes' native
      // 'system' value so its colorScheme + systemTheme machinery works.
      const value =
        f === 'neutral' && m === 'auto' ? 'system' : themeValueFor(f, eff)
      setTheme(value)
    },
    [setTheme],
  )

  // Re-apply on mount + whenever the family/mode changes. IMPORTANT: the
  // effect reads localStorage FRESH (not the local state snapshot) —
  // several controller instances exist at once (header toggle + Account
  // picker) and their local state can be stale; localStorage is the single
  // source of truth, so a stale instance can never stomp on a fresher
  // one's change.
  React.useEffect(() => {
    if (!mounted) return
    apply(getThemeFamily(), getThemeMode())
  }, [mounted, family, mode, apply])

  // Cross-instance sync: when another controller (e.g. the Account page
  // picker) changes family/mode, mirror it into THIS instance's state so
  // its UI stays accurate.
  React.useEffect(() => {
    const onFamily = () => setFamily(getThemeFamily())
    const onMode = () => setMode(getThemeMode())
    window.addEventListener('neutralwire:theme-family-changed', onFamily)
    window.addEventListener('neutralwire:theme-mode-changed', onMode)
    return () => {
      window.removeEventListener('neutralwire:theme-family-changed', onFamily)
      window.removeEventListener('neutralwire:theme-mode-changed', onMode)
    }
  }, [])

  // Follow the device setting LIVE when mode is 'auto'.
  React.useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => {
      setSystemDark(e.matches)
      if (getThemeMode() === 'auto') {
        const f = getThemeFamily()
        setTheme(f === 'neutral' ? 'system' : themeValueFor(f, e.matches ? 'dark' : 'light'))
      }
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [setTheme])

  /** Switch the colour-scheme family, keeping the current mode. */
  const selectFamily = React.useCallback(
    (f: string) => {
      setThemeFamilyStored(f)
      setFamily(f)
      apply(f, getThemeMode())
    },
    [apply],
  )

  /** Set the mode (auto/light/dark), keeping the current family. */
  const selectMode = React.useCallback(
    (m: ThemeMode) => {
      setThemeModeStored(m)
      setMode(m)
      apply(getThemeFamily(), m)
    },
    [apply],
  )

  /** Flip light↔dark — used by the header toggle. Keeps the family. */
  const toggleMode = React.useCallback(() => {
    const currentMode = getThemeMode()
    const eff = effectiveMode(currentMode)
    const next: EffectiveMode = eff === 'dark' ? 'light' : 'dark'
    selectMode(next)
  }, [selectMode])

  const effective = effectiveMode(mode)

  return {
    mounted,
    family,
    mode,
    effectiveMode: effective,
    systemDark,
    selectFamily,
    selectMode,
    toggleMode,
  }
}
