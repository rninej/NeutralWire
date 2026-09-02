'use client'

import * as React from 'react'
import { ThemeProvider as NextThemesProvider } from 'next-themes'
import { ALL_THEME_CLASSES } from '@/lib/theme-families'

/**
 * Theme provider wrapper around next-themes.
 *
 * Supports theme FAMILIES (neutral, midnight, sepia, high-contrast, ocean,
 * forest, sunset, lavender, rose, mono, cyber), each with a light AND a
 * dark CSS variant, plus custom gradient overlays. See
 * src/lib/theme-families.ts for the family/mode controller.
 *
 * Each theme class is defined in src/app/globals.css:
 *   light / dark                  — the neutral family
 *   midnight / midnight-light
 *   sepia / sepia-dark
 *   high-contrast / high-contrast-dark
 *   ocean / ocean-light
 *   forest / forest-light
 *   sunset / sunset-light
 *   lavender / lavender-light
 *   rose / rose-light
 *   mono / mono-light
 *   cyber / cyber-light
 *   gradient (custom — overlay class on a dark base)
 */
export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      storageKey="neutralwire:theme"
      themes={ALL_THEME_CLASSES}
      {...props}
    >
      {children}
    </NextThemesProvider>
  )
}
