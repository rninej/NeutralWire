import { NextRequest, NextResponse } from 'next/server'
import { sendPushifyNotification } from '@/lib/pushify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Send a test push notification to a single device.
 * Uses the same sendPushifyNotification (Pushify + web-push fallback).
 *
 * Body: { deviceId: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { deviceId: string }
    if (!body.deviceId) {
      return NextResponse.json({ error: 'Missing deviceId' }, { status: 400 })
    }

    const origin = req.nextUrl.origin

    const result = await sendPushifyNotification({
      title: 'Test Notification',
      description: 'Push notifications are working! You will receive news alerts here.',
      url: origin,
      image: `${origin}/icon-512.png`,
      origin,
    })

    return NextResponse.json({
      ok: result.success,
      sent: result.sent,
      error: result.error,
      message: result.success
        ? `Test sent to ${result.sent} device(s)!`
        : `Failed: ${result.error || 'No devices with push subscriptions. Make sure you enabled notifications.'}`,
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to send test', detail: String(err) },
      { status: 500 },
    )
  }
}
