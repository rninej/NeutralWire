import { trackRequest } from '@/lib/usage-meter'
import { botGate } from '@/lib/bot-gate'
import { NextRequest, NextResponse } from 'next/server'
import {
  trackReferralClick,
  registerDevice,
  type DeviceRecord,
} from '@/lib/referral'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Track a referral click + register/update the device.
 *
 * Called by the client when:
 * 1. The page loads with ?ref=CODE (records the referral click)
 * 2. The page loads without ?ref= (just registers the device)
 *
 * Body: { deviceId: string, referralCode?: string }
 */
async function POST$(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      deviceId: string
      referralCode?: string
    }

    if (!body.deviceId) {
      return NextResponse.json({ error: 'Missing deviceId' }, { status: 400 })
    }

    // Get the client IP from headers.
    const ip =
      req.headers.get('cf-connecting-ip') ||
      req.headers.get('x-real-ip') ||
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      'unknown'

    // Register/update the device.
    const device: DeviceRecord = await registerDevice(body.deviceId, ip)

    // If there's a referral code, track the click.
    let isNewVisitor = false
    if (body.referralCode) {
      isNewVisitor = await trackReferralClick(body.referralCode, body.deviceId, ip)
    }

    return NextResponse.json({
      device,
      isNewVisitor,
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Tracking failed', detail: String(err) },
      { status: 500 },
    )
  }
}

// ── usage-meter (Nov 16, 2026 emergency CPU attribution) ──
// botGate (Nov 17, 2026): 727 of ~737 daily hits were crawler bots —
// every Googlebot render registered itself as a device in Firebase.
// Bots now get an instant 204 (r.ok === true keeps the client's 24h
// device-register gate marking working; the call sites never read the
// body). Real users and real ?ref= attributions are unchanged.
export const POST = trackRequest(
  'api/referral/track',
  botGate(POST$),
)
