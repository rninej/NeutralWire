import { NextRequest, NextResponse } from 'next/server'
import type { Category } from '@/lib/news-sources'
import { aggregateCategory } from '@/lib/news-aggregator'
import { refreshCategory } from '@/lib/news-cache'
import { sourcesForCountry } from '@/lib/country-detect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
// 30s is enough for 1 RSS aggregate (relevant/GB takes ~5-8s). Was 30
// before but the work was in `after()` which Vercel Hobby KILLS — so
// the refresh never actually ran. Now it's synchronous.
export const maxDuration = 30

/**
 * Cron-triggered endpoint that refreshes the MOST IMPORTANT news
 * category (relevant/GB — the default landing page) every 60 minutes.
 *
 * ── CPU BUDGET (Vercel Hobby: 4hr/month Fluid Compute CPU) ──
 * This endpoint refreshes ONLY relevant/GB (~5-8s CPU per invocation).
 * At 1 invocation/hour = ~5-8s CPU/hour = ~2.5-4 hours/month.
 * Other categories refresh ON-DEMAND via /api/news SWR cache.
 *
 * ── CRITICAL FIX: removed `after()` ──
 * Previously ALL work was inside `after(async () => { ... })`. Vercel
 * Hobby plan KILLS background `after()` callbacks as soon as the
 * response is sent. So the refresh NEVER actually ran — but the
 * function still billed for the cold start + `after()` setup (~200ms
 * CPU per invocation, 24x/day = ~4.8s/day = ~2.4min/month wasted).
 *
 * NOW: the refresh runs SYNCHRONOUSLY before the response is sent.
 * The response is returned AFTER the refresh completes. cron-job.org
 * has a 60s timeout so 30s maxDuration is safe.
 *
 * Security: hardcoded secret (URL acts as the secret).
 *
 * Trigger: cron-job.org every 60 minutes
 *   URL: https://neutralwire.org/api/cron/refresh-all?secret=965977e5d9adca4f90aa6f23b6f95371964ed8793bc735cd
 */

const CRON_SECRET = '965977e5d9adca4f90aa6f23b6f95371964ed8793bc735cd'

export async function GET(req: NextRequest) {
  const t0 = Date.now()

  const secret = req.nextUrl.searchParams.get('secret') || ''
  if (secret !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const countrySourceIds = sourcesForCountry('GB')
  let topicCount = 0
  let errorMsg: string | null = null

  try {
    const fresh = await refreshCategory('relevant', 'GB', async () => {
      return aggregateCategory('relevant', {
        limit: 60,
        minCoverage: 1,
        countrySourceIds,
        countryCode: 'GB',
      })
    })
    topicCount = fresh?.topics?.length || 0
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err)
    console.warn(`[cron/refresh-all] relevant/GB failed:`, err)
  }

  const ms = Date.now() - t0
  console.log(`[cron/refresh-all] relevant/GB: ${topicCount} topics in ${ms}ms`)

  return NextResponse.json({
    ok: true,
    message: errorMsg ? 'Refresh completed with error' : 'Refresh complete',
    topics: topicCount,
    ms,
    error: errorMsg,
    ts: Date.now(),
  })
}
