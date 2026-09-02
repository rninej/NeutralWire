'use client'

import * as React from 'react'
import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'
import {
  useThemeController,
  THEME_FAMILIES,
  type ThemeMode,
} from '@/lib/theme-families'
import { useThemeReveal } from '@/lib/use-theme-reveal'
import { cn } from '@/lib/utils'

/**
 * Theme toggle button for the header.
 *
 * Toggles light↔dark WITHIN the current theme family: pressing it while
 * on Ocean (dark) switches to Ocean-light — the light version of the
 * theme you picked — instead of jumping to plain white. The choice is
 * remembered as an explicit mode override (auto → light or dark); the
 * Account page has an Auto option that follows the device setting again.
 *
 * The toggle uses the View Transitions API (where supported) for the
 * circular reveal animation from the click point.
 */
export function ThemeToggle() {
  const { theme, resolvedTheme } = useTheme()
  const { toggleMode, effectiveMode } = useThemeController()
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

  const setThemeWithReveal = useThemeReveal()

  // Dark detection: the applied theme class (or the resolved system mode
  // for neutral-auto) tells us which side of the family we're on.
  const darkClasses = new Set(
    THEME_FAMILIES.map((f) => f.dark).filter((c) => c !== 'light'),
  )
  const isDark =
    mounted &&
    (darkClasses.has(theme || '') ||
      (theme === 'system' && resolvedTheme === 'dark') ||
      (!theme && effectiveMode === 'dark'))

  const handleToggle = (e: React.MouseEvent) => {
    // toggleMode flips light↔dark WITHIN the stored family; the reveal
    // wrapper wraps the mutation in the view transition.
    setThemeWithReveal(null, e, () => toggleMode())
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle light/dark mode"
      onClick={handleToggle}
      className="h-9 w-9 transition-transform duration-150 active:scale-95"
    >
      {mounted && isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  )
}

/**
 * ThemeSwitcher — the full picker used in the user page.
 *
 * Two controls:
 *   1. FAMILY grid (Neutral, Midnight, Sepia, …) — each swatch shows the
 *      family's dark + light halves. Picking a family keeps the current
 *      mode (auto by default).
 *   2. MODE segmented control — Auto (follows the device's light/dark
 *      setting live), Light, or Dark.
 *
 * Both use the circular reveal transition via the View Transitions API
 * where supported.
 */
export function ThemeSwitcher() {
  const { family, mode, effectiveMode, mounted, selectFamily, selectMode } =
    useThemeController()
  const setThemeWithReveal = useThemeReveal()

  const modes: Array<{ id: ThemeMode; label: string; hint: string }> = [
    { id: 'auto', label: 'Auto', hint: 'Follows your device setting' },
    { id: 'light', label: 'Light', hint: 'Always light' },
    { id: 'dark', label: 'Dark', hint: 'Always dark' },
  ]

  const activeFamily = mounted ? family : 'neutral'
  const activeMode = mounted ? mode : 'auto'

  const handleFamily = (
    f: string,
    e: React.MouseEvent,
  ) => {
    setThemeWithReveal(null, e, () => selectFamily(f))
  }

  const handleMode = (m: ThemeMode, e: React.MouseEvent) => {
    setThemeWithReveal(null, e, () => selectMode(m))
  }

  return (
    <div>
      {/* Mode segmented control */}
      <div className="mb-4">
        <div className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Light / dark mode
        </div>
        <div className="grid grid-cols-3 gap-2">
          {modes.map((m) => {
            const isActive = activeMode === m.id
            return (
              <button
                key={m.id}
                type="button"
                onClick={(e) => handleMode(m.id, e)}
                aria-pressed={isActive}
                className={cn(
                  'rounded-lg border p-2.5 text-left transition-all active:scale-95',
                  isActive
                    ? 'border-foreground bg-foreground/5 ring-1 ring-foreground/20'
                    : 'border-border hover:bg-muted/50',
                )}
              >
                <div className="flex items-center gap-1.5 text-sm font-semibold">
                  {m.id === 'auto' ? (
                    <span
                      aria-hidden
                      className={cn(
                        'flex h-3.5 w-3.5 items-center justify-center rounded-full',
                        isActive ? 'bg-foreground text-background' : 'bg-muted',
                      )}
                    >
                      <span
                        className={cn(
                          'block h-2 w-2 rounded-full transition-all',
                          effectiveMode === 'dark' ? 'bg-foreground' : 'bg-background ring-1 ring-foreground/40',
                        )}
                      />
                    </span>
                  ) : m.id === 'light' ? (
                    <Sun className="h-3.5 w-3.5" />
                  ) : (
                    <Moon className="h-3.5 w-3.5" />
                  )}
                  {m.label}
                </div>
                <div className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
                  {m.hint}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Family grid */}
      <div className="mb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        Color scheme
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {THEME_FAMILIES.map((f) => {
          const isActive = activeFamily === f.id
          return (
            <button
              key={f.id}
              type="button"
              onClick={(e) => handleFamily(f.id, e)}
              aria-pressed={isActive}
              className={cn(
                'group relative flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition-all duration-200 active:scale-95',
                isActive
                  ? 'border-foreground bg-foreground/5 ring-2 ring-foreground/20'
                  : 'border-border hover:bg-muted/50 hover:border-foreground/30',
              )}
            >
              {/* Split swatch: dark half on top, light half below. Each
                  half is its own layer with its own gradient background —
                  the old version interpolated the gradient STRINGS into an
                  outer linear-gradient() (nested gradients), which is
                  invalid CSS: browsers dropped the whole declaration and
                  the swatches rendered invisible. */}
              <span
                className="flex h-12 w-full flex-col overflow-hidden rounded-md border border-border/40 shadow-sm"
                aria-hidden
              >
                <span
                  className="min-h-0 flex-1"
                  style={{ background: f.swatchDark }}
                />
                <span
                  className="min-h-0 flex-1"
                  style={{ background: f.swatchLight }}
                />
              </span>
              <span className="block text-sm font-medium leading-tight">{f.label}</span>
              <span className="block text-[10px] text-muted-foreground leading-tight">
                {f.description}
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
    </div>
  )
}
