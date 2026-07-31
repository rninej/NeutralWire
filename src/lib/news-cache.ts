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
 *
 * ── My Country cache stability ──
 * The `mycountry` category uses a LONGER cache TTL (30 min vs 5 min) and
 * MERGES old + new topics on refresh instead of replacing. This prevents
 * good stories from disappearing when a GDELT refresh returns fewer/worse
 * results (GDELT's results can vary between fetches). Old topics that are
 * still within the 48h freshness window are kept; new topics are added;
 * the combined set is re-ranked. The cache NEVER shrinks below its
 * previous size on a refresh — it only grows or stays the same.
 */

import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import type { Category } from '@/lib/news-sources'
import type { CategoryCachePayload, TopicArticle } from '@/lib/news-aggregator'

const ROOT = 'newsCache'
const STALE_MS = 30 * 60 * 1000 // 30 minutes — for RSS categories (was 10 min)
const MYCOUNTRY_STALE_MS = 30 * 60 * 1000 // 30 minutes — GDELT results are stable, no need to refresh often
const MIN_REFRESH_GAP_MS = 3 * 60 * 1000 // allow refresh every 3 min
const FRESHNESS_WINDOW_MS = 48 * 60 * 60 * 1000 // keep topics younger than 48h when merging

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
 * Decide whether a cached payload is stale.
 * My Country uses a longer TTL (30 min) because GDELT results are stable
 * and frequent refreshes cause good stories to disappear.
 */
export function isStale(payload: CategoryCachePayload | null, category?: Category): boolean {
  if (!payload) return true
  if (typeof payload.updatedAt !== 'number') return true
  const ttl = category === 'mycountry' ? MYCOUNTRY_STALE_MS : STALE_MS
  return Date.now() - payload.updatedAt > ttl
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
 * Run a refresh (slow RSS/GDELT aggregate + Firebase write) and return the
 * new payload. Deduplicates concurrent refreshes for the same category.
 *
 * `aggregateFn` is injected so this module stays pure / testable.
 *
 * ── My Country merge logic ──
 * For `mycountry`, the refresh MERGES old + new topics instead of replacing.
 * This prevents good stories from disappearing when a GDELT fetch returns
 * fewer/worse results. Old topics still within the 48h freshness window are
 * kept; new topics are added; the combined set is written to the cache.
 * The cache NEVER shrinks below its previous size on a refresh.
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

      // ── For mycountry: merge old + new topics to prevent good stories
      // from disappearing on refresh ──
      if (category === 'mycountry') {
        const oldCached = await readCachedNews(category, country)
        if (oldCached && oldCached.topics && oldCached.topics.length > 0) {
          const now = Date.now()
          // Keep old topics that are still fresh (within 48h)
          const freshOldTopics = oldCached.topics.filter(
            (t) => now - t.latestSeen < FRESHNESS_WINDOW_MS,
          )
          // Merge: start with new topics, add old ones not already in the set
          const newTopicIds = new Set(agg.topics.map((t) => t.topicId))
          const preservedOldTopics = freshOldTopics.filter(
            (t) => !newTopicIds.has(t.topicId),
          )
          const mergedTopics = [...agg.topics, ...preservedOldTopics]

          // If the merged set is smaller than the old cache (shouldn't happen
          // since we're preserving old topics, but just in case), keep the
          // old cache's size by filling from old topics
          const finalTopics = mergedTopics.length >= oldCached.topics.length
            ? mergedTopics
            : [...agg.topics, ...oldCached.topics.filter((t) => !newTopicIds.has(t.topicId))]

          console.log(
            `[news-cache] mycountry merge: ${agg.topics.length} new + ${preservedOldTopics.length} preserved old = ${finalTopics.length} total (was ${oldCached.topics.length})`,
          )

          await writeCachedNews(category, country, finalTopics, agg.articleCount, agg.sourceCount)
          LAST_REFRESH_AT.set(key, Date.now())
          return {
            updatedAt: Date.now(),
            sourceCount: agg.sourceCount,
            articleCount: agg.articleCount,
            topics: finalTopics,
          } satisfies CategoryCachePayload
        }
      }

      // Default: replace the cache entirely (RSS categories)
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
  MYCOUNTRY_STALE_MS,
  MIN_REFRESH_GAP_MS,
} as const
