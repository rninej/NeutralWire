/**
 * News cache layer backed by Firebase Realtime Database.
 *
 * Storage layout (under the database root):
 *
 *   newsCache/
 *     <category>/                          ← non-virtual categories
 *       updatedAt: <ms epoch>
 *       sourceCount: <number>
 *       articleCount: <number>
 *       topics: [ <TopicArticle>, ... ]
 *     <category>__<country>/               ← virtual categories (relevant, mycountry)
 *       updatedAt: <ms epoch>
 *       ...
 *
 * Each category is a single node so a page load = one read.
 * Writes are rate-limited per category to avoid hammering the DB
 * when multiple users land on the same category simultaneously.
 */

import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import type { Category } from '@/lib/news-sources'
import type { CategoryCachePayload, TopicArticle } from '@/lib/news-aggregator'

const ROOT = 'newsCache'
const STALE_MS = 10 * 60 * 1000 // 10 minutes — cache is "fresh enough" for this long
const MIN_REFRESH_GAP_MS = 5 * 60 * 1000 // never refresh the same category more often than this

// ---------- In-process refresh bookkeeping ----------
const REFRESH_IN_FLIGHT = new Map<string, Promise<CategoryCachePayload | null>>()
const LAST_REFRESH_AT = new Map<string, number>()

/**
 * Returns true if this category is virtual (depends on the visitor's country).
 */
export function isVirtualCategory(category: Category): boolean {
  return category === 'relevant' || category === 'mycountry'
}

/**
 * Build the Firebase path for a (category, country) pair.
 * Non-virtual categories ignore the country.
 */
export function cachePath(category: Category, country: string = ''): string {
  if (isVirtualCategory(category)) {
    // Sanitise country code — only allow A-Z.
    const c = (country || 'INT').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'INT'
    return `${ROOT}/${category}__${c}`
  }
  return `${ROOT}/${category}`
}

/**
 * Read the cached payload for a category. Returns null if missing or
 * unreadable. Never throws.
 */
export async function readCachedNews(
  category: Category,
  country: string = '',
): Promise<CategoryCachePayload | null> {
  const payload = await firebaseRead<CategoryCachePayload>(cachePath(category, country))
  if (!payload || !Array.isArray(payload.topics)) return null
  return payload
}

/**
 * Write the cached payload for a category. Updates the updatedAt timestamp.
 */
export async function writeCachedNews(
  category: Category,
  country: string,
  topics: TopicArticle[],
  articleCount: number,
  sourceCount: number,
): Promise<boolean> {
  const payload: CategoryCachePayload = {
    updatedAt: Date.now(),
    sourceCount,
    articleCount,
    topics,
  }
  return firebaseWrite(cachePath(category, country), payload)
}

/**
 * Decide whether a cached payload is stale (older than STALE_MS).
 */
export function isStale(payload: CategoryCachePayload | null): boolean {
  if (!payload) return true
  if (typeof payload.updatedAt !== 'number') return true
  return Date.now() - payload.updatedAt > STALE_MS
}

/**
 * Returns true if we should kick off a background refresh for this category
 * on this server instance (rate-limited locally).
 */
export function canRefresh(category: Category, country: string = ''): boolean {
  const key = cachePath(category, country)
  const last = LAST_REFRESH_AT.get(key) ?? 0
  return Date.now() - last >= MIN_REFRESH_GAP_MS
}

/**
 * Run a refresh (slow RSS aggregate + Firebase write) and return the new
 * payload. Deduplicates concurrent refreshes for the same category.
 *
 * `aggregateFn` is injected so this module stays pure / testable.
 */
export async function refreshCategory(
  category: Category,
  country: string,
  aggregateFn: (cat: Category) => Promise<{
    topics: TopicArticle[]
    articleCount: number
    sourceCount: number
  }>,
): Promise<CategoryCachePayload | null> {
  const key = cachePath(category, country)

  // If a refresh is already running for this category, piggyback on it.
  const inflight = REFRESH_IN_FLIGHT.get(key)
  if (inflight) return inflight

  const p = (async () => {
    try {
      const agg = await aggregateFn(category)
      await writeCachedNews(category, country, agg.topics, agg.articleCount, agg.sourceCount)
      LAST_REFRESH_AT.set(key, Date.now())
      return {
        updatedAt: Date.now(),
        sourceCount: agg.sourceCount,
        articleCount: agg.articleCount,
        topics: agg.topics,
      } satisfies CategoryCachePayload
    } catch (err) {
      console.warn(`[news-cache] refresh ${key} failed:`, err)
      return null
    } finally {
      REFRESH_IN_FLIGHT.delete(key)
    }
  })()

  REFRESH_IN_FLIGHT.set(key, p)
  return p
}

export const CACHE_CONSTANTS = {
  STALE_MS,
  MIN_REFRESH_GAP_MS,
} as const
