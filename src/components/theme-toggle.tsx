'use client'

import * as React from 'react'
import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'
import { useThemeReveal, THEME_OPTIONS } from '@/lib/use-theme-reveal'
import { cn } from '@/lib/utils'

/**
 * Theme toggle button for the header.
 *
 * Quick-toggles between dark and light on click (the classic 2-state toggle
 * most users expect). For full theme access (midnight / sepia / high-
 * contrast), users open the user page → Theme Switcher section, which shows
 * ALL 5 themes with a circular reveal transition.
 *
 * The toggle uses the View Transitions API (where supported) to do a
 * circular reveal from the click point — the new theme "wipes in" outward
 * from the button. Browsers without View Transitions support (older
 * Firefox) just get an instant theme switch (still functional).
 */
export function ThemeToggle() {
  const { theme, resolvedTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

  const setThemeWithReveal = useThemeReveal()

  // For the icon, use resolvedTheme (handles 'system' by returning the
  // actual computed theme). For the click behavior, use theme (the user's
  // explicit selection).
  // Any dark-toned theme (dark, midnight, ocean, forest, sunset, lavender,
  // rose, mono, cyber, gradient) should show the Sun icon (indicating
  // "currently dark, click for light").
  const darkThemes = ['dark', 'midnight', 'ocean', 'forest', 'sunset', 'lavender', 'rose', 'mono', 'cyber', 'gradient']
  const isDark = mounted && darkThemes.includes(resolvedTheme || '')

  const handleToggle = (e: React.MouseEvent) => {
    // Simple 2-state toggle: light ↔ dark. If the user has a dark-toned
    // custom theme (midnight, ocean, forest, etc.), toggle to light.
    // If they're on light/sepia/high-contrast, toggle to dark.
    const current = theme || resolvedTheme
    const next = darkThemes.includes(current || '') ? 'light' : 'dark'
    setThemeWithReveal(next, e)
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle dark mode"
      onClick={handleToggle}
      className="h-9 w-9 transition-transform duration-150 active:scale-95"
    >
      {mounted && isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  )
}

/**
 * ThemeSwitcher — the full grid of theme swatches used in the user page.
 * Each swatch shows the theme's gradient + name; clicking it triggers the
 * circular reveal transition (via the View Transitions API where supported).
 *
 * Exported from this file so the user page can import it as
 * `import { ThemeSwitcher } from '@/components/theme-toggle'`.
 */
export function ThemeSwitcher() {
  const { theme, resolvedTheme } = useTheme()
  const setThemeWithReveal = useThemeReveal()
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

  const activeTheme = mounted ? (theme || resolvedTheme || 'system') : 'system'

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {THEME_OPTIONS.map((t) => {
        const isActive = activeTheme === t.id
        return (
          <button
            key={t.id}
            type="button"
            onClick={(e) => setThemeWithReveal(t.id, e)}
            aria-pressed={isActive}
            className={cn(
              'group relative flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition-all duration-200 active:scale-95',
              isActive
                ? 'border-foreground bg-foreground/5 ring-2 ring-foreground/20'
                : 'border-border hover:bg-muted/50 hover:border-foreground/30',
            )}
          >
            <span
              className="h-12 w-full rounded-md border border-border/40 shadow-sm"
              style={{ background: t.swatch }}
              aria-hidden
            />
            <span className="block text-sm font-medium leading-tight">{t.label}</span>
            <span className="block text-[10px] text-muted-foreground leading-tight">
              {t.description}
            </span>
            {isActive && (
              <span className="absolute top-2 right-2 flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-background text-[10px] font-bold">
                ✓
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
