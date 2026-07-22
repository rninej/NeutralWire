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
 *   subscription: PushSubscription,
 *   isStandalone: boolean  (true if running in installed PWA)
 * }
 *
 * Stores the subscription in Firebase with the isStandalone flag.
 * The cron/broadcast endpoints only send to subscriptions where
 * isStandalone=true, to avoid duplicate notifications (browser + PWA).
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
      isStandalone?: boolean
    }

    if (!body.deviceId || !body.subscription?.endpoint) {
      return NextResponse.json(
        { error: 'Missing deviceId or subscription' },
        { status: 400 },
      )
    }

    // Read the existing device record.
    const device = await firebaseRead<Record<string, unknown>>(
      `devices/${body.deviceId}`,
    )

    // Store the subscription with the isStandalone flag.
    // If this is a browser tab (not PWA), we mark it as isStandalone=false
    // so push notifications skip it (only PWA gets notifications).
    await firebaseWrite(`devices/${body.deviceId}`, {
      ...(device || {}),
      pushSubscription: body.subscription,
      pushIsStandalone: body.isStandalone === true,
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
