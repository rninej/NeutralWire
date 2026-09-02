'use client'

/**
 * feature-flags.tsx — the "Feature Flags" card in the Account page.
 *
 * Lets the site owner pick the homepage subtopic-header design that EVERY
 * visitor sees (10 designs), stored as a Firebase feature flag
 * (featureFlags/subtopicNav) and rendered server-side on page load.
 *
 * - The current selection shows a "Live" badge (fetched from GET /api/flags).
 * - Flipping a flag is password-protected (POST /api/flags) — same password
 *   as /debug. The password is remembered in sessionStorage under the same
 *   key /debug uses, so authenticating in one place unlocks both.
 * - "Applies to all users within seconds": page.tsx re-reads the flag with
 *   a 5s server-side memo — refresh the homepage after switching and the
 *   selected design is already in the first paint (no flash).
 */

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  Flag,
  Loader2,
  Lock,
  Check,
  LayoutGrid,
  List,
  Underline,
  LayoutDashboard,
  PanelBottomOpen,
  AppWindow,
  Pill,
  PanelTop,
  MoveHorizontal,
  ChevronsRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export type NavMode =
  | 'cards' | 'classic' | 'tabs' | 'tiles' | 'sheet' | 'dock'
  | 'maxipills' | 'headerdock' | 'tabsarrow' | 'cardsarrow'

const NAV_OPTIONS: Array<{
  id: NavMode
  name: string
  desc: string
  icon: React.ReactNode
}> = [
  {
    id: 'cards',
    name: 'Big chips',
    desc: 'Icon chips with 40px targets in a scrollable row — the current default',
    icon: <LayoutGrid className="h-4 w-4" />,
  },
  {
    id: 'tabs',
    name: 'Bold tabs',
    desc: 'Text-only tabs, 44px tall, with a sliding underline — Google-News style',
    icon: <Underline className="h-4 w-4" />,
  },
  {
    id: 'tiles',
    name: 'Icon tiles',
    desc: 'Wrapping grid of bordered icon tiles — every topic visible, no scrolling',
    icon: <LayoutDashboard className="h-4 w-4" />,
  },
  {
    id: 'sheet',
    name: 'Browse sheet',
    desc: 'One wide button opens a sheet of 56px tiles — the biggest touch targets',
    icon: <PanelBottomOpen className="h-4 w-4" />,
  },
  {
    id: 'dock',
    name: 'Bottom dock',
    desc: 'Floating app-style dock at the bottom — Topics (folder preview) opens all topics',
    icon: <AppWindow className="h-4 w-4" />,
  },
  {
    id: 'classic',
    name: 'Classic pills',
    desc: 'The original small wrapping text pills (how the site looked before)',
    icon: <List className="h-4 w-4" />,
  },
  {
    id: 'maxipills',
    name: 'Maxi pills',
    desc: 'Classic pills at the biggest size that fits exactly two rows — adaptive font, rows filled edge-to-edge, same header height',
    icon: <Pill className="h-4 w-4" />,
  },
  {
    id: 'headerdock',
    name: 'Header dock',
    desc: 'The bottom-dock item style (icon over label) placed inline in the header — a native top tab bar',
    icon: <PanelTop className="h-4 w-4" />,
  },
  {
    id: 'tabsarrow',
    name: 'Bold tabs + arrow',
    desc: 'Bold text tabs with a floating swipe-hint arrow over the right edge — a symbol, not a button; fades out at the end',
    icon: <MoveHorizontal className="h-4 w-4" />,
  },
  {
    id: 'cardsarrow',
    name: 'Big chips + arrow',
    desc: 'The big icon chips with the same floating swipe-hint arrow',
    icon: <ChevronsRight className="h-4 w-4" />,
  },
]

const VALID_MODES: NavMode[] = NAV_OPTIONS.map((o) => o.id)

// Same sessionStorage key as /debug — auth once, works in both places.
const PASSWORD_STORAGE_KEY = 'neutralwire:analytics-pw'

const EASE_OUT = [0.16, 1, 0.3, 1] as const

export function FeatureFlagsCard() {
  // ── Auth state ──
  const [authed, setAuthed] = React.useState(false)
  const [passwordInput, setPasswordInput] = React.useState('')
  const [authError, setAuthError] = React.useState('')
  const [authing, setAuthing] = React.useState(false)
  const passwordRef = React.useRef('')

  // ── Flag state ──
  const [navMode, setNavMode] = React.useState<NavMode | null>(null)
  const [flipping, setFlipping] = React.useState<NavMode | null>(null)
  const [flipResult, setFlipResult] = React.useState<string | null>(null)

  // Restore session auth + load the current flag on mount.
  React.useEffect(() => {
    try {
      const saved = sessionStorage.getItem(PASSWORD_STORAGE_KEY)
      if (saved) {
        setAuthed(true)
        passwordRef.current = saved
      }
    } catch {}

    fetch('/api/flags')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const v = d?.subtopicNav
        setNavMode(VALID_MODES.includes(v) ? v : 'cards')
      })
      .catch(() => setNavMode('cards'))
  }, [])

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthing(true)
    setAuthError('')
    try {
      // Verify with a tiny analytics query (same flow as /debug) — we
      // never flip a flag just to test the password.
      const res = await fetch('/api/analytics/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: passwordInput,
          fromTs: Date.now() - 24 * 60 * 60 * 1000,
          toTs: Date.now(),
        }),
      })
      if (res.ok) {
        sessionStorage.setItem(PASSWORD_STORAGE_KEY, passwordInput)
        passwordRef.current = passwordInput
        setAuthed(true)
        setPasswordInput('')
      } else {
        setAuthError('Incorrect password')
      }
    } catch {
      setAuthError('Network error')
    } finally {
      setAuthing(false)
    }
  }

  const selectMode = async (mode: NavMode) => {
    if (flipping || mode === navMode || !passwordRef.current) return
    setFlipping(mode)
    setFlipResult(null)
    try {
      const res = await fetch('/api/flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordRef.current, subtopicNav: mode }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok) {
        setNavMode(mode)
        const opt = NAV_OPTIONS.find((o) => o.id === mode)
        setFlipResult(`Live for all users: ${opt?.name ?? mode}`)
      } else {
        setFlipResult(d.error || 'Failed to update')
      }
    } catch {
      setFlipResult('Network error')
    } finally {
      setFlipping(null)
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2">
        <Flag className="h-4 w-4 text-amber-500" />
        <h2 className="text-sm font-bold">Feature Flags</h2>
        <span className="ml-auto rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
          Applies to all users within seconds
        </span>
      </div>

      <div className="mb-4">
        <div className="mb-1 text-xs font-semibold">Subtopic header style</div>
        <p className="text-xs text-muted-foreground">
          A complaint said the classic category pills are too small and hard
          to read/click. Ten designs to choose from; pick the one every
          visitor sees and flip it back here anytime. Refresh the homepage
          after switching — the selected design is now rendered
          server-side, so it loads instantly with NO flash.
        </p>
      </div>

      {/* Password gate — only when not authed this session */}
      {!authed ? (
        <form onSubmit={handleAuth} className="mb-2 flex gap-2">
          <div className="relative flex-1">
            <Lock className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder="Admin password"
              aria-label="Admin password"
              className="w-full rounded-md border bg-muted/30 py-2 pl-9 pr-3 text-sm"
            />
          </div>
          <Button type="submit" size="sm" disabled={authing || !passwordInput} className="gap-1.5">
            {authing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Lock className="h-3.5 w-3.5" />}
            Unlock
          </Button>
        </form>
      ) : null}
      {authError ? (
        <div className="mb-2 text-xs text-red-500">{authError}</div>
      ) : null}

      {/* The 10 designs */}
      <div className="space-y-1.5">
        {NAV_OPTIONS.map((opt, i) => {
          const isLive = navMode === opt.id
          const isFlipping = flipping === opt.id
          const disabled = !authed || flipping !== null
          return (
            <motion.button
              key={opt.id}
              type="button"
              onClick={() => selectMode(opt.id)}
              disabled={disabled}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.25, delay: 0.1 + i * 0.03, ease: EASE_OUT }}
              aria-pressed={isLive}
              className={cn(
                'flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-all',
                isLive
                  ? 'border-foreground/30 bg-foreground/5 ring-1 ring-foreground/20'
                  : 'border-border hover:bg-muted/40',
                disabled && 'cursor-default',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                  isLive
                    ? 'bg-foreground text-background'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {opt.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-medium">{opt.name}</span>
                  {isLive ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                      Live
                    </span>
                  ) : null}
                  {isFlipping ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  ) : null}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                  {opt.desc}
                </span>
              </span>
              {isLive ? (
                <Check className="mt-1 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              ) : null}
            </motion.button>
          )
        })}
      </div>

      {flipResult ? (
        <div
          className={cn(
            'mt-3 rounded-md border px-3 py-2 text-xs',
            flipResult.startsWith('Live')
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              : 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
          )}
        >
          {flipResult.startsWith('Live') ? '✓ ' : ''}
          {flipResult}{' '}
          {flipResult.startsWith('Live') ? (
            <span className="text-muted-foreground">
              — refresh the homepage to see it.
            </span>
          ) : null}
        </div>
      ) : null}

      {!authed ? (
        <div className="mt-3 text-[11px] text-muted-foreground">
          Enter the admin password to switch designs. It&apos;s remembered for
          this session (same as /debug).
        </div>
      ) : null}
    </Card>
  )
}
