'use client'

/**
 * add-topic-button.tsx — the "+" chip with the golden diamond corner.
 *
 * The Premium subtopic entry point, appended to every subtopic-header row
 * (cards / tabs / maxipills / sheet / dock / classic variants).
 * Golden diamond sits on the TOP-RIGHT corner of the + chip (per the user
 * spec) so the affordance reads "premium add".
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
import { Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PremiumDiamond } from '@/components/premium-ui'
import {
  getCustomTopics,
  CUSTOM_TOPICS_EVENT,
  type CustomTopicRef,
} from '@/lib/custom-topics-client'

export interface AddTopicChipProps {
  /** Complete sizing/shape for the chip — height, padding, font-size,
   *  radius, shrink — so it matches the variant's own chips. */
  chipClassName: string
  /** Diamond corner-badge size (defaults to the cards-variant 14px). */
  diamondClassName?: string
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
  diamondClassName = 'h-[14px] w-[14px]',
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
      <motion.button
        type="button"
        whileTap={{ scale: 0.94 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        onClick={onClick}
        aria-label="Add a subtopic (Premium)"
        title="Add custom subtopics"
        className={cn(
          'relative inline-flex items-center gap-1.5 whitespace-nowrap border border-amber-500/50 bg-amber-500/10 font-semibold text-amber-600 transition-colors hover:bg-amber-500/20 dark:text-amber-400',
          chipClassName,
        )}
      >
        <Plus className={cn('shrink-0', iconClassName)} />
        {label !== '' && <span className={labelClassName}>{label}</span>}
        {/* The golden diamond, pinned to the chip's top-right corner */}
        <span
          className={cn(
            'absolute -right-1 -top-1 flex items-center justify-center rounded-full bg-background',
            diamondClassName,
          )}
        >
          <PremiumDiamond className="h-full w-full" />
        </span>
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
 * subtopics, rendered like category chips (Gem icon + label, active pill
 * when selected). Re-renders live when topics are added/removed.
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
  iconClassName = 'h-[15px] w-[15px]',
  truncate = false,
  rowClassName,
  trailing,
}: {
  activeCategory: string
  onSelect: (category: string) => void
  chipClassName?: string
  activeChipClassName?: string
  iconClassName?: string
  /** Clamp chip width + ellipsize the label (tight wrapping rows). */
  truncate?: boolean
  /** When set, chips render inside this wrapper row (used by maxipills:
     a horizontally-scrolling strip, so pinned topics never squeeze the
     two adaptive rows). Rendered only while topics exist. */
  rowClassName?: string
  /** A node (typically the AddTopicChip) GLUED to the LAST chip — they
   * wrap together in wrapping layouts, so the + button can never end up
   * alone on a trailing row (the Pixel 8 Pro "3rd row with just +"
   * layout bug). With no pinned topics the trailing node renders alone,
   * exactly where the + used to sit. */
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
          active ? activeChipClassName : 'text-foreground/75 hover:bg-muted hover:text-foreground',
        )}
      >
        <PremiumDiamond className={cn('shrink-0 opacity-80', iconClassName)} />
        <span className={truncate ? 'min-w-0 truncate' : 'max-w-full truncate'}>{t.label}</span>
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
