import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import type { Category } from '@/lib/news-sources'
import { aggregateCategory, shortenLongTitles } from '@/lib/news-aggregator'
import { aggregateMyCountryViaGdelt } from '@/lib/gdelt-aggregator'
import { refreshCategory } from '@/lib/news-cache'
import { sourcesForCountry } from '@/lib/country-detect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
// 60s lets the parallel refreshes finish AFTER the response is sent (Fluid
// Compute keeps the function alive for `after()` work up to maxDuration).
// cron-job.org only waits ~30s for the HTTP RESPONSE — and we respond in
// ≤ SYNC_WAIT_MS + cold-start overhead, so it never times out. (60 is the
// max allowed on this plan — the /api/push/* routes already use it.)
export const maxDuration = 60

/**
 * Cron-triggered endpoint that refreshes the MOST IMPORTANT news
 * categories (relevant/GB + one rotating category + mycountry/GB).
 *
 * ── TIMEOUT FIX (cron-job.org 30s limit) ──
 * History of this endpoint:
 *   v1: sequential refresh of all categories → 28-30s → cron timeouts.
 *   v2: sequential + 20s deadline race → still 26-42s responses (heavy
 *       clustering/AI/image work delays the race timer and the response
 *       flush; a fresh rotation category at :00 adds ~10s of cold AI +
 *       image-validation work) → occasional 30s timeouts.
 *   v3 (THIS): start ALL refreshes IN PARALLEL, respond after at most
 *       SYNC_WAIT_MS, and let the still-running refreshes finish
 *       post-response via `after()` (same mechanism /api/refresh uses).
 *       The response always goes out in ≤ ~10s → cron-job.org always
 *       gets a fast 200 → timeouts are impossible.
 *
 * Security: hardcoded secret (URL acts as the secret).
 *
 * Trigger: cron-job.org every 30 minutes
 *   URL: https://neutralwire.org/api/cron/refresh-all?secret=965977e5d9adca4f90aa6f23b6f95371964ed8793bc735cd
 */

const CRON_SECRET = '965977e5d9adca4f90aa6f23b6f95371964ed8793bc735cd'

// Respond after at most this long, even if refreshes are still running.
// 8s leaves a huge buffer under cron-job.org's 30s limit (cold starts +
// Vercel queueing + event-loop jitter included — observed overhead was
// up to ~10s on the old sequential version).
const SYNC_WAIT_MS = 8000

export async function GET(req: NextRequest) {
  const t0 = Date.now()

  const secret = req.nextUrl.searchParams.get('secret') || ''
  if (secret !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── Rotation: relevant/GB is ALWAYS refreshed (default landing page),
  // one RSS category rotates by UTC hour (each refreshed every ~3.5h),
  // and mycountry/GB (GDELT) runs last in the parallel set.
  const countrySourceIds = sourcesForCountry('GB')
  const hour = new Date().getUTCHours()
  const rotation = ['world', 'politics', 'business', 'technology', 'science', 'health', 'sports']
  const rotatedCategory = rotation[hour % rotation.length]

  const categoriesToRefresh = [
    { cat: 'relevant' as Category, country: 'GB', isMyCountry: false },
    { cat: rotatedCategory as Category, country: '', isMyCountry: false },
    { cat: 'mycountry' as Category, country: 'GB', isMyCountry: true },
  ]

  // ── Start ALL refreshes IN PARALLEL ──
  // (was: sequential — 3 × 8-15s ≈ 25-40s wall time, which is exactly what
  // produced the 26-42s cron-job.org durations and the 30s timeouts).
  // Each refreshCategory is self-contained: it aggregates, writes to
  // Firebase, dedups concurrent refreshes, and never throws.
  const refreshes = categoriesToRefresh.map(({ cat, country, isMyCountry }) => {
    const startedAt = Date.now()
    const promise = refreshCategory(cat, country, async () => {
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
    return {
      label: cat + (country ? `/${country}` : ''),
      startedAt,
      // Resolve to a per-category status object (refreshCategory returns
      // null on failure → topics: 0; it logs the error internally).
      done: promise.then((result) => ({
        category: cat + (country ? `/${country}` : ''),
        topics: result?.topics?.length || 0,
        ms: Date.now() - startedAt,
      })),
    }
  })

  const allDone = Promise.allSettled(refreshes.map((r) => r.done))

  // ── Respond FAST; slow refreshes finish post-response ──
  // Wait at most SYNC_WAIT_MS for quick refreshes. Whether or not they
  // all finish in that window, we respond — cron-job.org gets its 200 in
  // ≤ ~10s instead of 26-42s.
  const quickResults = await Promise.race([
    allDone.then((settled) =>
      settled.map((s) => (s.status === 'fulfilled' ? s.value : null)).filter(Boolean),
    ),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), SYNC_WAIT_MS)),
  ])

  // Belt-and-suspenders: registering the pending work with `after()` keeps
  // the function alive until every refresh settles (even the ones that
  // outlive the response), up to maxDuration. Without this, a recycled
  // instance could drop an unfinished refresh.
  after(async () => {
    await allDone
    console.log(
      `[cron/refresh-all] all refreshes settled after ${Date.now() - t0}ms (response went out earlier)`,
    )
  })

  const ms = Date.now() - t0
  const completed = quickResults !== null
  console.log(
    `[cron/refresh-all] responded in ${ms}ms — ${completed ? 'all refreshes completed' : `${refreshes.length} refreshes still running in background (after())`}`,
  )

  return NextResponse.json({
    ok: true,
    message: completed
      ? 'Refresh complete'
      : `Responded after ${ms}ms; refreshes finishing in background via after() — cron-job.org never times out`,
    results: quickResults ?? [],
    pending: completed
      ? []
      : refreshes.filter((r) => !quickResults?.some((q) => q.category === r.label)).map((r) => r.label),
    ms,
    ts: Date.now(),
  })
}
