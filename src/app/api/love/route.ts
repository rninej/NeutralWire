import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 10

/**
 * Community love counter — powers the celebration moment in the PWA.
 *
 * GET  /api/love                    → { count: <total hearts> }
 * POST /api/love body { deviceId }  → adds ONE heart, deduplicated per
 *                                     device (a device can only ever
 *                                     add one heart, forever).
 *
 * This replaced the old donation popup: instead of interrupting happy
 * readers with an ask, the milestone moment invites them to leave a
 * single heart — a tiny investment that costs nothing. The counter is
 * public social proof ("N readers love balanced news") shown to future
 * visitors.
 *
 * Privacy: only the deviceId (random, already public to Firebase via
 * the referral system) is stored — no IP, no personal data.
 */

const ROOT = 'love'
const COUNT_PATH = `${ROOT}/count`
const PRESSED_PATH = `${ROOT}/pressed`

interface LoveState {
  count: number
  pressed: Record<string, boolean>
}

async function readState(): Promise<LoveState> {
  const [count, pressed] = await Promise.all([
    firebaseRead<number>(COUNT_PATH),
    firebaseRead<Record<string, boolean>>(PRESSED_PATH),
  ])
  return { count: typeof count === 'number' ? count : 0, pressed: pressed || {} }
}

export async function GET() {
  try {
    const state = await readState()
    return NextResponse.json(
      { count: state.count },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch {
    return NextResponse.json({ count: 0 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { deviceId?: string }
    const deviceId = (body.deviceId || '').slice(0, 48)
    if (!deviceId) {
      return NextResponse.json({ error: 'Missing deviceId' }, { status: 400 })
    }

    const state = await readState()
    if (state.pressed[deviceId]) {
      // Already pressed before — idempotent, return current count.
      return NextResponse.json({ count: state.count, already: true })
    }

    const next = state.count + 1
    // Two small writes; a race between two first-time pressers could lose
    // one heart, which is acceptable for this feature.
    await firebaseWrite(COUNT_PATH, next)
    await firebaseWrite(`${PRESSED_PATH}/${deviceId}`, true)

    return NextResponse.json({ count: next, already: false })
  } catch (err) {
    console.warn('[love] error:', err)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
