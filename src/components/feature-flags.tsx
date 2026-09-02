'use client'

/**
 * feature-flags.tsx — the "Feature Flags" card in the Account page.
 *
 * TWO layers:
 *
 * 1. "Your header style" — available to EVERY visitor, no password. Pick
 *    the subtopic-header design you personally see: any of the 10 designs,
 *    or "Follow site default". Stored in the `nw_nav` cookie (see
 *    src/lib/nav-override.ts), which the server reads during SSR — so the
 *    visitor's own pick renders in the FIRST paint on every refresh, with
 *    the same zero-flash guarantee as the site-wide flag. Picking here
 *    also dispatches NAV_STYLE_EVENT, switching the homepage (open behind
 *    the Account overlay) IMMEDIATELY — no refresh needed.
 *
 * 2. "Site-wide default (admin)" — password-protected (same password as
 *    /debug, remembered in sessionStorage). Flips the Firebase flag
 *    featureFlags/subtopicNav that every visitor WITHOUT a personal pick
 *    sees. Applies within seconds (page.tsx re-reads it with a 5s server
 *    memo). Visitors who chose their own style keep theirs — the personal
 *    override always wins for them.
 */

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  Flag,
  Loader2,
  Lock,
  Check,
  Users,
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
import {
  readNavOverride,
  writeNavOverride,
  announceNavStyle,
  type NavMode,
} from '@/lib/nav-override'

export type { NavMode }

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

/** One selectable design row (shared by the personal + admin lists). */
function OptionRow({
  name,
  desc,
  icon,
  selected,
  onSelect,
  disabled,
  badge,
  badgeClass,
  delay,
}: {
  name: string
  desc: string
  icon: React.ReactNode
  selected: boolean
  onSelect: () => void
  disabled: boolean
  badge: string | null
  badgeClass: string
  delay: number
}) {
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25, delay, ease: EASE_OUT }}
      aria-pressed={selected}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-all',
        selected
          ? 'border-foreground/30 bg-foreground/5 ring-1 ring-foreground/20'
          : 'border-border hover:bg-muted/40',
        disabled && 'cursor-default',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
          selected
            ? 'bg-foreground text-background'
            : 'bg-muted text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium">{name}</span>
          {badge ? (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold',
                badgeClass,
              )}
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
              {badge}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
          {desc}
        </span>
      </span>
      {selected ? (
        <Check className="mt-1 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
      ) : null}
    </motion.button>
  )
}

export function FeatureFlagsCard() {
  // ── Personal override state (every visitor) ──
  // null = "Follow site default"
  const [myNav, setMyNav] = React.useState<NavMode | null>(null)
  const [personalResult, setPersonalResult] = React.useState<string | null>(null)

  // ── Site-wide default state (admin) ──
  const [navMode, setNavMode] = React.useState<NavMode | null>(null)

  // ── Admin auth state ──
  const [authed, setAuthed] = React.useState(false)
  const [passwordInput, setPasswordInput] = React.useState('')
  const [authError, setAuthError] = React.useState('')
  const [authing, setAuthing] = React.useState(false)
  const passwordRef = React.useRef('')

  // ── Admin flip state ──
  const [flipping, setFlipping] = React.useState<NavMode | null>(null)
  const [flipResult, setFlipResult] = React.useState<string | null>(null)

  // Restore session auth + load the personal pick + current global flag.
  React.useEffect(() => {
    try {
      const saved = sessionStorage.getItem(PASSWORD_STORAGE_KEY)
      if (saved) {
        setAuthed(true)
        passwordRef.current = saved
      }
    } catch {}

    // The visitor's own pick (null when following the site default).
    setMyNav(readNavOverride())

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

  // ── Pick the visitor's OWN design (or return to the site default) ──
  // Instant: writes the nw_nav cookie (server-rendered on every future
  // load) and announces the change so the homepage switches right now.
  const pickPersonal = (mode: NavMode | null) => {
    writeNavOverride(mode)
    setMyNav(mode)
    const effective = mode ?? navMode ?? 'cards'
    announceNavStyle(effective as NavMode)
    if (mode === null) {
      setPersonalResult('Following the site default — applies instantly')
    } else {
      const opt = NAV_OPTIONS.find((o) => o.id === mode)
      setPersonalResult(`Saved for you: ${opt?.name ?? mode} — applied instantly`)
    }
  }

  const globalName =
    navMode === null ? '…' : (NAV_OPTIONS.find((o) => o.id === navMode)?.name ?? navMode)

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2">
        <Flag className="h-4 w-4 text-amber-500" />
        <h2 className="text-sm font-bold">Feature Flags</h2>
        <span className="ml-auto rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-semibold text-violet-600 dark:text-violet-400">
          Personal pick + site default
        </span>
      </div>

      {/* ═══════════ Section 1 — every visitor ═══════════ */}
      <div className="mb-4">
        <div className="mb-1 text-xs font-semibold">Your header style</div>
        <p className="text-xs text-muted-foreground">
          Pick the subtopic-header design <b>you</b> see — it&apos;s saved on
          this device and rendered server-side on every load, so it never
          flashes. It applies instantly while you&apos;re on this page (close
          Account to see it) and survives refreshes. &quot;Follow site
          default&quot; tracks whatever the admin sets for everyone.
        </p>
      </div>

      <div className="space-y-1.5">
        {/* "Follow site default" row */}
        <OptionRow
          name="Follow site default"
          desc={`Track the admin's site-wide pick — currently: ${globalName}`}
          icon={<Users className="h-4 w-4" />}
          selected={myNav === null}
          onSelect={() => pickPersonal(null)}
          disabled={false}
          badge={myNav === null ? 'Yours' : null}
          badgeClass="bg-violet-500/15 text-violet-600 dark:text-violet-400"
          delay={0.1}
        />

        {NAV_OPTIONS.map((opt, i) => (
          <OptionRow
            key={opt.id}
            name={opt.name}
            desc={opt.desc}
            icon={opt.icon}
            selected={myNav === opt.id}
            onSelect={() => pickPersonal(opt.id)}
            disabled={false}
            badge={myNav === opt.id ? 'Yours' : null}
            badgeClass="bg-violet-500/15 text-violet-600 dark:text-violet-400"
            delay={0.13 + i * 0.03}
          />
        ))}
      </div>

      {personalResult ? (
        <div className="mt-3 rounded-md border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-xs text-violet-700 dark:text-violet-300">
          ✓ {personalResult}{' '}
          <span className="text-muted-foreground">
            — close Account to see it on the homepage.
          </span>
        </div>
      ) : null}

      {/* ═══════════ Divider ═══════════ */}
      <div className="my-5 border-t" />

      {/* ═══════════ Section 2 — admin only ═══════════ */}
      <div className="mb-3 flex items-center gap-2">
        <Lock className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-xs font-semibold">Site-wide default (admin)</h3>
        <span className="ml-auto rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
          Applies to all users within seconds
        </span>
      </div>

      <div className="mb-4">
        <div className="mb-1 text-xs font-semibold">Subtopic header style</div>
        <p className="text-xs text-muted-foreground">
          The default every visitor <i>without</i> a personal pick sees.
          Ten designs to choose from; flip it back here anytime. Refresh the
          homepage after switching — the selected design is rendered
          server-side, so it loads instantly with NO flash. Visitors who
          chose their own style in &quot;Your header style&quot; above keep
          theirs.
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

      {/* The 10 designs (admin) */}
      <div className="space-y-1.5">
        {NAV_OPTIONS.map((opt, i) => {
          const isLive = navMode === opt.id
          const isFlipping = flipping === opt.id
          return (
            <OptionRow
              key={opt.id}
              name={opt.name}
              desc={opt.desc}
              icon={isFlipping ? <Loader2 className="h-4 w-4 animate-spin" /> : opt.icon}
              selected={isLive}
              onSelect={() => selectMode(opt.id)}
              disabled={!authed || flipping !== null}
              badge={isLive ? 'Live' : null}
              badgeClass="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              delay={0.28 + i * 0.03}
            />
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
          Enter the admin password to switch the default. It&apos;s remembered
          for this session (same as /debug).
        </div>
      ) : null}
    </Card>
  )
}
