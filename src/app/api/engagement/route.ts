import { NextRequest, NextResponse } from 'next/server'
import { firebasePatch } from '@/lib/firebase-server'

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

    return NextResponse.json({ error: 'Unknown type' }, { status: 400 })
  } catch (err) {
    return NextResponse.json(
      { error: 'Engagement tracking failed', detail: String(err) },
      { status: 500 },
    )
  }
}
