import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Subscribe a device to push notifications.
 *
 * Body: {
 *   deviceId: string,
 *   subscription: PushSubscription  (from the browser's pushManager.subscribe())
 * }
 *
 * Stores the subscription in Firebase at:
 *   devices/<deviceId>/pushSubscription
 *
 * The cron endpoint (/api/push/send) reads these and sends push messages.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      deviceId: string
      subscription: {
        endpoint: string
        keys: { p256dh: string; auth: string }
        expirationTime?: number | null
      }
    }

    if (!body.deviceId || !body.subscription?.endpoint) {
      return NextResponse.json(
        { error: 'Missing deviceId or subscription' },
        { status: 400 },
      )
    }

    // Store the subscription in Firebase on the device record.
    const device = await firebaseRead<Record<string, unknown>>(
      `devices/${body.deviceId}`,
    )
    await firebaseWrite(`devices/${body.deviceId}`, {
      ...(device || {}),
      pushSubscription: body.subscription,
      notificationsEnabled: true,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to subscribe', detail: String(err) },
      { status: 500 },
    )
  }
}
