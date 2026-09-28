'use client'

/**
 * add-topic-button.tsx — the "+" chip and the pinned custom-subtopic
 *   chips for every subtopic-header row (cards / tabs / maxipills /
 *   sheet / dock / classic variants).
 *
 * PREMIUM VISUAL LANGUAGE (Sep 2026, owner spec): NO diamond icons on the
 * header chips — the premium mark is the GOLDEN GRADIENT TEXT itself
 * (amber→yellow→amber, clipped to the glyphs), and the + button is a
 * plain golden + (a real SVG gradient stroke) with NO corner badge.
 * One idea everywhere: golden text = premium.
 *
 * • FREE-DISCOVERY (teaser) model: EVERYONE gets the picker — all 550+
 *   subtopics render for free visitors, so discovery costs nothing;
 *   tapping any topic (or the AI creator) as a free user opens the
 *   upgrade dialog instead of adding it (see subtopic-picker.tsx).
 *
 * SIZING: every header variant sizes its chips differently (40px cards,
 * 44px tabs, 24px maxi pills, 56px sheet tiles…). The chip takes an
 * explicit `chipClassName` so it always MATCHES the surrounding chips —
 * same height, same padding, same font — and never visually breaks a row
 * (the old fixed h-8 "one size" chip looked wrong everywhere and, in the
 * maxi-pill rows, forced the adaptive font stepper to shrink every pill).
 *
 * The SubtopicPicker sheet is PORTALLED to <body>: the + chip renders
 * inside the sticky glass header, whose backdrop-filter creates a
 * containing block that would otherwise trap the fixed overlay INSIDE the
 * header (clipped to a ~100px strip on mobile — the classic CategorySheet
 * lesson; see the portal notes in subtopic-navs.tsx).
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import {
  getCustomTopics,
  CUSTOM_TOPICS_EVENT,
  type CustomTopicRef,
} from '@/lib/custom-topics-client'

/** The golden gradient text classes shared by every premium chip label.
 *  bg-clip-text + text-transparent clips the amber gradient to the glyphs;
 *  the span sets its OWN color (transparent), so it wins over any
 *  button-level text-color (active pill fills, hover states) — the golden
 *  text survives every variant's active styling. */
const GOLDEN_TEXT =
  'bg-gradient-to-r from-amber-600 via-yellow-500 to-amber-600 bg-clip-text text-transparent dark:from-amber-400 dark:via-yellow-300 dark:to-amber-400'

/** A Plus glyph stroked with a REAL SVG linear gradient (amber→yellow→
 *  amber) — lucide's currentColor stroke can't take a CSS gradient, so
 *  this is a hand-rolled 24×24 plus with a gradient stroke. Unique id per
 *  instance (React.useId) so multiple + buttons never share a <defs> id. */
function GoldenPlus({ className }: { className?: string }) {
  const rawId = React.useId()
  const gid = `nw-gold-${rawId.replace(/[^a-zA-Z0-9-]/g, '')}`
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2.6}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#d97706" />
          <stop offset="45%" stopColor="#facc15" />
          <stop offset="100%" stopColor="#d97706" />
        </linearGradient>
      </defs>
      <path d="M12 5v14M5 12h14" stroke={`url(#${gid})`} />
    </svg>
  )
}

export interface AddTopicChipProps {
  /** Complete sizing/shape for the chip — height, padding, font-size,
   *  radius, shrink — so it matches the variant's own chips. */
  chipClassName: string
  /** Plus icon size (defaults to 17px). */
  iconClassName?: string
  /** Chip label — shown ≥sm only by default (mobile stays icon-only to
   *  save width); pass labelClassName="" to always show it. */
  label?: string
  /** Visibility classes for the label span. */
  labelClassName?: string
}

export function AddTopicChip({
  chipClassName,
  iconClassName = 'h-[17px] w-[17px]',
  label = 'Topics',
  labelClassName = 'hidden sm:inline',
}: AddTopicChipProps) {
  const [pickerOpen, setPickerOpen] = React.useState(false)
  // Portal target: resolved on first open (client-only by then).
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

  // Lazy-load the picker only when first opened (code-splitting).
  const SubtopicPicker = React.useMemo(
    () => React.lazy(() => import('@/components/subtopic-picker').then((m) => ({ default: m.SubtopicPicker }))),
    [],
  )

  const onClick = () => {
    // FREE-DISCOVERY: everyone opens the picker — the catalog renders in
    // full for free visitors and each topic tap itself opens the upgrade
    // dialog (subtopic-picker gates the actual adding). Browsing is the
    // teaser; subscribing is the gate.
    setPickerOpen(true)
  }

  return (
    <>
      {/* The golden + button — NO corner badge (owner spec: "only golden +
          button"); the gradient stroke on the glyph IS the premium
          affordance. Same amber-tinted chip skin as before so it reads as
          one family with the golden-text chips. */}
      <motion.button
        type="button"
        whileTap={{ scale: 0.94 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        onClick={onClick}
        aria-label="Add a subtopic (Premium)"
        title="Add custom subtopics"
        className={cn(
          'relative inline-flex items-center gap-1.5 whitespace-nowrap border border-amber-500/50 bg-amber-500/10 font-semibold transition-colors hover:bg-amber-500/20',
          chipClassName,
        )}
      >
        <GoldenPlus className={cn('shrink-0 drop-shadow-[0_0_1px_rgba(245,158,11,0.45)]', iconClassName)} />
        {label !== '' && (
          <span className={cn('text-amber-600 dark:text-amber-400', labelClassName)}>{label}</span>
        )}
      </motion.button>

      {mounted &&
        createPortal(
          <AnimatePresence>
            {pickerOpen && (
              <React.Suspense fallback={null}>
                <SubtopicPicker onClose={() => setPickerOpen(false)} />
              </React.Suspense>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  )
}

/**
 * Custom topic chips for a header row: the user's pinned custom
 * subtopics, rendered like category chips — with the label as GOLDEN
 * GRADIENT TEXT (the premium mark, no diamond icon; owner spec Sep
 * 2026). Re-renders live when topics are added/removed.
 *
 * Sizing comes ENTIRELY from `chipClassName` (each variant passes its own
 * chip geometry) — no hardcoded heights/fonts, so the chips blend into
 * every design, including the adaptive-font maxi pills (where a fixed
 * 13px font previously squeezed every pill down to the stepper floor).
 */
export function CustomTopicChips({
  activeCategory,
  onSelect,
  chipClassName,
  activeChipClassName,
  truncate = false,
  rowClassName,
  trailing,
}: {
  activeCategory: string
  onSelect: (category: string) => void
  chipClassName?: string
  activeChipClassName?: string
  /** Clamp chip width + ellipsize the label (tight wrapping rows). */
  truncate?: boolean
  /** When set, chips render inside this wrapper row (used by maxipills:
     a horizontally-scrolling strip, so pinned topics never squeeze the
     two adaptive rows). Rendered only while topics exist. */
  rowClassName?: string
  /** A node (typically the AddTopicChip) GLUED to the LAST chip — they
     wrap together in wrapping layouts, so the + button can never end up
     alone on a trailing row (the Pixel 8 Pro "3rd row with just +"
     layout bug). With no pinned topics the trailing node renders alone,
     exactly where the + used to sit. */
  trailing?: React.ReactNode
}) {
  const [topics, setTopics] = React.useState<CustomTopicRef[]>([])

  React.useEffect(() => {
    setTopics(getCustomTopics())
    const onChanged = () => setTopics(getCustomTopics())
    window.addEventListener(CUSTOM_TOPICS_EVENT, onChanged)
    return () => window.removeEventListener(CUSTOM_TOPICS_EVENT, onChanged)
  }, [])

  // No pinned topics: no chips — but a trailing + still renders alone so
  // the add affordance stays exactly where each variant expects it.
  if (topics.length === 0) return trailing ?? null

  const renderChip = (t: CustomTopicRef) => {
    const catId = `custom:${t.id}`
    const active = activeCategory === catId
    return (
      <motion.button
        key={t.id}
        type="button"
        role="tab"
        aria-selected={active}
        whileTap={{ scale: 0.94 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        onClick={() => onSelect(catId)}
        className={cn(
          'relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-semibold transition-colors',
          chipClassName,
          truncate && 'min-w-0 max-w-[104px] px-1.5',
          active
            ? activeChipClassName || 'bg-amber-500/15 ring-1 ring-inset ring-amber-500/40'
            : 'text-foreground/75 hover:bg-amber-500/10',
        )}
      >
        {/* Golden gradient text — the label IS the premium mark. The span
            sets its own transparent color, so it stays golden on top of
            every variant's active pill fill. */}
        <span
          className={cn(
            GOLDEN_TEXT,
            'font-bold',
            truncate ? 'min-w-0 truncate' : 'max-w-full truncate',
          )}
        >
          {t.label}
        </span>
      </motion.button>
    )
  }

  // Glue group: the LAST chip + the trailing node travel together through
  // flex-wrap — a lone "+" on its own row is impossible.
  const lastTopic = topics[topics.length - 1]
  const glued = trailing ? (
    <span
      key={`glued-${lastTopic.id}`}
      className="inline-flex shrink-0 items-center gap-1"
    >
      {renderChip(lastTopic)}
      {trailing}
    </span>
  ) : null

  const chips = (
    <>
      {topics.slice(0, trailing ? -1 : undefined).map(renderChip)}
      {trailing ? glued : null}
    </>
  )

  if (rowClassName) return <div className={rowClassName}>{chips}</div>
  return chips
}

/** Shared geometry for the default (cards) header — 40px mobile targets,
 *  36/32px on larger screens, matching the CategoryNav chips. */
export const ADD_CHIP_CARDS =
  'h-10 sm:h-9 lg:h-8 shrink-0 rounded-full px-3.5 lg:px-3 text-[13px] sm:text-sm'
