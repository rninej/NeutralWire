import { NextRequest, NextResponse } from 'next/server'
import { recordSession, checkReferralQualification } from '@/lib/referral'
import { firebasePatch } from '@/lib/firebase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Record a session activity for a device.
 *
 * Called by the client every 2 minutes while the user is active.
 * Accumulates time per day. When a day reaches 15 seconds, it counts
 * as a "qualified day". Checks referral qualification after each update.
 *
 * Also stores the user's IANA timezone (e.g. 'Asia/Kolkata', 'Europe/London')
 * so the timezone-aware notification trigger can send morning/lunch/evening
 * briefings at the correct LOCAL time for each user.
 *
 * Body: { deviceId: string, seconds: number, referralCode?: string, tz?: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      deviceId: string
      seconds: number
      referralCode?: string
      tz?: string
    }

    if (!body.deviceId) {
      return NextResponse.json({ error: 'Missing deviceId' }, { status: 400 })
    }

    const device = await recordSession(body.deviceId, body.seconds || 15)

    // Store the user's timezone for timezone-aware notification scheduling.
    // Only write if it changed (avoids unnecessary Firebase writes).
    if (body.tz && device?.timezone !== body.tz) {
      await firebasePatch(`devices/${body.deviceId}`, {
        timezone: body.tz,
        timezoneUpdatedAt: Date.now(),
      }).catch(() => {})
    }

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
