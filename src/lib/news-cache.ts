/**
 * News cache layer backed by Firebase Realtime Database.
 *
 * Storage layout (under the database root):
 *
 *   newsCache/
 *     <category>/
 *       updatedAt: <ms epoch>
 *       sourceCount: <number>
 *       articleCount: <number>
 *       topics: [ <TopicArticle>, <TopicArticle>, ... ]
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
// Prevents the same category from being refreshed concurrently or too
// frequently within a single server instance. Combined with Firebase as
// the source of truth, this means even multi-instance deployments won't
// do redundant refreshes very often (Firebase updatedAt is the global
// arbiter).
const REFRESH_IN_FLIGHT = new Map<Category, Promise<CategoryCachePayload | null>>()
const LAST_REFRESH_AT = new Map<Category, number>()

export function cachePath(category: Category): string {
  return `${ROOT}/${category}`
}

/**
 * Read the cached payload for a category. Returns null if missing or
 * unreadable. Never throws.
 */
export async function readCachedNews(
  category: Category,
): Promise<CategoryCachePayload | null> {
  const payload = await firebaseRead<CategoryCachePayload>(cachePath(category))
  if (!payload || !Array.isArray(payload.topics)) return null
  return payload
}

/**
 * Write the cached payload for a category. Updates the updatedAt timestamp.
 */
export async function writeCachedNews(
  category: Category,
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
  return firebaseWrite(cachePath(category), payload)
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
export function canRefresh(category: Category): boolean {
  const last = LAST_REFRESH_AT.get(category) ?? 0
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
  aggregateFn: (cat: Category) => Promise<{
    topics: TopicArticle[]
    articleCount: number
    sourceCount: number
  }>,
): Promise<CategoryCachePayload | null> {
  // If a refresh is already running for this category, piggyback on it.
  const inflight = REFRESH_IN_FLIGHT.get(category)
  if (inflight) return inflight

  const p = (async () => {
    try {
      const agg = await aggregateFn(category)
      await writeCachedNews(category, agg.topics, agg.articleCount, agg.sourceCount)
      LAST_REFRESH_AT.set(category, Date.now())
      return {
        updatedAt: Date.now(),
        sourceCount: agg.sourceCount,
        articleCount: agg.articleCount,
        topics: agg.topics,
      } satisfies CategoryCachePayload
    } catch (err) {
      console.warn(`[news-cache] refresh ${category} failed:`, err)
      return null
    } finally {
      REFRESH_IN_FLIGHT.delete(category)
    }
  })()

  REFRESH_IN_FLIGHT.set(category, p)
  return p
}

export const CACHE_CONSTANTS = {
  STALE_MS,
  MIN_REFRESH_GAP_MS,
} as const
