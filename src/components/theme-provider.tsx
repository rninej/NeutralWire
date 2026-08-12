'use client'

import * as React from 'react'
import { ThemeProvider as NextThemesProvider } from 'next-themes'

/**
 * Theme provider wrapper around next-themes.
 *
 * Supports 13 solid themes + custom gradient themes:
 *   - light (default)
 *   - dark
 *   - midnight (very dark blue)
 *   - sepia (warm beige)
 *   - high-contrast (pure black on white)
 *   - ocean (deep teal/cyan)
 *   - forest (deep green)
 *   - sunset (warm orange/pink)
 *   - lavender (soft purple)
 *   - rose (soft pink/red)
 *   - mono (pure grayscale)
 *   - cyber (dark with neon green)
 *   - gradient (custom gradient — set via --gradient-bg CSS variable)
 *
 * Each theme name is applied as a class on <html> (attribute="class"). The
 * corresponding CSS variables are defined in src/app/globals.css.
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
      themes={[
        'light', 'dark', 'midnight', 'sepia', 'high-contrast',
        'ocean', 'forest', 'sunset', 'lavender', 'rose', 'mono', 'cyber',
        'gradient',
      ]}
      {...props}
    >
      {children}
    </NextThemesProvider>
  )
}
