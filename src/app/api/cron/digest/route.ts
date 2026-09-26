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

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 60

/**
 * GET /api/cron/digest?secret=… — the email digest cron (Premium).
 *
 * Trigger from the same external cron service (cron-job.org) that hits
 * refresh-all, every 30 minutes:
 *   https://neutralwire.org/api/cron/digest?secret=965977e5d9adca4f90aa6f23b6f95371964ed8793bc735cd
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
  const secret = req.nextUrl.searchParams.get('secret') || ''
  if (secret !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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
    provider: process.env.RESEND_API_KEY ? 'resend' : 'outbox-only',
    ts: Date.now(),
  })
}
