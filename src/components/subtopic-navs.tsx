'use client'

/**
 * subtopic-navs.tsx — the alternative subtopic-header designs, selectable
 * for ALL users from /debug (feature flag `subtopicNav` in Firebase).
 *
 * The full option set (see /api/flags):
 *   'classic'    → original small wrapping text pills    (in page-client)
 *   'cards'      → CategoryNav big icon chips, scroll row (category-nav.tsx)
 *   'tabs'       → SubtopicTabs          (below) — bold text tabs + animated
 *                  underline, Google-News style
 *   'tiles'      → SubtopicTiles         (below) — wrapping grid of icon
 *                  tiles, EVERY topic visible at once (no scrolling)
 *   'sheet'      → SubtopicSheetNav      (below) — one wide button that opens
 *                  a sheet of 56px-tall tiles (biggest touch targets)
 *   'dock'       → SubtopicDock          (below) — floating bottom app dock
 *                  (mobile-style tab bar), "Topics" (folder preview +
 *                  count badge) opens the shared sheet; user-pinnable
 *                  from Account → "Subtopics dock"
 *   'maxipills'  → SubtopicMaxiPills     (below) — the classic pills at
 *                  the BIGGEST size that still fits in exactly two rows
 *                  (adaptive font), every row filled edge-to-edge
 *   'headerdock' → SubtopicHeaderDock    (below) — the app-dock item style
 *                  (icon over label) rendered inline in the header
 *   'tabsarrow'  → SubtopicTabs showArrow — bold tabs + a floating
 *                  swipe-hint arrow over the right edge (not a button)
 *   'cardsarrow' → CategoryNav showArrow  — big chips + the same hint
 *
 * All variants share CategoryIcon + categoryLabel from category-nav.tsx so
 * the icon language stays consistent across designs.
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollHint } from './scroll-arrow'
import {
  PRIMARY_CATEGORIES,
  SECONDARY_CATEGORIES,
  type Category,
} from '@/lib/news-sources'
import type { CountryInfo } from '@/lib/country-detect'
import { CategoryIcon, categoryLabel } from './category-nav'
import {
  getDockPicks,
  orderDockCategories,
  DOCK_PICKS_EVENT,
} from '@/lib/dock-topics'

export interface SubtopicNavProps {
  category: Category
  onSelect: (c: Category) => void
  country?: CountryInfo | null
}

const ALL_CATS: Category[] = [...PRIMARY_CATEGORIES, ...SECONDARY_CATEGORIES]

// ─────────────────────────────────────────────────────────────────────────
// 1. TABS — bold text tabs with an animated underline indicator.
//    Pure text (no icons) scans fastest; 44px-tall targets on mobile.
//    With showArrow (the 'tabsarrow' variant) a small FLOATING arrow
//    symbol is layered over the right edge of the row — a non-clickable
//    "you can swipe →" cue (it never intercepts taps).
// ─────────────────────────────────────────────────────────────────────────
export function SubtopicTabs({
  category,
  onSelect,
  country,
  showArrow,
}: SubtopicNavProps & { showArrow?: boolean }) {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const chipRefs = React.useRef<Partial<Record<Category, HTMLButtonElement | null>>>({})
  const [canLeft, setCanLeft] = React.useState(false)
  const [canRight, setCanRight] = React.useState(false)

  // Keep the ACTIVE tab centred — manual scrollLeft math (never
  // scrollIntoView) so the sticky header can't tug the page vertically.
  const centreActive = React.useCallback(
    (smooth: boolean) => {
      const container = scrollRef.current
      const chip = chipRefs.current[category]
      if (!container || !chip) return
      const target =
        chip.offsetLeft - container.clientWidth / 2 + chip.clientWidth / 2
      container.scrollTo({ left: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' })
    },
    [category],
  )

  React.useEffect(() => {
    centreActive(true)
  }, [centreActive])

  const updateFades = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanLeft(el.scrollLeft > 8)
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 8)
  }, [])

  React.useEffect(() => {
    const raf = requestAnimationFrame(() => {
      centreActive(false)
      updateFades()
    })
    window.addEventListener('resize', updateFades)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', updateFades)
    }
  }, [centreActive, updateFades])

  const row = (
    <div className="relative">
      <div
        ref={scrollRef}
        onScroll={updateFades}
        role="tablist"
        aria-label="News categories"
        className="no-scrollbar flex items-stretch gap-0.5 overflow-x-auto scroll-smooth px-0.5"
      >
        {ALL_CATS.map((cat) => {
          const active = cat === category
          return (
            <button
              key={cat}
              ref={(el) => {
                chipRefs.current[cat] = el
              }}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onSelect(cat)}
              className={cn(
                // 44px touch targets on mobile, 40px on desktop.
                'relative inline-flex h-11 sm:h-10 shrink-0 items-center px-3.5 text-sm sm:text-[15px] font-semibold transition-colors active:scale-[0.97]',
                active
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {active && (
                <motion.span
                  layoutId="subtopic-tabs-underline"
                  transition={{ type: 'spring', stiffness: 380, damping: 28, mass: 0.85 }}
                  className="absolute inset-x-2 bottom-0 h-[3px] rounded-full bg-foreground"
                />
              )}
              {categoryLabel(cat, country)}
            </button>
          )
        })}
      </div>

      {/* Edge fades — same affordance as the cards nav */}
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-background to-transparent transition-opacity duration-200',
          canLeft ? 'opacity-100' : 'opacity-0',
        )}
      />
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-background to-transparent transition-opacity duration-200',
          canRight ? 'opacity-100' : 'opacity-0',
        )}
      />

      {/* 'tabsarrow' — the floating swipe hint. An indicator, not a
          control: pointer-events-none, no click handler. Fades away
          entirely once the row is scrolled to the end. */}
      {showArrow && <ScrollHint canRight={canRight} />}
    </div>
  )

  return row
}

// ─────────────────────────────────────────────────────────────────────────
// 1b. MAXI PILLS — the classic text pills at the BIGGEST size that keeps
//     the header the same height as the classic 2-row layout:
//       • EXACTLY TWO ROWS on phones — never three, never a lonely
//         stretched pill. The 11 topics are split across two EXPLICIT
//         flex rows (6 + 5), so the row count is structural, not an
//         accident of wrapping.
//       • Every row is filled EDGE-TO-EDGE — each pill flex-grows within
//         its row, so the dead space that used to sit next to
//         "Blindspots" becomes pill padding instead. Every subtopic gets
//         a wider, easier-to-tap pill.
//       • Biggest possible font: a stepper walks the font size down
//         (13px → 9px) until neither row overflows, pre-paint — so each
//         screen width always gets the largest text that fits, and a
//         3-row / overflowing layout is never shown.
//       • Same silhouette as classic (rounded-md pills, sliding active
//         pill, Venn mark, group divider, 24px rows) and the same 2-row
//         header height — just clearer (semibold) and larger.
//       • Wide screens (≥1280px): one natural-width row of 14px pills —
//         the desktop header stays the same single-row size as classic.
// ─────────────────────────────────────────────────────────────────────────

/** Narrow-layout font-size candidates, biggest first. The stepper walks
 *  down until neither explicit row overflows (≈11px on big phones, ≈9px
 *  on 320px devices; the 8-8.5px floor covers the wide "My Country"
 *  label shown before country detection resolves). */
const MAXIPILL_FONT_STEPS = [13, 12.5, 12, 11.5, 11, 10.5, 10, 9.5, 9, 8.5, 8]

/** Index of the SSR-safe default (10px): big enough to read, small enough
 *  to fit two rows on every phone INCLUDING the pre-hydration paint (the
 *  stepper then refines it, pre-paint, once JS loads). */
const MAXIPILL_SSR_STEP = 6

/** Wide (single-row) font size. */
const MAXIPILL_WIDE_FONT = 14

/** Below this width the two-row layout is used; at/above it the pills
 *  all fit comfortably in one natural-width row. */
const MAXIPILL_WIDE_QUERY = '(min-width: 1280px)'

// useLayoutEffect runs pre-paint on the client but must be a no-op during
// SSR (React logs a warning if a server-rendered component calls it).
const useIsoLayoutEffect =
  typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect

export function SubtopicMaxiPills({ category, onSelect, country }: SubtopicNavProps) {
  const row1Ref = React.useRef<HTMLDivElement>(null)
  const row2Ref = React.useRef<HTMLDivElement>(null)
  const [fontStep, setFontStep] = React.useState(MAXIPILL_SSR_STEP)
  // Restart counter. WITHOUT it a restart can kill the stepper: if
  // adapt() queues setFontStep(1) and a restart then queues
  // setFontStep(0) in the same batch, the net state equals the current
  // state and React BAILS OUT of the re-render — the cascade would die
  // silently at step 0. runId always changes, so a restart always
  // re-renders and the adapt effect (runId in its deps) always re-fires.
  const [runId, setRunId] = React.useState(0)
  // SSR + first client render assume the narrow 2-row layout; the layout
  // effect below flips to the wide single row BEFORE first paint on big
  // screens (and matches SSR on phones), so there's never a flash.
  const [wide, setWide] = React.useState(false)

  const restart = React.useCallback(() => {
    setRunId((r) => r + 1)
    setFontStep(0)
  }, [])

  // ── Wide/narrow mode ──
  useIsoLayoutEffect(() => {
    const mq = window.matchMedia(MAXIPILL_WIDE_QUERY)
    const update = () => {
      setWide(mq.matches)
      restart() // row width changed → re-run the font stepper
    }
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [restart])

  // ── Adaptive font: step down until neither row overflows ──
  // Each step re-renders pre-paint (layout effect), so an overflowing
  // layout is never actually shown to the user.
  const adapt = React.useCallback(
    (step: number) => {
      if (wide) return
      if (step >= MAXIPILL_FONT_STEPS.length - 1) return // floor reached — accept it
      const rows = [row1Ref.current, row2Ref.current]
      const overflows = rows.some(
        (r) => r !== null && r.scrollWidth > r.clientWidth + 2,
      )
      if (!overflows) return // both rows fit — keep this size
      setFontStep(step + 1)
    },
    [wide],
  )

  useIsoLayoutEffect(() => {
    adapt(fontStep)
  }, [adapt, fontStep, runId, category, country?.code])

  // Geist (next/font) loads AFTER first paint and has different glyph
  // widths than the fallback font the stepper first measured with —
  // re-run once the real font is ready. The restart + full cascade
  // complete within one commit cycle (layout effects flush pre-paint),
  // so no intermediate size is ever painted.
  React.useEffect(() => {
    let alive = true
    const rerun = () => {
      if (alive) restart()
    }
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(rerun)
    }
    return () => {
      alive = false
    }
  }, [restart])

  // A width change (rotate / resize) can allow a BIGGER font again —
  // restart from the top and let the stepper walk back down. Debounced;
  // a transient during an active resize is imperceptible.
  React.useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    const onResize = () => {
      clearTimeout(t)
      t = setTimeout(restart, 150)
    }
    window.addEventListener('resize', onResize)
    return () => {
      clearTimeout(t)
      window.removeEventListener('resize', onResize)
    }
  }, [restart])
  // A label change (country resolved: "My Country" → "HK") changes pill
  // widths in EITHER direction — restart so the stepper can size UP too.
  React.useEffect(() => {
    restart()
  }, [country?.code, restart])

  // ── One pill, shared by both layouts ──
  const renderPill = (cat: Category) => {
    const active = cat === category
    return (
      <motion.button
        key={cat}
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => onSelect(cat)}
        whileTap={{ scale: 0.94 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        className={cn(
          // Classic silhouette at the classic header height (24px rows ≈
          // classic mobile, 28px ≈ classic desktop) so the 2-row header
          // stays the SAME size as classic — but with a bigger, clearer
          // semibold font (inherited from the wrapper's adaptive
          // fontSize). Narrow rows add `grow` so every row is filled
          // edge-to-edge — no dead space at the end of a row.
          'relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md font-semibold transition-colors',
          wide ? 'h-7 px-3.5' : 'h-6 grow px-1',
          active ? 'text-background' : 'text-foreground/80 hover:bg-muted hover:text-foreground',
        )}
      >
        {active && (
          <motion.span
            layoutId="maxipills-indicator"
            className="absolute inset-0 rounded-md bg-foreground"
            transition={{ type: 'spring', stiffness: 380, damping: 28, mass: 0.85 }}
            style={{ zIndex: 0 }}
          />
        )}
        <span className="relative z-10">{categoryLabel(cat, country)}</span>
        {/* Blindspots Venn mark — the one icon classic pills keep.
            Stays blue/red even on the filled active pill. */}
        {cat === 'blindspots' && (
          <span className="relative z-10 flex shrink-0">
            <svg width="14" height="10" viewBox="0 0 14 10" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <circle cx="4.5" cy="5" r="3.5" className="fill-blue-500" opacity="0.85" />
              <circle cx="9.5" cy="5" r="3.5" className="fill-red-500" opacity="0.85" />
            </svg>
          </span>
        )}
      </motion.button>
    )
  }

  // Divider between the primary and secondary groups — the same separator
  // the classic pills use, in its classic position (after My Country).
  // flex-none so the row's grow never stretches it.
  const divider = (
    <div aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 grow-0 bg-border" />
  )

  if (wide) {
    // ── Wide layout: ONE natural-width row (desktop header stays the
    //    same single-row size as classic; the Search button sits after
    //    the pills on the same line). ──
    return (
      <div
        role="tablist"
        aria-label="News categories"
        className="flex w-auto items-center gap-1"
        style={{ fontSize: `${MAXIPILL_WIDE_FONT}px` }}
      >
        {ALL_CATS.map((cat, i) => (
          <React.Fragment key={cat}>
            {i === PRIMARY_CATEGORIES.length && divider}
            {renderPill(cat)}
          </React.Fragment>
        ))}
      </div>
    )
  }

  // ── Narrow layout: TWO explicit rows (6 + 5), each filled
  //    edge-to-edge, at the biggest font that fits. ──
  return (
    <div
      role="tablist"
      aria-label="News categories"
      className="flex w-full flex-col gap-1"
      style={{ fontSize: `${MAXIPILL_FONT_STEPS[fontStep]}px` }}
    >
      <div ref={row1Ref} className="flex w-full items-center gap-1">
        {ALL_CATS.slice(0, 6).map((cat, i) => (
          <React.Fragment key={cat}>
            {i === PRIMARY_CATEGORIES.length && divider}
            {renderPill(cat)}
          </React.Fragment>
        ))}
      </div>
      <div ref={row2Ref} className="flex w-full items-center gap-1">
        {ALL_CATS.slice(6).map(renderPill)}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// 2. TILES — wrapping grid of icon tiles. EVERY topic is visible at once
//    (no hidden scroll content), 44px-tall targets, airy spacing.
// ─────────────────────────────────────────────────────────────────────────
export function SubtopicTiles({ category, onSelect, country }: SubtopicNavProps) {
  return (
    <div
      role="tablist"
      aria-label="News categories"
      className="flex flex-wrap gap-2 py-0.5"
    >
      {ALL_CATS.map((cat) => {
        const active = cat === category
        return (
          <motion.button
            key={cat}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(cat)}
            whileTap={{ scale: 0.94 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className={cn(
              'inline-flex h-11 shrink-0 items-center gap-2 rounded-xl border px-3.5 text-sm font-semibold transition-colors',
              active
                ? 'border-foreground bg-foreground text-background shadow-sm'
                : 'border-border bg-muted/40 text-foreground/80 hover:bg-muted hover:text-foreground',
            )}
          >
            <CategoryIcon cat={cat} className="h-[17px] w-[17px]" />
            {categoryLabel(cat, country)}
          </motion.button>
        )
      })}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Shared CATEGORY SHEET — a bottom sheet (mobile) / floating panel
// (desktop) holding a grid of 56px-tall topic tiles. Used by the 'sheet'
// header variant and the 'dock' More button.
//
// Deliberately NO body scroll-lock (the old SourcesPopup freeze was caused
// by a scroll lock) — the sheet scrolls internally, the page stays put.
// ─────────────────────────────────────────────────────────────────────────
function CategorySheet({
  open,
  onClose,
  category,
  onSelect,
  country,
}: SubtopicNavProps & { open: boolean; onClose: () => void }) {
  // Escape closes — standard sheet behaviour.
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        // AnimatePresence needs a regular motion element as its direct
        // child — framer-motion v12 never mounts a PORTAL passed as a
        // direct child. So: empty keeper element here, and the real UI
        // portalled to <body> inside it. PresenceContext flows through
        // React portals, so the sheet still plays its exit animation.
        //
        // Why portal at all: the 'sheet' variant renders this inside the
        // sticky header, whose backdrop-filter creates a containing block
        // that would trap the fixed overlay INSIDE the header (it appeared
        // clipped at the top of the page). Portalling to <body> escapes
        // every ancestor (header, transforms, filters).
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          {createPortal(
            <motion.div
              className="fixed inset-0 z-[70]"
              role="dialog"
              aria-modal="true"
              aria-label="Browse topics"
            >
              {/* Backdrop — click to close */}
              <div
                className="absolute inset-0 bg-black/45 backdrop-blur-[2px]"
                onClick={onClose}
              />

              {/* Sheet: bottom-anchored on mobile, floats near the bottom on
                  desktop. Slides up with a spring; content scrolls inside. */}
              <motion.div
                initial={{ y: '100%' }}
                animate={{ y: 0 }}
                exit={{ y: '100%' }}
                transition={{ type: 'spring', stiffness: 380, damping: 38 }}
                className="nw-scrollbar absolute inset-x-0 bottom-0 mx-auto max-h-[78dvh] w-full overflow-y-auto rounded-t-2xl border-t bg-background p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl sm:bottom-6 sm:max-w-lg sm:rounded-2xl sm:border sm:pb-4"
              >
                {/* Drag-handle affordance (mobile only) */}
                <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border sm:hidden" />

                <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 className="text-base font-bold">Browse topics</h2>
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close"
                    className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <X className="h-4.5 w-4.5" />
                  </button>
                </div>

                {/* 56px-tall tiles — the biggest touch targets of any variant */}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {ALL_CATS.map((cat) => {
                    const active = cat === category
                    return (
                      <motion.button
                        key={cat}
                        type="button"
                        onClick={() => {
                          onSelect(cat)
                          onClose()
                        }}
                        whileTap={{ scale: 0.96 }}
                        transition={{ duration: 0.12, ease: 'easeOut' }}
                        aria-pressed={active}
                        className={cn(
                          'flex h-14 items-center gap-2.5 rounded-xl border px-3.5 text-sm font-semibold transition-colors',
                          active
                            ? 'border-foreground bg-foreground text-background shadow-sm'
                            : 'border-border bg-muted/40 text-foreground/85 hover:bg-muted hover:text-foreground',
                        )}
                      >
                        <CategoryIcon cat={cat} className="h-[18px] w-[18px]" />
                        <span className="truncate">{categoryLabel(cat, country)}</span>
                      </motion.button>
                    )
                  })}
                </div>
              </motion.div>
            </motion.div>,
            document.body,
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// 3. SHEET NAV — one wide button showing the CURRENT topic; tapping it
//    opens the CategorySheet of big tiles. Keeps the header minimal while
//    giving every topic a 56px target inside the sheet.
// ─────────────────────────────────────────────────────────────────────────
export function SubtopicSheetNav({ category, onSelect, country }: SubtopicNavProps) {
  const [open, setOpen] = React.useState(false)

  return (
    <div className="py-0.5">
      <motion.button
        type="button"
        onClick={() => setOpen(true)}
        whileTap={{ scale: 0.98 }}
        transition={{ duration: 0.12, ease: 'easeOut' }}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-11 w-full items-center justify-between gap-3 rounded-xl border-2 border-border bg-muted/40 px-4 text-sm font-bold text-foreground transition-colors hover:bg-muted sm:w-auto sm:min-w-[240px]"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <CategoryIcon cat={category} className="h-[18px] w-[18px] shrink-0" />
          <span className="truncate">{categoryLabel(category, country)}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
          All topics
          <ChevronDown className="h-4 w-4" />
        </span>
      </motion.button>

      <CategorySheet
        open={open}
        onClose={() => setOpen(false)}
        category={category}
        onSelect={onSelect}
        country={country}
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// 3b. HEADER DOCK — the app-dock item style (icon stacked over a compact
//     label, filled active state) rendered INLINE in the header. It's the
//     bottom dock's visual language without the floating container, so it
//     reads as a native top tab bar. All 11 topics sit in ONE row on
//     desktop; on mobile the row scrolls (edge fades hint it) and the
//     active item auto-centres.
// ─────────────────────────────────────────────────────────────────────────
export function SubtopicHeaderDock({ category, onSelect, country }: SubtopicNavProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const chipRefs = React.useRef<Partial<Record<Category, HTMLButtonElement | null>>>({})
  const [canLeft, setCanLeft] = React.useState(false)
  const [canRight, setCanRight] = React.useState(false)

  // Keep the ACTIVE item visible when the row scrolls (same manual
  // scrollLeft math as the tabs/cards navs — never scrollIntoView, the
  // header is sticky).
  const centreActive = React.useCallback(
    (smooth: boolean) => {
      const container = scrollRef.current
      const chip = chipRefs.current[category]
      if (!container || !chip) return
      const target =
        chip.offsetLeft - container.clientWidth / 2 + chip.clientWidth / 2
      container.scrollTo({ left: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' })
    },
    [category],
  )

  React.useEffect(() => {
    centreActive(true)
  }, [centreActive])

  const updateFades = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanLeft(el.scrollLeft > 8)
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 8)
  }, [])

  React.useEffect(() => {
    const raf = requestAnimationFrame(() => {
      centreActive(false)
      updateFades()
    })
    window.addEventListener('resize', updateFades)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', updateFades)
    }
  }, [centreActive, updateFades])

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        onScroll={updateFades}
        role="tablist"
        aria-label="News categories"
        className="no-scrollbar flex items-center gap-1 overflow-x-auto scroll-smooth px-0.5 py-1"
      >
        {ALL_CATS.map((cat) => {
          const active = cat === category
          return (
            <button
              key={cat}
              ref={(el) => {
                chipRefs.current[cat] = el
              }}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onSelect(cat)}
              className={cn(
                // Same geometry as the bottom dock (52px tall, icon over
                // label) so the two designs feel identical — but 72px wide
                // (vs the dock's 62px) because the header has room and it
                // keeps the longest label ("Blindspots") un-truncated.
                'flex h-[52px] w-[72px] shrink-0 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-semibold transition-colors active:scale-[0.96]',
                active
                  ? 'bg-foreground text-background shadow-sm'
                  : 'text-foreground/70 hover:bg-muted hover:text-foreground',
              )}
            >
              <CategoryIcon cat={cat} className="h-5 w-5" />
              <span className="max-w-full truncate px-1">{dockLabel(cat, country)}</span>
            </button>
          )
        })}
      </div>

      {/* Edge fades — hint there's more to scroll on narrow screens */}
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-background to-transparent transition-opacity duration-200',
          canLeft ? 'opacity-100' : 'opacity-0',
        )}
      />
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-background to-transparent transition-opacity duration-200',
          canRight ? 'opacity-100' : 'opacity-0',
        )}
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// 4. DOCK — floating bottom app dock (mobile tab-bar feel, great in
//    motion). Mobile: the first 3 subtopics + Search + Topics (the sheet
//    holds all 11). Desktop (md+): ALL categories sit inline in the dock,
//    no Topics button needed.
//
//    PERSONALISATION: the user can pin their favourite subtopics to the
//    front of the dock from Account → "Subtopics dock" (stored on-device,
//    applied live via the neutralwire:dock-topics-changed event). The
//    first 3 slots on mobile are then THEIR picks.
//
//    TOPICS BUTTON: iOS-folder-style — a tiny 2×2 grid of the icons it
//    contains + a count badge — so you can SEE what's inside without the
//    dock getting cluttered. Tapping still opens the CategorySheet.
//
//    VISIBILITY: solid background + double border/ring + a deep shadow —
//    the earlier 90%-opaque blur washed the dock into the page behind it.
// ─────────────────────────────────────────────────────────────────────────

/** Compact labels so every dock item fits a ~60px column. */
export function dockLabel(cat: Category, country?: CountryInfo | null): string {
  if (cat === 'mycountry') {
    return country?.code && country.code !== 'INT'
      ? country.code === 'GB'
        ? 'UK'
        : country.code.toUpperCase()
      : 'Local'
  }
  if (cat === 'top') return 'Top'
  if (cat === 'relevant') return 'For You'
  return categoryLabel(cat, country)
}

export function SubtopicDock({
  category,
  onSelect,
  country,
  onSearch,
}: SubtopicNavProps & { onSearch: () => void }) {
  const [moreOpen, setMoreOpen] = React.useState(false)

  // ── User's pinned dock subtopics (Account → "Subtopics dock") ──
  // null until mount so SSR + first client paint match (default order);
  // re-orders the instant picks load / change — no reload needed.
  const [picks, setPicks] = React.useState<Category[] | null>(null)
  React.useEffect(() => {
    const load = () => setPicks(getDockPicks())
    load()
    window.addEventListener(DOCK_PICKS_EVENT, load)
    return () => window.removeEventListener(DOCK_PICKS_EVENT, load)
  }, [])

  // Dock order: user picks pinned first, then the default order.
  const ordered = React.useMemo(
    () => orderDockCategories(picks ?? []),
    [picks],
  )

  // The subtopics NOT visible inline on mobile — these are the ones
  // "inside" the Topics button. Shown as the folder preview + badge.
  const hiddenCats = ordered.slice(3)
  const previewCats = hiddenCats.slice(0, 4)

  return (
    <>
      <nav
        aria-label="News categories"
        className="fixed bottom-3 left-1/2 z-40 w-[calc(100vw-1.5rem)] max-w-fit -translate-x-1/2"
      >
        {/* Solid (not translucent) panel: a crisp card that always reads
            as a dock, over ANY page content. ring adds a subtle inner edge
            so light-on-light and dark-on-dark both stay visible. */}
        <div className="mx-auto flex w-fit max-w-full items-center gap-0.5 overflow-x-auto rounded-2xl border border-border bg-background p-1.5 shadow-2xl shadow-black/20 ring-1 ring-black/[0.06] no-scrollbar dark:shadow-black/50 dark:ring-white/[0.09]">
          {ordered.map((cat, i) => {
            const active = cat === category
            // First 3 items always visible; the rest join on md+ screens.
            const hiddenOnMobile = i > 2
            return (
              <button
                key={cat}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onSelect(cat)}
                className={cn(
                  // 68px wide (not the old 62px) so the longest label
                  // ("Blindspots" ≈ 60px at 10px semibold) never truncates.
                  'flex h-[52px] w-[68px] shrink-0 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-semibold transition-colors active:scale-[0.96]',
                  hiddenOnMobile && 'hidden md:flex',
                  active
                    ? 'bg-foreground text-background shadow-sm'
                    : 'text-foreground/75 hover:bg-muted hover:text-foreground',
                )}
              >
                <CategoryIcon cat={cat} className="h-5 w-5" />
                <span className="max-w-full truncate px-1">{dockLabel(cat, country)}</span>
              </button>
            )
          })}

          <div className="mx-0.5 h-8 w-px shrink-0 bg-border" />

          {/* Search — always available (dock mode has no header search on desktop) */}
          <button
            type="button"
            onClick={onSearch}
            aria-label="Search news"
            title="Search news"
            className="flex h-[52px] w-[54px] shrink-0 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-semibold text-foreground/75 transition-colors hover:bg-muted hover:text-foreground active:scale-[0.96]"
          >
            <Search className="h-5 w-5" />
            <span>Search</span>
          </button>

          {/* Topics → full sheet (mobile only; desktop shows every topic
              inline). The icon is an iOS-folder-style preview of what's
              inside: a 2×2 grid of the hidden subtopics' icons + a count
              badge — clear at a glance, zero extra dock width. */}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-label={`All topics — ${hiddenCats.length} more`}
            aria-haspopup="dialog"
            title={`All topics (${hiddenCats.length} more inside)`}
            className="flex h-[52px] w-[68px] shrink-0 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-semibold text-foreground/75 transition-colors hover:bg-muted hover:text-foreground active:scale-[0.96] md:hidden"
          >
            <span className="relative flex h-[28px] w-[28px] items-center justify-center">
              {/* Folder square with a 2×2 grid of the icons inside */}
              <span className="flex h-[26px] w-[26px] items-center justify-center rounded-lg border border-border bg-muted/60 p-[3px] shadow-sm">
                <span className="grid w-full grid-cols-2 place-items-center gap-[2px] text-foreground/70">
                  {previewCats.map((cat) => (
                    <CategoryIcon key={cat} cat={cat} className="h-[8px] w-[8px]" />
                  ))}
                </span>
              </span>
              {/* Count badge — how many topics are inside */}
              <span className="absolute -bottom-[5px] -right-[7px] flex h-[15px] min-w-[15px] items-center justify-center rounded-full border border-background bg-foreground px-[3px] text-[8px] font-bold leading-none text-background tabular-nums">
                {hiddenCats.length}
              </span>
            </span>
            <span>Topics</span>
          </button>
        </div>
      </nav>

      <CategorySheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        category={category}
        onSelect={onSelect}
        country={country}
      />
    </>
  )
}
