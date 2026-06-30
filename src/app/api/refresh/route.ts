import { NextRequest, NextResponse } from 'next/server'
import type { Category } from '@/lib/news-sources'
import { aggregateCategory } from '@/lib/news-aggregator'
import {
  readCachedNews,
  refreshCategory,
  canRefresh,
} from '@/lib/news-cache'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Force a refresh of a single category.
 *
 * - Always runs a fresh RSS aggregate (bypassing the in-process feed cache
 *   would require extra plumbing; the 5-min feed cache is acceptable here).
 * - Writes the result to Firebase.
 * - Returns the fresh topics.
 *
 * The client calls this when the user clicks the "Refresh" button,
 * or automatically ~5s after initial page load if the cache was stale
 * (so the user gets instant cached data, then sees fresh data a few
 * seconds later without re-clicking).
 *
 * Rate-limited per category (5-min gap) to prevent abuse.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const category = (sp.get('category') || 'top') as Category
  const limit = Math.min(40, Math.max(5, Number(sp.get('limit') || '24')))
  const minCoverage = Math.max(1, Math.min(8, Number(sp.get('minCoverage') || '1')))
  const force = sp.get('force') === '1'

  // Rate limit (unless ?force=1).
  if (!force && !canRefresh(category)) {
    const cached = await readCachedNews(category)
    return NextResponse.json({
      category,
      topics: cached?.topics ?? [],
      cached: true,
      fresh: false,
      rateLimited: true,
      sourceCount: cached?.sourceCount ?? 0,
      articleCount: cached?.articleCount ?? 0,
      fetchedAt: cached ? new Date(cached.updatedAt).toISOString() : null,
    })
  }

  const t0 = Date.now()
  try {
    const fresh = await refreshCategory(category, (c) =>
      aggregateCategory(c, { limit: 40, minCoverage: 1 }),
    )
    if (!fresh) {
      return NextResponse.json(
        { error: 'Refresh failed', detail: 'aggregate returned null' },
        { status: 500 },
      )
    }
    return NextResponse.json({
      category,
      topics: fresh.topics
        .filter((t) => t.coverage >= minCoverage)
        .slice(0, limit),
      cached: false,
      fresh: true,
      sourceCount: fresh.sourceCount,
      articleCount: fresh.articleCount,
      fetchedAt: new Date(fresh.updatedAt).toISOString(),
      ms: Date.now() - t0,
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Refresh failed', detail: String(err) },
      { status: 500 },
    )
  }
}
