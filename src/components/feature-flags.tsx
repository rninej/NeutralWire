'use client'

/**
 * feature-flags.tsx — the "Feature Flags" card in the Account page.
 *
 * "Your header style" — available to EVERY visitor, no password. Pick the
 * subtopic-header design you personally see: any of the 10 designs, or
 * "Follow site default". Stored in the `nw_nav` cookie (see
 * src/lib/nav-override.ts), which the server reads during SSR — so the
 * visitor's own pick renders in the FIRST paint on every refresh, with
 * the same zero-flash guarantee as the site-wide flag. Picking here also
 * dispatches NAV_STYLE_EVENT, switching the homepage (open behind the
 * Account overlay) IMMEDIATELY — no refresh needed.
 *
 * The site-wide DEFAULT (what visitors without a personal pick see) is
 * managed from the /debug page — the admin section was removed here so
 * regular users only ever see their own setting.
 */

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  Flag,
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

const EASE_OUT = [0.16, 1, 0.3, 1] as const

/** The "Follow site default" row. */
function OptionRow({
  name,
  desc,
  icon,
  selected,
  onSelect,
  badge,
  badgeClass,
  delay,
}: {
  name: string
  desc: string
  icon: React.ReactNode
  selected: boolean
  onSelect: () => void
  badge: string | null
  badgeClass: string
  delay: number
}) {
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25, delay, ease: EASE_OUT }}
      aria-pressed={selected}
      title={desc}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all',
        selected
          ? 'border-foreground/30 bg-foreground/5 ring-1 ring-foreground/20'
          : 'border-border hover:bg-muted/40',
      )}
    >
      <span
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
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
                'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold',
                badgeClass,
              )}
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
              {badge}
            </span>
          ) : null}
        </span>
        {/* One-line description (full text on hover via title attr) —
            keeps the Account tab compact. */}
        <span className="mt-0.5 block truncate text-[11px] leading-snug text-muted-foreground">
          {desc}
        </span>
      </span>
      {selected ? (
        <Check className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
      ) : null}
    </motion.button>
  )
}

export function FeatureFlagsCard() {
  // ── Personal override state (every visitor) ──
  // null = "Follow site default"
  const [myNav, setMyNav] = React.useState<NavMode | null>(null)
  const [personalResult, setPersonalResult] = React.useState<string | null>(null)

  // ── Current site-wide default (info only) ──
  // Shown in the "Follow site default" row so users know what they're
  // following. The admin flips it from /debug — never here.
  const [navMode, setNavMode] = React.useState<NavMode | null>(null)

  // Load the personal pick + current global default.
  React.useEffect(() => {
    setMyNav(readNavOverride())

    fetch('/api/flags')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const v = d?.subtopicNav
        setNavMode(VALID_MODES.includes(v) ? v : 'cards')
      })
      .catch(() => setNavMode('cards'))
  }, [])

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
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <Flag className="h-4 w-4 text-amber-500" />
        <h2 className="text-sm font-bold">Feature Flags</h2>
        <span className="ml-auto rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-semibold text-violet-600 dark:text-violet-400">
          Header style
        </span>
      </div>

      {/* ═══════════ Personal picker — every visitor ═══════════ */}
      <div className="mb-2">
        <div className="mb-1 text-xs font-semibold">Your header style</div>
        <p className="text-xs text-muted-foreground">
          The subtopic-header design <b>you</b> see — saved on this device,
          rendered server-side (no flash), applied instantly, and it always
          wins over the site default.
        </p>
      </div>

      <div className="space-y-1.5">
        {/* "Follow site default" row */}
        <OptionRow
          name="Follow site default"
          desc={`Use the site-wide default — currently: ${globalName}`}
          icon={<Users className="h-4 w-4" />}
          selected={myNav === null}
          onSelect={() => pickPersonal(null)}
          badge={myNav === null ? 'Yours' : null}
          badgeClass="bg-violet-500/15 text-violet-600 dark:text-violet-400"
          delay={0.1}
        />
      </div>

      {/* The 10 designs — compact 2-column grid (icon + name; the full
          description of each design is available as a hover tooltip).
          Keeps the whole Feed tab at roughly one screen. */}
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        {NAV_OPTIONS.map((opt, i) => {
          const selected = myNav === opt.id
          return (
            <motion.button
              key={opt.id}
              type="button"
              onClick={() => pickPersonal(opt.id)}
              aria-pressed={selected}
              title={opt.desc}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, delay: 0.12 + i * 0.02, ease: EASE_OUT }}
              className={cn(
                'flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-all active:scale-[.98]',
                selected
                  ? 'border-violet-500/40 bg-violet-500/5 ring-1 ring-violet-500/30'
                  : 'border-border hover:bg-muted/40',
              )}
            >
              <span
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                  selected
                    ? 'bg-violet-600 text-white dark:bg-violet-500'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {opt.icon}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                {opt.name}
              </span>
              {selected ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
              ) : null}
            </motion.button>
          )
        })}
      </div>

      {myNav !== null ? (
        <div className="mt-1.5 text-[11px] text-muted-foreground">
          Your pick: <b className="text-foreground">{NAV_OPTIONS.find((o) => o.id === myNav)?.name ?? myNav}</b>{' '}
          — switches instantly and survives refreshes.
        </div>
      ) : null}

      {personalResult ? (
        <div className="mt-3 rounded-md border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-xs text-violet-700 dark:text-violet-300">
          ✓ {personalResult}{' '}
          <span className="text-muted-foreground">
            — close Account to see it on the homepage.
          </span>
        </div>
      ) : null}
    </Card>
  )
}
