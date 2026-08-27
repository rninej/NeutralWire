'use client'

/**
 * subtopic-navs.tsx — FOUR additional subtopic-header designs, selectable
 * for ALL users from /debug (feature flag `subtopicNav` in Firebase).
 *
 * The full option set (see /api/flags):
 *   'classic' → original small wrapping text pills      (in page-client)
 *   'cards'   → CategoryNav big icon chips, scroll row  (category-nav.tsx)
 *   'tabs'    → SubtopicTabs          (below) — bold text tabs + animated
 *               underline, Google-News style
 *   'tiles'   → SubtopicTiles         (below) — wrapping grid of icon
 *               tiles, EVERY topic visible at once (no scrolling)
 *   'sheet'   → SubtopicSheetNav      (below) — one wide button that opens
 *               a sheet of 56px-tall tiles (biggest touch targets)
 *   'dock'    → SubtopicDock          (below) — floating bottom app dock
 *               (mobile-style tab bar), "More" opens the shared sheet
 *
 * All variants share CategoryIcon + categoryLabel from category-nav.tsx so
 * the icon language stays consistent across designs.
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Search, X, LayoutGrid } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  PRIMARY_CATEGORIES,
  SECONDARY_CATEGORIES,
  type Category,
} from '@/lib/news-sources'
import type { CountryInfo } from '@/lib/country-detect'
import { CategoryIcon, categoryLabel } from './category-nav'

export interface SubtopicNavProps {
  category: Category
  onSelect: (c: Category) => void
  country?: CountryInfo | null
}

const ALL_CATS: Category[] = [...PRIMARY_CATEGORIES, ...SECONDARY_CATEGORIES]

// ─────────────────────────────────────────────────────────────────────────
// 1. TABS — bold text tabs with an animated underline indicator.
//    Pure text (no icons) scans fastest; 44px-tall targets on mobile.
// ─────────────────────────────────────────────────────────────────────────
export function SubtopicTabs({ category, onSelect, country }: SubtopicNavProps) {
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

  return (
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
// 4. DOCK — floating bottom app dock (mobile tab-bar feel, great in
//    motion). Mobile: Relevant / My Country / Top + Search + More (the
//    sheet holds all 11). Desktop (md+): ALL categories sit inline in the
//    dock, no More button needed.
// ─────────────────────────────────────────────────────────────────────────

/** Compact labels so every dock item fits a ~60px column. */
function dockLabel(cat: Category, country?: CountryInfo | null): string {
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

  return (
    <>
      <nav
        aria-label="News categories"
        className="fixed bottom-3 left-1/2 z-40 w-[calc(100vw-1.5rem)] max-w-fit -translate-x-1/2"
      >
        <div className="mx-auto flex w-fit max-w-full items-center gap-0.5 overflow-x-auto rounded-2xl border border-border bg-background/90 p-1.5 shadow-xl backdrop-blur-xl no-scrollbar">
          {ALL_CATS.map((cat, i) => {
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
                  'flex h-[52px] w-[62px] shrink-0 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-semibold transition-colors active:scale-[0.96]',
                  hiddenOnMobile && 'hidden md:flex',
                  active
                    ? 'bg-foreground text-background'
                    : 'text-foreground/70 hover:bg-muted hover:text-foreground',
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
            className="flex h-[52px] w-[54px] shrink-0 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-semibold text-foreground/70 transition-colors hover:bg-muted hover:text-foreground active:scale-[0.96]"
          >
            <Search className="h-5 w-5" />
            <span>Search</span>
          </button>

          {/* More → full sheet (mobile only; desktop shows every topic inline) */}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-label="More topics"
            aria-haspopup="dialog"
            className="flex h-[52px] w-[62px] shrink-0 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-semibold text-foreground/70 transition-colors hover:bg-muted hover:text-foreground active:scale-[0.96] md:hidden"
          >
            <LayoutGrid className="h-5 w-5" />
            <span>More</span>
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
