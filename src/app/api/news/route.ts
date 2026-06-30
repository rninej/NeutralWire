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
  isVirtualCategory,
  CACHE_CONSTANTS,
} from '@/lib/news-cache'
import {
  detectCountryServer,
  sourcesForCountry,
  DEFAULT_COUNTRY,
} from '@/lib/country-detect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Cache-first news endpoint.
 *
 * Behaviour:
 *   1. For virtual categories (`relevant`, `mycountry`), detect the visitor's
 *      country from request headers (server-side, ip-api.com).
 *   2. Read Firebase cache for the (category, country) pair.
 *   3. If fresh: return it (fast).
 *   4. If stale: return it immediately AND kick off a background refresh.
 *   5. If missing: do a synchronous aggregate (one-time per country).
 *
 * Query params:
 *   - category: 'relevant' | 'mycountry' | 'top' | ... (default 'relevant')
 *   - country:  ISO 3166-1 alpha-2 code (overrides auto-detection)
 *   - limit, minCoverage, wait
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const category = (sp.get('category') || 'relevant') as Category
  const limit = Math.min(40, Math.max(5, Number(sp.get('limit') || '24')))
  const minCoverage = Math.max(1, Math.min(8, Number(sp.get('minCoverage') || '1')))
  const wait = sp.get('wait') === '1'
  const countryOverride = sp.get('country') || ''

  const t0 = Date.now()

  // Resolve the visitor's country for virtual categories.
  let country = countryOverride
  let countryName = ''
  if (isVirtualCategory(category)) {
    if (!country) {
      const detected = await detectCountryServer(req.headers)
      country = detected?.code || DEFAULT_COUNTRY.code
      countryName = detected?.name || DEFAULT_COUNTRY.name
    } else {
      countryName = country
    }
  }

  // For non-virtual categories we still pass an empty country — cachePath
  // ignores it.
  const countrySourceIds = isVirtualCategory(category)
    ? sourcesForCountry(country)
    : []

  // 1. Try cache first.
  let cached = await readCachedNews(category, country)

  // 2. If no cache at all → do one synchronous aggregate.
  if (!cached) {
    try {
      const agg = await aggregateCategory(category, {
        limit: 40,
        minCoverage: 1,
        countrySourceIds,
      })
      const payload = {
        updatedAt: Date.now(),
        sourceCount: agg.sourceCount,
        articleCount: agg.articleCount,
        topics: agg.topics,
      }
      void refreshCategory(category, country, async () => Promise.resolve(agg))
      return NextResponse.json({
        category,
        country,
        countryName,
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

  // 3. Cache exists.
  const truncated = applyFilters(cached.topics, limit, minCoverage)

  // 4. Background refresh if stale.
  const stale = isStale(cached)
  if (stale && canRefresh(category, country)) {
    if (wait) {
      const fresh = await refreshCategory(category, country, (c) =>
        aggregateCategory(c, {
          limit: 40,
          minCoverage: 1,
          countrySourceIds,
        }),
      )
      if (fresh) {
        return NextResponse.json({
          category,
          country,
          countryName,
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
      after(async () => {
        try {
          await refreshCategory(category, country, (c) =>
            aggregateCategory(c, {
              limit: 40,
              minCoverage: 1,
              countrySourceIds,
            }),
          )
        } catch (err) {
          console.warn(`[api/news] background refresh ${category}/${country} failed:`, err)
        }
      })
    }
  }

  return NextResponse.json({
    category,
    country,
    countryName,
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
