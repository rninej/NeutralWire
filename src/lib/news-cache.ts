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
 * For `mycountry`, the refresh ALWAYS merges old + new topics instead of
 * replacing. This prevents good country-specific stories from disappearing
 * when a background refresh fetches a bad result (e.g. GDELT times out →
 * RSS fallback returns international news that isn't country-specific).
 *
 * Old topics still within the 24h freshness window are preserved; new
 * topics appear first (freshest); the combined set is capped at 40.
 * The cache NEVER shrinks below its previous good state on a refresh.
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

      // ── For mycountry: ALWAYS merge old + new topics ──
      //
      // WHY ALWAYS MERGE (was: only merge when < 10 new topics):
      // The previous "replace when >= 10 topics" policy RUINED feeds.
      // Here's what happened:
      //   1. India's feed was good (proper India news from GDELT)
      //   2. A background refresh triggered (30-min TTL)
      //   3. GDELT timed out → RSS fallback returned ≥10 topics of
      //      INTERNATIONAL news (not India-specific)
      //   4. Since the new result had ≥10 topics, the cache was REPLACED
      //      entirely → all the good India news was gone, replaced by
      //      random international news
      //
      // FIX: Always merge for mycountry. New topics come first (they're
      // the freshest), then old topics that are still within the 24h
      // freshness window and not already in the new set are preserved.
      // This way:
      //   - If the new fetch has good country news → it replaces the old
      //     set naturally (new topics appear at the top, old ones age out
      //     after 24h)
      //   - If the new fetch is a bad fallback (wrong country) → the old
      //     good topics are preserved and still appear in the feed
      //   - The cache never shrinks below its previous good state
      if (category === 'mycountry') {
        const oldCached = await readCachedNews(category, country)
        if (oldCached && oldCached.topics && oldCached.topics.length > 0) {
          const now = Date.now()
          // Keep old topics that are still fresh (within 24h)
          const freshOldTopics = oldCached.topics.filter(
            (t) => now - t.latestSeen < 24 * 60 * 60 * 1000,
          )

          const newTopicIds = new Set(agg.topics.map((t) => t.topicId))
          const preservedOldTopics = freshOldTopics.filter(
            (t) => !newTopicIds.has(t.topicId),
          )

          // ── BAD FALLBACK DETECTION ──
          // If the new fetch returned very few topics (< 5) AND we have
          // a good set of old topics, the new fetch is likely a bad
          // RSS fallback (GDELT timed out → RSS returned international
          // news that the AI filter couldn't fully clean).
          //
          // In this case, put the OLD topics FIRST (they're verified
          // good country news) and the new (possibly bad) topics at the
          // END. This way users still see good country news at the top
          // even when the latest refresh was a fallback failure.
          //
          // If the new fetch returned >= 5 topics, trust it — it's
          // likely a good GDELT result. New topics go first (freshest).
          const isNewFetchBad = agg.topics.length < 5 && preservedOldTopics.length >= 5
          const finalTopics = isNewFetchBad
            ? [...preservedOldTopics, ...agg.topics].slice(0, 40) // old first, new at end
            : [...agg.topics, ...preservedOldTopics].slice(0, 40)  // new first (normal)

          console.log(
            `[news-cache] mycountry merge: ${agg.topics.length} new + ${preservedOldTopics.length} preserved old = ${finalTopics.length} total (was ${oldCached.topics.length})${isNewFetchBad ? ' [BAD FALLBACK: old topics prioritized]' : ''}`,
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
