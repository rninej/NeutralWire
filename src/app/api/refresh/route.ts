import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import type { Category } from '@/lib/news-sources'
import { aggregateCategory, type TopicArticle } from '@/lib/news-aggregator'
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
import { firebaseRead } from '@/lib/firebase-server'

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
        countryCode: country,
      }),
    )
    if (!fresh) {
      return NextResponse.json(
        { error: 'Refresh failed', detail: 'aggregate returned null' },
        { status: 500 },
      )
    }

    // ── BACKGROUND: Pre-generate AI summaries for the top topics ──
    // The user doesn't wait for this — it runs after the response is sent.
    // When they open a topic detail later, the summary is already cached in
    // Firebase and loads instantly.
    //
    // Strategy: for each of the top N topics, check if a summary already
    // exists in Firebase. If not, fire a POST to /api/summary (which calls
    // the AI chain). We only pre-generate for topics that DON'T already have
    // a cached summary — this avoids re-running the AI unnecessarily.
    const topTopics = fresh.topics.slice(0, 8)
    after(async () => {
      const origin = req.nextUrl.origin
      try {
        // Check which topics already have summaries (one Firebase read).
        const summariesRoot = await firebaseRead<Record<string, unknown>>('summaries')
        const existingSummaries = new Set(
          summariesRoot ? Object.keys(summariesRoot) : [],
        )

        const toGenerate: TopicArticle[] = topTopics.filter(
          (t) => !existingSummaries.has(t.topicId),
        )

        if (toGenerate.length === 0) {
          console.log(`[refresh] All ${topTopics.length} top topics already have summaries`)
          return
        }

        console.log(`[refresh] Pre-generating ${toGenerate.length} summaries in background...`)

        // Fire all summary requests in parallel (max 4 at a time to avoid
        // hammering the AI providers).
        const batchSize = 4
        for (let i = 0; i < toGenerate.length; i += batchSize) {
          const batch = toGenerate.slice(i, i + batchSize)
          await Promise.allSettled(
            batch.map(async (topic) => {
              try {
                await fetch(`${origin}/api/summary`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    topicId: topic.topicId,
                    title: topic.title,
                    articles: topic.articles.map((a) => ({
                      title: a.title,
                      description: a.description,
                      sourceName: a.sourceName,
                      leaning: a.leaning,
                    })),
                  }),
                })
              } catch {
                // silent — best-effort
              }
            }),
          )
        }

        console.log(`[refresh] Background summary generation complete`)
      } catch (err) {
        console.warn('[refresh] Background summary generation failed:', err)
      }
    })

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
