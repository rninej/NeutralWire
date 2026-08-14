import { NextRequest, NextResponse } from 'next/server'
import type { Category } from '@/lib/news-sources'
import { aggregateCategory } from '@/lib/news-aggregator'
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
  let topicCount = 0
  let errorMsg: string | null = null
  let timedOut = false

  try {
    // ── Race the refresh against a 20s deadline ──
    // If the refresh takes longer than 20s, we abort and return a partial
    // result. The old cache data remains (not overwritten), so users still
    // see news — just slightly older. The next cron run will try again.
    const refreshPromise = refreshCategory('relevant', 'GB', async () => {
      return aggregateCategory('relevant', {
        limit: 60,
        minCoverage: 1,
        countrySourceIds,
        countryCode: 'GB',
      })
    })

    const deadlinePromise = new Promise<{ topics: never[] } | null>((resolve) => {
      setTimeout(() => resolve(null), DEADLINE_MS)
    })

    const result = await Promise.race([refreshPromise, deadlinePromise])

    if (result === null) {
      timedOut = true
      console.warn(`[cron/refresh-all] Timed out after ${DEADLINE_MS}ms — returning partial result`)
    } else {
      topicCount = result?.topics?.length || 0
    }
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err)
    console.warn(`[cron/refresh-all] relevant/GB failed:`, err)
  }

  const ms = Date.now() - t0
  console.log(`[cron/refresh-all] relevant/GB: ${topicCount} topics in ${ms}ms${timedOut ? ' (TIMED OUT)' : ''}`)

  return NextResponse.json({
    ok: true,
    message: timedOut
      ? 'Refresh timed out — old cache retained'
      : errorMsg
        ? 'Refresh completed with error'
        : 'Refresh complete',
    topics: topicCount,
    ms,
    timedOut,
    error: errorMsg,
    ts: Date.now(),
  })
}
