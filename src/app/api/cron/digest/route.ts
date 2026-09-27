import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import {
  digestSweep,
} from '@/lib/digest'
import { consumeLease, jobRecentlyRan, markJobRun, CRON_JOB_INTERVALS } from '@/lib/mesh/lease-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 60

/**
 * GET /api/cron/digest — the email digest cron (Premium).
 *
 * FOUR trigger paths, newest first:
 *   1. Vercel cron (vercel.json — the OFFLINE-user guarantee): fires with
 *      the `x-vercel-cron: 1` header Vercel adds to scheduled invocations.
 *      Runs in CATCH-UP mode — subscribers whose last send is staler than
 *      their frequency interval get their newsletter even if nobody's
 *      browser has been open all day (the user spec: "if users aren't
 *      online the system uses the refresh rss cron job to send the email
 *      using resend"). The digestSweep engine (lib/digest.ts) is shared
 *      with the refresh-all cron's email tail.
 *   2. Visitor cron (user-powered): the oldest live visitor's browser
 *      writes a one-time Firebase lease and calls
 *      /api/cron/digest?lease=<id>&peer=<peerId> every 30 min — the
 *      on-time path: slot-matched delivery while people are online. A
 *      per-job interval floor (Firebase + in-memory) keeps lease spammers
 *      from forcing back-to-back runs.
 *   3. External cron (cron-job.org), every 30 minutes:
 *      https://neutralwire.org/api/cron/digest?secret=965977e5d9adca4f90aa6f23b6f95371964ed8793bc735cd
 *   4. Any admin hitting it with the secret in a pinch.
 *
 * Responds fast; the sends finish post-response via after(). Capped per
 * tick so one tick never blows the CPU budget.
 */
const CRON_SECRET = '965977e5d9adca4f90aa6f23b6f95371964ed8793bc735cd'

export async function GET(req: NextRequest) {
  // ── Auth: admin secret (external cron) OR one-time mesh lease (the
  //    visitor-powered cron) OR the Vercel platform cron header ──
  const secret = req.nextUrl.searchParams.get('secret') || ''
  const leaseId = req.nextUrl.searchParams.get('lease') || ''
  const peer = req.nextUrl.searchParams.get('peer') || ''
  const viaVercelCron = req.headers.get('x-vercel-cron') === '1'

  let viaLease = false
  let authorized = secret === CRON_SECRET || viaVercelCron
  if (!authorized && leaseId) {
    const lease = await consumeLease(leaseId, peer, 'digest')
    authorized = lease.ok
    viaLease = lease.ok
    if (!lease.ok) {
      console.warn(`[cron/digest] lease rejected: ${lease.reason}`)
      return NextResponse.json({ error: 'Invalid lease' }, { status: 401 })
    }
  }
  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── Interval floor for lease- AND vercel-cron-triggered runs (the
  //    external secret cron keeps its own schedule and is exempt). The
  //    x-vercel-cron header is platform-set but spoofable by a determined
  //    caller — the floor turns spam into at-most-one-run-per-interval. ──
  if (viaLease || viaVercelCron) {
    if (await jobRecentlyRan('digest', CRON_JOB_INTERVALS.digest.serverFloorMs)) {
      return NextResponse.json({ ok: true, skipped: 'interval-floor' })
    }
    await markJobRun('digest')
  }

  const t0 = Date.now()
  const catchup = viaVercelCron
  // Catch-up sweeps process a few more (the day's offline backlog).
  const cap = catchup ? 8 : 5

  after(async () => {
    const result = await digestSweep({ catchup, cap, trigger: catchup ? 'vercel-cron-catchup' : viaLease ? 'user-cron-lease' : 'secret' })
    console.log(
      `[cron/digest]${catchup ? ' (catch-up)' : ''} ${result.due} due — ${result.sent} sent, ${result.outboxed} outboxed in ${Date.now() - t0}ms`,
    )
  })

  return NextResponse.json({
    ok: true,
    mode: catchup ? 'catchup' : 'slot',
    // 'resend' always — the key has a baked-in fallback (digest.ts).
    provider: 'resend' as const,
    ts: Date.now(),
  })
}
