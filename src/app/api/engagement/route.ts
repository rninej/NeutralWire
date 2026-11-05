import { NextRequest, NextResponse } from 'next/server'
import { firebasePatch, firebaseWrite, firebaseDelete } from '@/lib/firebase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Engagement + interests tracking endpoint.
 *
 * Body variants:
 *   { type: 'interests', deviceId, sectors: string[] }
 *     → writes devices/<deviceId>/interests (array) + interestsUpdatedAt
 *
 *   { type: 'engagement', deviceId, sector, amount, reason, total }
 *     → writes devices/<deviceId>/engagement/<sector> = total
 *
 * The cron trigger endpoint reads devices/<deviceId>/interests + engagement
 * to pick the best story per user.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    if (!body.deviceId) {
      return NextResponse.json({ error: 'Missing deviceId' }, { status: 400 })
    }

    if (body.type === 'interests') {
      if (!Array.isArray(body.sectors)) {
        return NextResponse.json({ error: 'Invalid sectors' }, { status: 400 })
      }
      await firebasePatch(`devices/${body.deviceId}`, {
        interests: body.sectors,
        interestsUpdatedAt: Date.now(),
      })
      return NextResponse.json({ ok: true })
    }

    if (body.type === 'engagement') {
      const { sector, total } = body
      if (!sector || !total) {
        return NextResponse.json({ error: 'Missing sector or total' }, { status: 400 })
      }
      await firebasePatch(`devices/${body.deviceId}/engagement/${sector}`, {
        score: Math.min(100, total.score || 0),
        clicks: total.clicks || 0,
        lastUpdate: total.lastUpdate || Date.now(),
      })
      return NextResponse.json({ ok: true })
    }

    // ── Topic vote (like/dislike) persistence ──
    // Two stores:
    //   devices/<deviceId>/topicVotes/<topicId> = 'liked' | 'disliked'
    //     (the compact flag the interest engine reads)
    //   devices/<deviceId>/voteHistory/<topicId> = { v, ts, t, s, i, d }
    //     (the display snapshot powering Account → History: title,
    //     summary, image, story date + WHEN the vote happened — so the
    //     history view needs zero extra Firebase reads to render).
    // Un-voting (null) removes both.
    if (body.type === 'topicVote') {
      const { topicId, vote } = body
      if (!topicId) {
        return NextResponse.json({ error: 'Missing topicId' }, { status: 400 })
      }
      await firebasePatch(`devices/${body.deviceId}/topicVotes`, {
        [topicId]: vote,
      })
      if (vote === null || vote === undefined) {
        // Un-vote — drop the history entry (the interest-engine flag is
        // nulled above; a tombstoned history card would lie).
        await firebaseDelete(`devices/${body.deviceId}/voteHistory/${topicId}`).catch(() => {})
      } else {
        // Snapshot from the client (it has the full topic object at vote
        // time). Guarded + size-capped server-side: Firebase nodes stay
        // small and junk can't be injected.
        const snap = (body.snapshot || {}) as Record<string, unknown>
        const asStr = (v: unknown, max: number): string =>
          typeof v === 'string' ? v.slice(0, max) : ''
        await firebaseWrite(`devices/${body.deviceId}/voteHistory/${topicId}`, {
          v: vote === 'disliked' ? 'disliked' : 'liked',
          ts: Date.now(),
          t: asStr(snap.t, 160),
          s: asStr(snap.s, 200),
          i: asStr(snap.i, 400) || null,
          d: typeof snap.d === 'number' ? snap.d : Date.now(),
        })
      }
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'Unknown type' }, { status: 400 })
  } catch (err) {
    return NextResponse.json(
      { error: 'Engagement tracking failed', detail: String(err) },
      { status: 500 },
    )
  }
}
