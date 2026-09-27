import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { firebaseRead } from '@/lib/firebase-server'
import {
  isDue,
  gatherStories,
  generateNewsletter,
  deliverDigest,
  markSent,
  type DigestSubscriber,
} from '@/lib/digest'
import { consumeLease, jobRecentlyRan, markJobRun, CRON_JOB_INTERVALS } from '@/lib/mesh/lease-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 60

/**
 * GET /api/cron/digest — the email digest cron (Premium).
 *
 * THREE trigger paths, newest first:
 *   1. Visitor cron (user-powered, DEFAULT): the oldest live visitor's
 *      browser writes a one-time Firebase lease and calls
 *      /api/cron/digest?lease=<id>&peer=<peerId> every 30 min — the
 *      newsletter runs while people are actually online, no external
 *      service needed. A per-job interval floor (Firebase + in-memory)
 *      keeps lease spammers from forcing back-to-back runs.
 *   2. External cron (cron-job.org), every 30 minutes:
 *      https://neutralwire.org/api/cron/digest?secret=965977e5d9adca4f90aa6f23b6f95371964ed8793bc735cd
 *   3. Any admin hitting it with the secret in a pinch.
 *
 * Per tick: find subscribers whose LOCAL slot is now (weekly Mon / daily /
 * 2x / 3x), gather their personalised stories, let the AI write the
 * newsletter, send (Resend) or file to the outbox. Responds fast; the
 * sends finish post-response via after(). Capped at MAX_PER_TICK sends
 * so one tick never blows the CPU budget.
 */
const CRON_SECRET = '965977e5d9adca4f90aa6f23b6f95371964ed8793bc735cd'
const MAX_PER_TICK = 5

export async function GET(req: NextRequest) {
  // ── Auth: admin secret (external cron) OR one-time mesh lease (the
  //    visitor-powered cron — same pattern as refresh-all) ──
  const secret = req.nextUrl.searchParams.get('secret') || ''
  const leaseId = req.nextUrl.searchParams.get('lease') || ''
  const peer = req.nextUrl.searchParams.get('peer') || ''

  let viaLease = false
  let authorized = secret === CRON_SECRET
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

  // ── Interval floor for lease-triggered runs (the external cron keeps
  //    its own schedule and is exempt) ──
  if (viaLease) {
    if (await jobRecentlyRan('digest', CRON_JOB_INTERVALS.digest.serverFloorMs)) {
      return NextResponse.json({ ok: true, skipped: 'interval-floor' })
    }
    await markJobRun('digest')
  }

  const t0 = Date.now()
  const subscribers =
    (await firebaseRead<Record<string, DigestSubscriber>>('digestSubscribers')) || {}

  const due = Object.entries(subscribers).filter(
    ([id, sub]) => id && sub?.email && sub.prefs?.enabled !== false && isDue(sub),
  )
  const batch = due.slice(0, MAX_PER_TICK)

  after(async () => {
    let sent = 0
    let outboxed = 0
    for (const [accountId, sub] of batch) {
      try {
        const stories = await gatherStories(accountId)
        if (stories.length === 0) continue
        const newsletter = await generateNewsletter(sub.email, stories)
        if (!newsletter) continue
        const result = await deliverDigest(accountId, sub.email, newsletter)
        await markSent(accountId)
        if (result.sent) sent++
        else outboxed++
      } catch (err) {
        console.warn(`[cron/digest] failed for ${accountId}:`, err)
      }
    }
    console.log(
      `[cron/digest] ${batch.length} due (${due.length} total subscribers) — ${sent} sent, ${outboxed} outboxed in ${Date.now() - t0}ms`,
    )
  })

  return NextResponse.json({
    ok: true,
    subscribers: Object.keys(subscribers).length,
    due: due.length,
    processing: batch.length,
    deferred: Math.max(0, due.length - batch.length),
    // 'resend' always — the key has a baked-in fallback (digest.ts).
    provider: 'resend' as const,
    ts: Date.now(),
  })
}
