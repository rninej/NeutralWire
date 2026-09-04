import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead } from '@/lib/firebase-server'
import type { TopicArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 10

/**
 * GET /api/top-news
 *
 * Returns the top 20 news topics ranked by coverage (number of sources).
 * Reads from the Firebase news cache — no RSS/GDELT fetching, so it's fast.
 *
 * How it works:
 *   1. Reads multiple cached categories from Firebase (top, world, politics,
 *      business, technology, relevant__GB, etc.) in parallel.
 *   2. Merges all topics, deduplicates by topicId + by title similarity.
 *   3. Sorts by coverage (desc) — more sources = higher rank.
 *   4. Returns the top 20.
 *
 * Query params:
 *   - limit: number of topics to return (default 20, max 50)
 *   - slim: if "1", strips the articles array from each topic (smaller response)
 *   - country: ISO code for virtual categories (default: GB)
 *
 * Response:
 *   { topics: TopicArticle[], total: number, fetchedAt: string }
 */

const CACHE_CATEGORIES = [
  'top', 'world', 'politics', 'business', 'technology',
  'science', 'health', 'sports',
]

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const limit = Math.min(50, Math.max(1, Number(sp.get('limit') || '20')))
  const slim = sp.get('slim') === '1'
  const country = sp.get('country') || 'GB'

  const t0 = Date.now()

  try {
    // Read all cached categories + virtual categories in parallel.
    const virtualCats = [
      `relevant__${country.toUpperCase()}`,
      `mycountry__${country.toUpperCase()}`,
      'relevant__GB',
      'mycountry__GB',
      'relevant__US',
      'mycountry__US',
      'relevant__IN',
      'mycountry__IN',
    ]

    const allPaths = [...CACHE_CATEGORIES, ...virtualCats]
    const results = await Promise.all(
      allPaths.map(async (catKey) => {
        const payload = await firebaseRead<{ topics?: TopicArticle[] }>(`newsCache/${catKey}`)
        return payload?.topics || []
      }),
    )

    // Merge + deduplicate
    const seenIds = new Set<string>()
    const seenTitles = new Set<string>()
    const deduped: TopicArticle[] = []
    for (const topics of results) {
      for (const t of topics) {
        if (seenIds.has(t.topicId)) continue
        const normTitle = t.title.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
        if (normTitle && seenTitles.has(normTitle)) continue
        seenIds.add(t.topicId)
        if (normTitle) seenTitles.add(normTitle)
        deduped.push(t)
      }
    }

    // Sort by coverage (desc), tiebreaker: recency
    deduped.sort((a, b) => {
      if (b.coverage !== a.coverage) return b.coverage - a.coverage
      return b.latestSeen - a.latestSeen
    })

    const top = deduped.slice(0, limit)
    const finalTopics = slim
      ? top.map((t) => ({ ...t, articles: [] }))
      : top

    // ── CDN cache (Fluid CPU) ──
    // This handler reads 17 Firebase cache nodes per request. The data is
    // derived from the same newsCache nodes /api/news serves (which itself
    // is CDN-cached for 5 min) — so a 2-minute edge cache here is the SAME
    // freshness class the feed already delivers, while repeat requests
    // (bots, refreshes, multiple callers) skip the function + all 17 reads.
    // The URL includes limit/slim/country, so each variant caches
    // independently and correctly.
    const response = NextResponse.json({
      topics: finalTopics,
      total: finalTopics.length,
      fetchedAt: new Date().toISOString(),
      ms: Date.now() - t0,
    })
    response.headers.set(
      'Cache-Control',
      'public, s-maxage=120, stale-while-revalidate=300',
    )
    return response
  } catch (err) {
    console.error('[api/top-news] error:', err)
    return NextResponse.json(
      { error: 'Failed to fetch top news', detail: String(err) },
      { status: 500 },
    )
  }
}
