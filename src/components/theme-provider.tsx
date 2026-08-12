'use client'

import * as React from 'react'
import { ThemeProvider as NextThemesProvider } from 'next-themes'

/**
 * Theme provider wrapper around next-themes.
 *
 * Supports 5 themes:
 *   - light (default)
 *   - dark
 *   - midnight (very dark blue)
 *   - sepia (warm beige)
 *   - high-contrast (pure black on white)
 *
 * Each theme name is applied as a class on <html> (attribute="class"). The
 * corresponding CSS variables are defined in src/app/globals.css
 * (.dark, .midnight, .sepia, .high-contrast blocks).
 *
 * The theme is persisted in localStorage under `neutralwire:theme` (overriding
 * next-themes' default 'theme' key) so it doesn't collide with other apps
 * on the same domain.
 *
 * `disableTransitionOnChange` is intentionally NOT set — it would interfere
 * with the circular reveal View Transition we use when switching themes
 * (see useThemeReveal hook in src/components/theme-toggle.tsx). Theme flashes
 * are prevented by the View Transition's snapshot, not by CSS transition
 * disabling.
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
      themes={['light', 'dark', 'midnight', 'sepia', 'high-contrast']}
      {...props}
    >
      {children}
    </NextThemesProvider>
  )
}
