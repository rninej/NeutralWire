import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import type { Category } from '@/lib/news-sources'
import { NEWS_SOURCES } from '@/lib/news-sources'
import { aggregateCategory, type TopicArticle } from '@/lib/news-aggregator'
import {
  readCachedNews,
  refreshCategory,
  isStale,
  canRefresh,
  CACHE_CONSTANTS,
} from '@/lib/news-cache'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Cache-first news endpoint.
 *
 * Behaviour:
 *   1. Read Firebase cache for the category (fast — single RTDB read).
 *   2. If the cache exists and is fresh (< STALE_MS old): return it.
 *      This is the hot path: no RSS fetching, instant response.
 *   3. If the cache exists but is stale: return it immediately AND
 *      kick off a background refresh via `after()` so the next visitor
 *      sees fresh data. The current response is still instant.
 *   4. If the cache is missing (first-ever request for this category):
 *      do a synchronous RSS aggregate so the user sees *something*,
 *      write it to Firebase, return it. Slow but only happens once.
 *
 * Query params:
 *   - category: 'top' | 'world' | 'politics' | ... (default 'top')
 *   - limit: number of topics to return (default 24, max 40)
 *   - minCoverage: minimum sources per topic (default 1, max 8)
 *   - wait: if '1', wait for refresh to finish before responding (used
 *     by the explicit Refresh button when the cache is stale).
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const category = (sp.get('category') || 'top') as Category
  const limit = Math.min(40, Math.max(5, Number(sp.get('limit') || '24')))
  const minCoverage = Math.max(1, Math.min(8, Number(sp.get('minCoverage') || '1')))
  const wait = sp.get('wait') === '1'

  const t0 = Date.now()

  // 1. Try cache first.
  let cached = await readCachedNews(category)

  // 2. If no cache at all → do one synchronous aggregate so first-time
  //    visitors get real news, not an empty page. This is the slow path
  //    but only runs once per category for the entire deployment.
  if (!cached) {
    try {
      // Always aggregate the max (40 topics, minCoverage=1) so the cache
      // stores a superset. Per-request limit/minCoverage filters are
      // applied on read, so we never need to re-aggregate when a user
      // tightens their filter.
      const agg = await aggregateCategory(category, {
        limit: 40,
        minCoverage: 1,
      })
      const payload = {
        updatedAt: Date.now(),
        sourceCount: agg.sourceCount,
        articleCount: agg.articleCount,
        topics: agg.topics,
      }
      // Fire-and-forget write to Firebase.
      void refreshCategory(category, async () => Promise.resolve(agg))
      return NextResponse.json({
        category,
        topics: applyFilters(payload.topics, limit, minCoverage),
        cached: false,
        fresh: true,
        sourceCount: payload.sourceCount,
        articleCount: payload.articleCount,
        fetchedAt: new Date(payload.updatedAt).toISOString(),
        ms: Date.now() - t0,
      })
    } catch (err) {
      return NextResponse.json(
        { error: 'Failed to fetch news', detail: String(err) },
        { status: 500 },
      )
    }
  }

  // 3. Cache exists. Truncate to requested limit/coverage before sending.
  const truncated = applyFilters(cached.topics, limit, minCoverage)

  // 4. If stale, kick off a background refresh (unless one is already
  //    running locally). Use `after()` so the response isn't blocked.
  const stale = isStale(cached)
  if (stale && canRefresh(category)) {
    if (wait) {
      // Explicit refresh request — wait for it.
      const fresh = await refreshCategory(category, (c) =>
        aggregateCategory(c, { limit: 40, minCoverage: 1 }),
      )
      if (fresh) {
        return NextResponse.json({
          category,
          topics: applyFilters(fresh.topics, limit, minCoverage),
          cached: false,
          fresh: true,
          sourceCount: fresh.sourceCount,
          articleCount: fresh.articleCount,
          fetchedAt: new Date(fresh.updatedAt).toISOString(),
          ms: Date.now() - t0,
        })
      }
    } else {
      // Background refresh — don't block the response.
      after(async () => {
        try {
          await refreshCategory(category, (c) =>
            aggregateCategory(c, { limit: 40, minCoverage: 1 }),
          )
        } catch (err) {
          console.warn(`[api/news] background refresh ${category} failed:`, err)
        }
      })
    }
  }

  return NextResponse.json({
    category,
    topics: truncated,
    cached: true,
    fresh: !stale,
    sourceCount: cached.sourceCount ?? NEWS_SOURCES.length,
    articleCount: cached.articleCount ?? truncated.length,
    fetchedAt: new Date(cached.updatedAt).toISOString(),
    staleMs: stale ? Date.now() - cached.updatedAt : 0,
    cacheTtlMs: CACHE_CONSTANTS.STALE_MS,
    ms: Date.now() - t0,
  })
}

function applyFilters(
  topics: TopicArticle[],
  limit: number,
  minCoverage: number,
): TopicArticle[] {
  return topics
    .filter((t) => t.coverage >= minCoverage)
    .sort((a, b) => {
      if (b.coverage !== a.coverage) return b.coverage - a.coverage
      return b.latestSeen - a.latestSeen
    })
    .slice(0, limit)
}
