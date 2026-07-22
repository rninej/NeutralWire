import { NextRequest, NextResponse } from 'next/server'
import type { Category } from '@/lib/news-sources'
import { aggregateCategory } from '@/lib/news-aggregator'
import {
  readCachedNews,
  refreshCategory,
  canRefresh,
  isVirtualCategory,
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
 * Force a refresh of a single category.
 *
 * For virtual categories, the visitor's country is auto-detected server-side
 * (or overridden via ?country=XX).
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const category = (sp.get('category') || 'relevant') as Category
  const limit = Math.min(40, Math.max(5, Number(sp.get('limit') || '24')))
  const minCoverage = Math.max(1, Math.min(8, Number(sp.get('minCoverage') || '1')))
  const force = sp.get('force') === '1'
  const countryOverride = sp.get('country') || ''

  // Resolve country for virtual categories.
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

  const countrySourceIds = isVirtualCategory(category)
    ? sourcesForCountry(country)
    : []

  // Rate limit (unless ?force=1).
  if (!force && !canRefresh(category, country)) {
    const cached = await readCachedNews(category, country)
    return NextResponse.json({
      category,
      country,
      countryName,
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
    const fresh = await refreshCategory(category, country, (c) =>
      aggregateCategory(c, {
        limit: 40,
        minCoverage: 1,
        countrySourceIds,
      }),
    )
    if (!fresh) {
      return NextResponse.json(
        { error: 'Refresh failed', detail: 'aggregate returned null' },
        { status: 500 },
      )
    }
    return NextResponse.json({
      category,
      country,
      countryName,
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
