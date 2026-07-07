import { NextRequest, NextResponse } from 'next/server'
import { createReferral } from '@/lib/referral'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Create a referral code for a device.
 *
 * Body: { deviceId: string }
 * Returns: { code: string, url: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { deviceId: string }
    if (!body.deviceId) {
      return NextResponse.json({ error: 'Missing deviceId' }, { status: 400 })
    }

    const code = await createReferral(body.deviceId)
    const url = `${req.nextUrl.origin}/?ref=${code}`

    return NextResponse.json({ code, url })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to create referral', detail: String(err) },
      { status: 500 },
    )
  }
}
