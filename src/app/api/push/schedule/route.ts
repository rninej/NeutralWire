import { NextRequest, NextResponse } from 'next/server'
import webpush from 'web-push'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } from '@/lib/vapid'
import type { TopicArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 60

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)

/**
 * Schedule a test notification to be sent at a specific time.
 *
 * Body: {
 *   deviceId: string,
 *   sendAt: number  (Unix timestamp in ms — when to send)
 * }
 *
 * Since Vercel Hobby only has 1 cron/day, we can't poll frequently.
 * Instead, this endpoint stores the scheduled notification in Firebase
 * and returns a "trigger URL" that can be called to send it at the
 * scheduled time.
 *
 * For testing: the user picks a time (e.g. 1:40pm), closes the app,
 * and at 1:40pm they visit the trigger URL (or a separate cron/system
 * calls it) to send the notification.
 *
 * For automatic delivery: the client-side service worker can also poll
 * this endpoint and trigger the send when the time arrives.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      deviceId: string
      sendAt: number // Unix timestamp in ms
    }

    if (!body.deviceId || !body.sendAt) {
      return NextResponse.json(
        { error: 'Missing deviceId or sendAt' },
        { status: 400 },
      )
    }

    const now = Date.now()
    const delayMs = body.sendAt - now

    if (delayMs < 0) {
      return NextResponse.json({ error: 'Time is in the past' }, { status: 400 })
    }

    // Read the device's push subscription.
    const device = await firebaseRead<{
      pushSubscription?: {
        endpoint: string
        keys: { p256dh: string; auth: string }
      }
      pushIsStandalone?: boolean
    }>(`devices/${body.deviceId}`)

    if (!device?.pushSubscription) {
      return NextResponse.json(
        { error: 'No push subscription. Enable notifications first.' },
        { status: 404 },
      )
    }

    // Store the scheduled notification in Firebase.
    const scheduleId = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    await firebaseWrite(`scheduled/${scheduleId}`, {
      deviceId: body.deviceId,
      sendAt: body.sendAt,
      createdAt: now,
      sent: false,
    })

    // Fetch top story for the notification content.
    let topStory: TopicArticle | null = null
    try {
      const origin = req.nextUrl.origin
      const newsRes = await fetch(
        `${origin}/api/news?category=top&limit=1&minCoverage=3`,
        { cache: 'no-store' },
      )
      if (newsRes.ok) {
        const newsData = await newsRes.json()
        topStory = newsData.topics?.[0] || null
      }
    } catch {
      // continue without
    }

    const origin = req.nextUrl.origin
    const imageUrl = topStory?.imageUrl
      ? `${origin}/api/img?url=${encodeURIComponent(topStory.imageUrl)}`
      : `${origin}/icon-512.png`

    // Store the notification payload so the trigger endpoint can send it.
    const payload = JSON.stringify({
      title: 'Scheduled Test Notification',
      body: topStory
        ? `Top story: ${topStory.title.slice(0, 80)}`
        : 'This is your scheduled test notification.',
      url: topStory ? `/?topic=${topStory.topicId}` : '/',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      image: imageUrl,
      tag: 'scheduled-test',
    })
    await firebaseWrite(`scheduled/${scheduleId}/payload`, payload)

    // Build the trigger URL. Visiting this URL at the scheduled time
    // will send the notification.
    const triggerUrl = `${origin}/api/push/schedule/trigger?id=${scheduleId}`

    return NextResponse.json({
      ok: true,
      scheduleId,
      sendAt: new Date(body.sendAt).toISOString(),
      delayMinutes: Math.round(delayMs / 60000),
      triggerUrl,
      message: `Notification scheduled for ${new Date(body.sendAt).toLocaleTimeString()}. The notification will be sent automatically if the app is open, or you can trigger it manually with the trigger URL.`,
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to schedule', detail: String(err) },
      { status: 500 },
    )
  }
}

/**
 * GET: Trigger a scheduled notification by ID.
 * This is called by the client's polling SW or manually.
 */
export async function GET(req: NextRequest) {
  const scheduleId = req.nextUrl.searchParams.get('id')
  if (!scheduleId) {
    // List all pending scheduled notifications.
    const all = await firebaseRead<Record<string, {
      deviceId: string
      sendAt: number
      sent: boolean
      payload: string
    }>>('scheduled')
    if (!all) {
      return NextResponse.json({ pending: [] })
    }
    const now = Date.now()
    const pending = Object.entries(all)
      .filter(([, s]) => !s.sent && s.sendAt <= now)
      .map(([id, s]) => ({ id, deviceId: s.deviceId, sendAt: s.sendAt }))
    return NextResponse.json({ pending, now })
  }

  // Trigger a specific scheduled notification.
  const scheduled = await firebaseRead<{
    deviceId: string
    sendAt: number
    sent: boolean
    payload: string
  }>(`scheduled/${scheduleId}`)

  if (!scheduled) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  if (scheduled.sent) {
    return NextResponse.json({ ok: true, message: 'Already sent' })
  }

  // Check if it's time to send.
  if (Date.now() < scheduled.sendAt) {
    return NextResponse.json({
      ok: false,
      message: `Not yet. Send at ${new Date(scheduled.sendAt).toLocaleTimeString()}`,
      waitMs: scheduled.sendAt - Date.now(),
    })
  }

  // Read the device's push subscription.
  const device = await firebaseRead<{
    pushSubscription?: {
      endpoint: string
      keys: { p256dh: string; auth: string }
    }
  }>(`devices/${scheduled.deviceId}`)

  if (!device?.pushSubscription) {
    return NextResponse.json({ error: 'No subscription' }, { status: 404 })
  }

  // Send the push.
  try {
    await webpush.sendNotification(
      device.pushSubscription as webpush.PushSubscription,
      scheduled.payload,
    )
    // Mark as sent.
    await firebaseWrite(`scheduled/${scheduleId}/sent`, true)
    return NextResponse.json({ ok: true, message: 'Notification sent!' })
  } catch (err) {
    return NextResponse.json(
      { error: 'Send failed', detail: String(err) },
      { status: 500 },
    )
  }
}
