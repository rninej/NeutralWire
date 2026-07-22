import { NextRequest, NextResponse } from 'next/server'
import { recordSession, checkReferralQualification } from '@/lib/referral'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Record a session activity for a device.
 *
 * Called by the client every 15 seconds while the user is active.
 * Accumulates time per day. When a day reaches 15 seconds, it counts
 * as a "qualified day". Checks referral qualification after each update.
 *
 * Body: { deviceId: string, seconds: number, referralCode?: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      deviceId: string
      seconds: number
      referralCode?: string
    }

    if (!body.deviceId) {
      return NextResponse.json({ error: 'Missing deviceId' }, { status: 400 })
    }

    const device = await recordSession(body.deviceId, body.seconds || 15)

    // If this device was referred, check if they've now qualified.
    if (device?.referralCode) {
      await checkReferralQualification(device.referralCode, body.deviceId)
    } else if (body.referralCode) {
      await checkReferralQualification(body.referralCode, body.deviceId)
    }

    return NextResponse.json({
      currentStreak: device?.currentStreak || 0,
      bestStreak: device?.bestStreak || 0,
      pwaInstalled: device?.pwaInstalled || false,
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Session recording failed', detail: String(err) },
      { status: 500 },
    )
  }
}
