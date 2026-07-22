import { NextRequest, NextResponse } from 'next/server'
import webpush from 'web-push'
import { firebaseRead } from '@/lib/firebase-server'
import { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } from '@/lib/vapid'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

interface DeviceRecord {
  pushSubscription?: {
    endpoint: string
    keys: { p256dh: string; auth: string }
    expirationTime?: number | null
  }
  notificationsEnabled?: boolean
  notificationFrequency?: 'daily3' | 'all'
  lastNotificationDay?: string
  lastAllNewsTitle?: string
}

/**
 * Debug endpoint that checks every step of the push notification chain.
 *
 * Usage: /api/debug/push?deviceId=<your-device-id>&action=check
 *        /api/debug/push?deviceId=<your-device-id>&action=send
 *
 * Returns a step-by-step diagnostic report so you can see exactly
 * where the chain is breaking.
 */
export async function GET(req: NextRequest) {
  const deviceId = req.nextUrl.searchParams.get('deviceId')
  const action = req.nextUrl.searchParams.get('action') || 'check'

  if (!deviceId) {
    return NextResponse.json({
      error: 'Missing deviceId param',
      hint: 'Open your browser console and run: localStorage.getItem("neutralwire:device-id")',
    }, { status: 400 })
  }

  const report: Array<{ step: string; status: 'ok' | 'fail' | 'warn'; detail: string }> = []

  // ── Step 1: Check VAPID keys ──
  report.push({
    step: '1. VAPID keys configured',
    status: VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY ? 'ok' : 'fail',
    detail: `Public key: ${VAPID_PUBLIC_KEY ? VAPID_PUBLIC_KEY.slice(0, 20) + '...' : 'MISSING'}, Private key: ${VAPID_PRIVATE_KEY ? 'present' : 'MISSING'}`,
  })

  // ── Step 2: Check if device exists in Firebase ──
  const device = await firebaseRead<DeviceRecord>(`devices/${deviceId}`)
  report.push({
    step: '2. Device registered in Firebase',
    status: device ? 'ok' : 'fail',
    detail: device
      ? `First seen: ${new Date(device.firstSeen || 0).toISOString()}`
      : 'Device not found. Open the site and the device will auto-register.',
  })

  if (!device) {
    return NextResponse.json({ report })
  }

  // ── Step 3: Check notificationsEnabled flag ──
  report.push({
    step: '3. notificationsEnabled flag',
    status: device.notificationsEnabled ? 'ok' : 'fail',
    detail: `notificationsEnabled: ${device.notificationsEnabled}`,
  })

  // ── Step 4: Check push subscription ──
  report.push({
    step: '4. Push subscription stored',
    status: device.pushSubscription ? 'ok' : 'fail',
    detail: device.pushSubscription
      ? `Endpoint: ${device.pushSubscription.endpoint.slice(0, 50)}...`
      : 'No push subscription. The client failed to subscribe via Push API.',
  })

  if (!device.pushSubscription) {
    report.push({
      step: '5. Send test push',
      status: 'fail',
      detail: 'Cannot send — no push subscription.',
    })
    return NextResponse.json({ report, deviceId })
  }

  // ── Step 5: Check subscription endpoint type ──
  const endpoint = device.pushSubscription.endpoint
  let pushService = 'unknown'
  if (endpoint.includes('fcm.googleapis.com')) pushService = 'FCM (Android/Chrome)'
  else if (endpoint.includes('updates.push.services.mozilla.com')) pushService = 'Mozilla'
  else if (endpoint.includes('apple.com')) pushService = 'APNs (iOS/Safari)'

  report.push({
    step: '5. Push service detected',
    status: pushService !== 'unknown' ? 'ok' : 'warn',
    detail: `${pushService} — ${endpoint.slice(0, 60)}...`,
  })

  // ── Step 6: If action=send, try sending a test push ──
  if (action === 'send') {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)

    const payload = JSON.stringify({
      title: '🔧 Debug Test',
      body: `Test from debug endpoint at ${new Date().toLocaleTimeString()}`,
      url: '/',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'debug-test',
    })

    try {
      await webpush.sendNotification(
        device.pushSubscription as webpush.PushSubscription,
        payload,
      )
      report.push({
        step: '6. Send test push',
        status: 'ok',
        detail: 'Push sent successfully! Check your device for the notification.',
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      let hint = ''
      if (errorMsg.includes('410') || errorMsg.includes('404')) {
        hint = 'Subscription expired or invalid. The client needs to re-subscribe.'
      } else if (errorMsg.includes('403')) {
        hint = 'VAPID key mismatch or unauthorised. Check VAPID_PRIVATE_KEY env var.'
      } else if (errorMsg.includes('VAPID')) {
        hint = 'VAPID authentication error. Keys may be mismatched.'
      }
      report.push({
        step: '6. Send test push',
        status: 'fail',
        detail: `${errorMsg}${hint ? ' | HINT: ' + hint : ''}`,
      })
    }
  } else {
    report.push({
      step: '6. Send test push',
      status: 'warn',
      detail: 'Skipped. Add &action=send to actually send a test push.',
    })
  }

  // ── Step 7: Check notification frequency ──
  report.push({
    step: '7. Notification frequency',
    status: 'ok',
    detail: `frequency: ${device.notificationFrequency || 'daily3 (default)'}`,
  })

  // ── Step 8: Check last notification sent ──
  report.push({
    step: '8. Last notification sent',
    status: device.lastNotificationDay ? 'ok' : 'warn',
    detail: device.lastNotificationDay
      ? `lastNotificationDay: ${device.lastNotificationDay}`
      : 'No daily notifications have been sent yet. The cron may not have run yet.',
  })

  // ── Step 9: Check cron configuration ──
  const cronSecret = process.env.CRON_SECRET
  report.push({
    step: '9. CRON_SECRET env var',
    status: cronSecret ? 'ok' : 'warn',
    detail: cronSecret
      ? 'CRON_SECRET is set (cron endpoint is protected)'
      : 'CRON_SECRET NOT set. The cron endpoint is unprotected. Set it in Vercel env vars.',
  })

  // ── Step 10: Check top story (for notification content) ──
  let topStoryOk = false
  try {
    const origin = req.nextUrl.origin
    const newsRes = await fetch(`${origin}/api/news?category=top&limit=1&minCoverage=3`)
    if (newsRes.ok) {
      const newsData = await newsRes.json()
      if (newsData.topics?.length > 0) {
        topStoryOk = true
        report.push({
          step: '10. Top story available',
          status: 'ok',
          detail: `Top story: "${newsData.topics[0].title.slice(0, 50)}..."`,
        })
      }
    }
  } catch {
    // ignore
  }
  if (!topStoryOk) {
    report.push({
      step: '10. Top story available',
      status: 'fail',
      detail: 'Could not fetch top story. The news cache may be empty.',
    })
  }

  return NextResponse.json({ report, deviceId })
}
