import { NextRequest, NextResponse } from 'next/server'
import type { Category } from '@/lib/news-sources'
import { aggregateCategory, shortenLongTitles, type TopicArticle } from '@/lib/news-aggregator'
import { aggregateMyCountryViaGdelt } from '@/lib/gdelt-aggregator'
import { refreshCategory } from '@/lib/news-cache'
import { sourcesForCountry } from '@/lib/country-detect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
// cron-job.org has a 30s timeout. We set maxDuration to 25s so the
// function ALWAYS finishes before cron-job.org kills it. The internal
// deadline (DEADLINE_MS) is 20s — if the refresh hasn't completed by
// then, we return a partial result. This prevents the 28-30s timeouts.
export const maxDuration = 25

/**
 * Cron-triggered endpoint that refreshes the MOST IMPORTANT news
 * category (relevant/GB — the default landing page) every 60 minutes.
 *
 * ── TIMEOUT FIX (cron-job.org 30s limit) ──
 * Previously this endpoint was hitting 28-30s, causing cron-job.org to
 * time out. Root cause: aggregateCategory uses an 18s timeout for ALL
 * RSS feeds. With 100+ feeds, some are slow → total time approaches 18s,
 * then add AI processing → 28-30s.
 *
 * FIX: Race the refresh against a 20s deadline. If the refresh hasn't
 * completed by 20s, return a partial result (the cache keeps the old
 * data). This guarantees the function finishes in <22s, well under the
 * 30s cron-job.org limit.
 *
 * Security: hardcoded secret (URL acts as the secret).
 *
 * Trigger: cron-job.org every 60 minutes
 *   URL: https://neutralwire.org/api/cron/refresh-all?secret=965977e5d9adca4f90aa6f23b6f95371964ed8793bc735cd
 */

const CRON_SECRET = '965977e5d9adca4f90aa6f23b6f95371964ed8793bc735cd'

// Hard deadline: 20 seconds. If the refresh hasn't completed by this
// time, we return a partial result. This leaves 5s of buffer before the
// 25s maxDuration (which itself has 5s buffer before cron-job.org's 30s).
const DEADLINE_MS = 20000

export async function GET(req: NextRequest) {
  const t0 = Date.now()

  const secret = req.nextUrl.searchParams.get('secret') || ''
  if (secret !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const countrySourceIds = sourcesForCountry('GB')
  const results: Array<{ category: string; topics: number; ms: number; error?: string }> = []
  let timedOut = false

  // ── Refresh ALL main categories in sequence (not parallel — saves CPU) ──
  // Each category takes ~3-8s. We have 20s deadline. Can refresh ~3-4
  // categories per run. The cron runs every 60 min, so we ROTATE through
  // categories — each one gets refreshed every ~2-3 hours.
  //
  // Priority order (most-viewed first):
  //   1. relevant/GB (default landing page — ALWAYS refresh)
  //   2. Rotate through: world, politics, business, technology, science, health, sports
  //   3. mycountry/GB (GDELT — takes longer, do last)
  const hour = new Date().getUTCHours()
  const rotation = ['world', 'politics', 'business', 'technology', 'science', 'health', 'sports']
  const rotatedCategory = rotation[hour % rotation.length]

  const categoriesToRefresh = [
    { cat: 'relevant' as Category, country: 'GB', isMyCountry: false },
    { cat: rotatedCategory as Category, country: '', isMyCountry: false },
    { cat: 'mycountry' as Category, country: 'GB', isMyCountry: true },
  ]

  for (const { cat, country, isMyCountry } of categoriesToRefresh) {
    // Check deadline
    if (Date.now() - t0 > DEADLINE_MS) {
      timedOut = true
      break
    }

    const catStart = Date.now()
    let topicCount = 0
    let errorMsg: string | null = null

    try {
      const refreshPromise = refreshCategory(cat, country, async () => {
        if (isMyCountry) {
          const gdeltResult = await aggregateMyCountryViaGdelt(country, 60)
          await shortenLongTitles(gdeltResult.topics)
          return gdeltResult
        }
        return aggregateCategory(cat, {
          limit: 60,
          minCoverage: 1,
          countrySourceIds: isMyCountry ? countrySourceIds : [],
          countryCode: country,
        })
      })

      const deadlinePromise = new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), DEADLINE_MS - (Date.now() - t0))
      })

      const result = await Promise.race([refreshPromise, deadlinePromise])
      topicCount = result?.topics?.length || 0
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err)
      console.warn(`[cron/refresh-all] ${cat}/${country} failed:`, err)
    }

    results.push({
      category: cat + (country ? `/${country}` : ''),
      topics: topicCount,
      ms: Date.now() - catStart,
      error: errorMsg || undefined,
    })
  }

  const ms = Date.now() - t0
  console.log(`[cron/refresh-all] ${results.length} categories in ${ms}ms${timedOut ? ' (TIMED OUT)' : ''}`)

  return NextResponse.json({
    ok: true,
    message: timedOut ? 'Refresh timed out — partial results' : 'Refresh complete',
    results,
    timedOut,
    ms,
    ts: Date.now(),
  })
}
