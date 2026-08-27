'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  Sparkles,
  MapPin,
  Newspaper,
  Globe,
  Landmark,
  Briefcase,
  Cpu,
  FlaskConical,
  HeartPulse,
  Trophy,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  CATEGORY_LABELS,
  PRIMARY_CATEGORIES,
  SECONDARY_CATEGORIES,
  type Category,
} from '@/lib/news-sources'
import type { CountryInfo } from '@/lib/country-detect'

/**
 * CategoryNav — the "cards" subtopic header system.
 *
 * WHY THIS EXISTS: the classic header rendered all 11 categories as a
 * wrapping block of tiny text pills (10px text on mobile, ~24px tall).
 * Users complained they were too small to read and too small to tap.
 *
 * This redesign keeps EVERY category visible but makes them big:
 *   - 40px-tall (mobile) / 36px-tall (desktop) rounded-full chips with a
 *     14px semibold label + a per-category icon — far easier to read and
 *     comfortably tappable (Apple HIG recommends ≥44px; we get close while
 *     keeping the header compact).
 *   - A single horizontally-scrollable row (scrollbar hidden) with fade
 *     gradients at the edges signalling more content — the standard
 *     Google-News / Instagram pattern. On wide screens all chips fit in
 *     one line with no scrolling.
 *   - The active category keeps the sliding-pill animation (layoutId),
 *     just bigger, and is auto-scrolled to the centre of the row so it's
 *     never hidden off-screen.
 *
 * Toggleable back to the classic pills for ALL users from /debug
 * (feature flag `subtopicNav` in Firebase, default: 'cards').
 */

/** Per-category icon — chosen to be recognisable at 16-18px.
 *
 *  Shared by ALL subtopic-nav variants (cards / tabs / tiles / sheet /
 *  dock) so every design speaks the same icon language.
 */
export function CategoryIcon({ cat, className }: { cat: Category; className?: string }) {
  const cls = cn('h-[18px] w-[18px] shrink-0', className)
  switch (cat) {
    case 'relevant':
      return <Sparkles className={cls} />
    case 'mycountry':
      return <MapPin className={cls} />
    case 'top':
      return <Newspaper className={cls} />
    case 'world':
      return <Globe className={cls} />
    case 'politics':
      return <Landmark className={cls} />
    case 'business':
      return <Briefcase className={cls} />
    case 'technology':
      return <Cpu className={cls} />
    case 'science':
      return <FlaskConical className={cls} />
    case 'health':
      return <HeartPulse className={cls} />
    case 'sports':
      return <Trophy className={cls} />
    case 'blindspots':
      // The Venn diagram mark is the blindspots brand icon — keep it
      // (custom SVG, always blue/red regardless of active state).
      return (
        <svg
          width="16"
          height="11"
          viewBox="0 0 14 10"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          className="shrink-0"
        >
          <circle cx="4.5" cy="5" r="3.5" className="fill-blue-500" opacity="0.9" />
          <circle cx="9.5" cy="5" r="3.5" className="fill-red-500" opacity="0.9" />
        </svg>
      )
  }
}

// ISO code for the United Kingdom is "GB" but users expect "UK".
// Shared by all nav variants.
export function displayCode(code: string): string {
  return code === 'GB' ? 'UK' : code.toUpperCase()
}

/** Shared helper: human label for a category ('mycountry' shows the
 *  visitor's actual country code, e.g. "UK", when known). */
export function categoryLabel(cat: Category, country?: CountryInfo | null): string {
  return cat === 'mycountry'
    ? country?.code && country.code !== 'INT'
      ? displayCode(country.code)
      : CATEGORY_LABELS[cat]
    : CATEGORY_LABELS[cat]
}

export function CategoryNav({
  category,
  onSelect,
  country,
}: {
  category: Category
  onSelect: (c: Category) => void
  country?: CountryInfo | null
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const chipRefs = React.useRef<Partial<Record<Category, HTMLButtonElement | null>>>({})
  const [canLeft, setCanLeft] = React.useState(false)
  const [canRight, setCanRight] = React.useState(false)

  const allCats: Category[] = [...PRIMARY_CATEGORIES, ...SECONDARY_CATEGORIES]

  const labelFor = (cat: Category): string => categoryLabel(cat, country)

  // ── Keep the ACTIVE chip centred in the scroll row ──
  // Manual scrollLeft math (NOT el.scrollIntoView) so the page never
  // scrolls vertically — the header is sticky and scrollIntoView could
  // tug the whole document around.
  const centreActive = React.useCallback((smooth: boolean) => {
    const container = scrollRef.current
    const chip = chipRefs.current[category]
    if (!container || !chip) return
    const target =
      chip.offsetLeft - container.clientWidth / 2 + chip.clientWidth / 2
    container.scrollTo({ left: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' })
  }, [category])

  React.useEffect(() => {
    centreActive(true)
  }, [centreActive])

  // ── Edge-fade + scroll-state tracking ──
  const updateFades = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanLeft(el.scrollLeft > 8)
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 8)
  }, [])

  React.useEffect(() => {
    // Initial state (after layout settles) + centre instantly, no animation
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
      {/* Scrollable chip row — scrollbar hidden; edge fades hint overflow */}
      <div
        ref={scrollRef}
        onScroll={updateFades}
        className="no-scrollbar flex items-center gap-1.5 overflow-x-auto scroll-smooth px-0.5 py-1"
        role="tablist"
        aria-label="News categories"
      >
        {allCats.map((cat) => {
          const active = cat === category
          return (
            <motion.button
              key={cat}
              ref={(el) => {
                chipRefs.current[cat] = el
              }}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onSelect(cat)}
              whileTap={{ scale: 0.94 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className={cn(
                // Big touch target: 40px tall on mobile, 36px on desktop.
                'relative inline-flex h-10 sm:h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[13px] sm:text-sm font-semibold transition-colors',
                active
                  ? 'text-background'
                  : 'text-foreground/75 hover:bg-muted hover:text-foreground',
              )}
            >
              {active && (
                // Sliding pill — same spring physics as the classic tabs,
                // unique layoutId so the two nav systems never fight
                // (relevant when flipping the /debug flag live).
                <motion.span
                  layoutId="category-nav-pill"
                  className="absolute inset-0 rounded-full bg-foreground"
                  transition={{ type: 'spring', stiffness: 380, damping: 28, mass: 0.85 }}
                  style={{ zIndex: 0 }}
                />
              )}
              <CategoryIcon
                cat={cat}
                className="relative z-10 h-[17px] w-[17px]"
              />
              <span className="relative z-10">{labelFor(cat)}</span>
            </motion.button>
          )
        })}
      </div>

      {/* Left edge fade — only when scrolled away from the start */}
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-background to-transparent transition-opacity duration-200',
          canLeft ? 'opacity-100' : 'opacity-0',
        )}
      />
      {/* Right edge fade — only when more content is off-screen to the right */}
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
