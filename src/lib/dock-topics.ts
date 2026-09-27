/**
 * User-customised bottom-dock subtopics (client-side utilities).
 *
 * Lets a user pin the subtopics they actually read to the FRONT of the
 * floating bottom dock ('dock' nav variant). Everything they don't pick
 * stays in its default order behind them (still one tap away in the
 * Topics sheet / on desktop).
 *
 * Storage: localStorage on this device (same philosophy as the theme +
 * interests settings — no login required). A custom event lets the dock
 * re-order itself LIVE while the Account sheet is open, with no reload.
 */
import {
  PRIMARY_CATEGORIES,
  SECONDARY_CATEGORIES,
  type Category,
} from '@/lib/news-sources'

const DOCK_PICKS_KEY = 'neutralwire:dock-picks'
export const DOCK_PICKS_EVENT = 'neutralwire:dock-topics-changed'

/** All categories in default dock order. */
export const ALL_DOCK_CATEGORIES: Category[] = [
  ...PRIMARY_CATEGORIES,
  ...SECONDARY_CATEGORIES,
]

/** Read the user's pinned dock subtopics (ordered). [] = default order. */
export function getDockPicks(): Category[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(DOCK_PICKS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Keep only valid categories, preserve order, drop duplicates.
    const valid = parsed.filter(
      (c): c is Category =>
        typeof c === 'string' && ALL_DOCK_CATEGORIES.includes(c as Category),
    )
    return Array.from(new Set(valid))
  } catch {
    return []
  }
}

/** Save the pinned dock subtopics + notify listeners (live re-order). */
export function setDockPicks(picks: Category[]): void {
  if (typeof window === 'undefined') return
  try {
    if (picks.length === 0) {
      localStorage.removeItem(DOCK_PICKS_KEY)
    } else {
      localStorage.setItem(DOCK_PICKS_KEY, JSON.stringify(picks))
    }
  } catch {
    // silent — localStorage might be full / disabled
  }
  window.dispatchEvent(new CustomEvent(DOCK_PICKS_EVENT))
}

/**
 * Full dock order for a set of picks: the picks first (in the user's
 * chosen order), then every remaining category in the default order.
 * Unknown/empty picks → the default order, unchanged.
 */
export function orderDockCategories(picks: Category[]): Category[] {
  if (picks.length === 0) return ALL_DOCK_CATEGORIES
  const picked = picks.filter((c) => ALL_DOCK_CATEGORIES.includes(c))
  const rest = ALL_DOCK_CATEGORIES.filter((c) => !picked.includes(c))
  return [...picked, ...rest]
}
