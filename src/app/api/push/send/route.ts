import { NextRequest, NextResponse } from 'next/server'
import webpush from 'web-push'
import { firebaseRead } from '@/lib/firebase-server'
import { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } from '@/lib/vapid'
import type { TopicArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

// Configure web-push with our VAPID keys.
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)

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
 * Cron endpoint that sends push notifications to all subscribed devices.
 *
 * Called by Vercel Cron (see vercel.json) every hour.
 *
 * Logic:
 * - For 'daily3' frequency: sends at ~8am, ~1pm, ~8pm (checks the current
 *   hour and only sends if we're in the right window AND haven't already
 *   sent today for that slot).
 * - For 'all' frequency: sends whenever the top story changes (checks
 *   against the last known top story title).
 *
 * Security: protected by a CRON_SECRET query param. Vercel Cron passes
 * this automatically.
 */
export async function GET(req: NextRequest) {
  // Verify the cron secret (prevents random people from triggering sends).
  const authHeader = req.headers.get('authorization')
  const urlSecret = req.nextUrl.searchParams.get('secret')
  const expectedSecret = process.env.CRON_SECRET || 'neutralwire-cron-2026'

  if (urlSecret !== expectedSecret && authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()
  const hour = now.getUTCHours() // Use UTC; client renders in local time
  const todayKey = now.toISOString().slice(0, 10)

  // Read all devices from Firebase.
  const allDevices = await firebaseRead<Record<string, DeviceRecord>>('devices')
  if (!allDevices) {
    return NextResponse.json({ sent: 0, reason: 'no devices' })
  }

  // Fetch the current top story (for 'all' mode + for notification content).
  let topStory: TopicArticle | null = null
  try {
    const newsRes = await fetch(
      `http://localhost:3000/api/news?category=top&limit=1&minCoverage=3`,
      { cache: 'no-store' },
    )
    if (newsRes.ok) {
      const newsData = await newsRes.json()
      topStory = newsData.topics?.[0] || null
    }
  } catch {
    // news fetch failed — continue without it
  }

  // Determine which notification slot we're in (for daily3 mode).
  // Morning: 7-9 UTC, Lunch: 12-14 UTC, Evening: 19-21 UTC
  // (These map to morning/lunch/evening in most timezones when adjusted)
  let currentSlot: 'morning' | 'lunch' | 'evening' | null = null
  if (hour >= 7 && hour < 10) currentSlot = 'morning'
  else if (hour >= 12 && hour < 15) currentSlot = 'lunch'
  else if (hour >= 19 && hour < 22) currentSlot = 'evening'

  const notificationTitle =
    currentSlot === 'morning'
      ? '🌅 Morning News'
      : currentSlot === 'lunch'
        ? '☀️ Lunch News'
        : currentSlot === 'evening'
          ? '🌙 Evening News'
          : '📰 NeutralWire'

  let sentCount = 0
  let skippedCount = 0
  const sendPromises: Promise<void>[] = []

  for (const [deviceId, device] of Object.entries(allDevices)) {
    if (!device.pushSubscription || !device.notificationsEnabled) {
      skippedCount++
      continue
    }

    const frequency = device.notificationFrequency || 'daily3'

    if (frequency === 'daily3') {
      // Only send if we're in a notification window.
      if (!currentSlot) {
        skippedCount++
        continue
      }

      // Check if we already sent this slot today.
      const lastDay = device.lastNotificationDay || ''
      const slotKey = `${todayKey}:${currentSlot}`
      if (lastDay.includes(slotKey)) {
        skippedCount++
        continue
      }

      // Send the push.
      const payload = JSON.stringify({
        title: notificationTitle,
        body: topStory
          ? `Top story: ${topStory.title.slice(0, 80)}`
          : 'Tap to read the latest neutral news.',
        url: topStory ? `/?topic=${topStory.topicId}` : '/',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: `daily-${currentSlot}`,
      })

      sendPromises.push(
        sendPush(device.pushSubscription, payload).then(async (success) => {
          if (success) {
            // Mark this slot as sent.
            const newLastDay = `${lastDay},${slotKey}`.slice(-200)
            await firebaseWrite(`devices/${deviceId}/lastNotificationDay`, newLastDay)
            sentCount++
          }
        }),
      )
    } else {
      // 'all' mode — send if the top story changed.
      if (!topStory) {
        skippedCount++
        continue
      }
      if (topStory.title === device.lastAllNewsTitle) {
        skippedCount++
        continue
      }

      const payload = JSON.stringify({
        title: '⚡ Breaking',
        body: topStory.title.slice(0, 100),
        url: `/?topic=${topStory.topicId}`,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: 'breaking-news',
      })

      sendPromises.push(
        sendPush(device.pushSubscription, payload).then(async (success) => {
          if (success) {
            await firebaseWrite(`devices/${deviceId}/lastAllNewsTitle`, topStory!.title)
            sentCount++
          }
        }),
      )
    }
  }

  await Promise.allSettled(sendPromises)

  return NextResponse.json({
    sent: sentCount,
    skipped: skippedCount,
    slot: currentSlot,
    hour,
    topStory: topStory?.title?.slice(0, 60) || null,
  })
}

/**
 * Send a push notification to a single subscription.
 * Returns true on success, false on failure.
 */
async function sendPush(
  subscription: {
    endpoint: string
    keys: { p256dh: string; auth: string }
  },
  payload: string,
): Promise<boolean> {
  try {
    await webpush.sendNotification(
      subscription as webpush.PushSubscription,
      payload,
    )
    return true
  } catch (err) {
    console.warn('[push] send failed:', err instanceof Error ? err.message : err)
    // 410 = subscription expired, 404 = not found — should be removed.
    // For now we just skip; a cleanup endpoint could remove dead subscriptions.
    return false
  }
}
