import { NextRequest, NextResponse } from 'next/server'
import { markPwaInstalled, checkReferralQualification } from '@/lib/referral'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Mark a device as having the PWA installed.
 * Also checks referral qualification (install is one of the criteria).
 *
 * Body: { deviceId: string, referralCode?: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      deviceId: string
      referralCode?: string
    }

    if (!body.deviceId) {
      return NextResponse.json({ error: 'Missing deviceId' }, { status: 400 })
    }

    await markPwaInstalled(body.deviceId)

    // Check qualification if referred.
    if (body.referralCode) {
      await checkReferralQualification(body.referralCode, body.deviceId)
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to mark install', detail: String(err) },
      { status: 500 },
    )
  }
}
