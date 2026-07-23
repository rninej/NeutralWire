/**
 * Pushify API wrapper with web-push fallback.
 *
 * Primary: Pushify API (free, unlimited, handles everything)
 * Fallback: Our own web-push implementation (uses Firebase-stored
 *   push subscriptions from devices that enabled notifications)
 *
 * Dual approach: runs both in parallel. If Pushify has 0 subscribers,
 * web-push still delivers.
 */

import webpush from 'web-push'
import { firebaseRead, firebasePatch } from '@/lib/firebase-server'
import { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } from '@/lib/vapid'

const PUSHIFY_API_KEY =
  process.env.PUSHIFY_API_KEY || ''
const PUSHIFY_BASE_URL = 'https://pushify.com/api'
const PUSHIFY_WEBSITE_ID = process.env.PUSHIFY_WEBSITE_ID || '294'

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)

interface NotificationData {
  title: string
  description: string
  url: string
  image?: string
  notifId?: string
  origin?: string // The site origin for building absolute icon URLs
}

/**
 * Send a push notification using BOTH Pushify AND web-push fallback.
 */
export async function sendPushifyNotification(
  notification: NotificationData,
): Promise<{ success: boolean; sent: number; error?: string }> {
  const [pushifyResult, webPushResult] = await Promise.all([
    sendViaPushify(notification),
    sendViaWebPush(notification),
  ])

  const totalSent = pushifyResult.sent + webPushResult.sent
  const errors = [pushifyResult.error, webPushResult.error].filter(Boolean)

  return {
    success: totalSent > 0,
    sent: totalSent,
    error: errors.length > 0 ? errors.join('; ') : undefined,
  }
}

// ---------- Pushify ----------

async function sendViaPushify(
  notification: NotificationData,
): Promise<{ success: boolean; sent: number; error?: string }> {
  const subscribers = await getPushifySubscribers()

  if (subscribers.length === 0) {
    return { success: false, sent: 0, error: 'No Pushify subscribers' }
  }

  let sentCount = 0
  for (const subscriber of subscribers) {
    const formData = new FormData()
    formData.append('name', notification.title.slice(0, 50))
    formData.append('website_id', PUSHIFY_WEBSITE_ID)
    formData.append('subscriber_id', String(subscriber.id))
    formData.append('title', notification.title)
    formData.append('description', notification.description)
    formData.append('url', notification.url)
    formData.append('send', 'true')

    try {
      const res = await fetch(`${PUSHIFY_BASE_URL}/personal-notifications`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${PUSHIFY_API_KEY}`,
          'User-Agent': 'NeutralWire/1.0',
        },
        body: formData,
        cache: 'no-store',
      })
      if (res.ok) sentCount++
    } catch {
      // continue
    }
  }

  return { success: sentCount > 0, sent: sentCount }
}

/**
 * Send a personalized push notification to each device based on their
 * interests + engagement stats.
 *
 * For each device:
 *   1. Read devices/<deviceId>/interests (array of sector IDs)
 *   2. Read devices/<deviceId>/engagement (per-sector scores 0..100)
 *   3. Read devices/<deviceId>/sentHistory (map of topicId → timestamp)
 *   4. Filter candidates to EXCLUDE any topicId in:
 *        - globalHistory (stories sent to ANY user before)
 *        - device.sentHistory (stories sent to THIS user before)
 *   5. Pick the best story from the remaining candidates
 *   6. Send a personalized web-push notification
 *   7. Record the chosen topicId in device.sentHistory
 *
 * Falls back to fallbackStory ONLY if no candidates remain after filtering.
 *
 * Returns:
 *   - sent: total notifications delivered
 *   - personalized: count of devices that got a personalized pick
 *   - fallback: count of devices that got the fallback story
 *   - sentTopicIds: SET of all topicIds actually sent (for global history)
 */
export async function sendPersonalizedWebPush(
  candidates: Array<{
    topicId: string
    title: string
    summary?: string
    coverage: number
    imageUrl?: string | null
    sectors: string[]
  }>,
  fallbackStory: {
    topicId: string
    title: string
    summary?: string
    imageUrl?: string | null
  },
  origin: string,
  slot: string,
  globalHistory: Set<string> = new Set(),
  dryRun: boolean = false,
): Promise<{
  sent: number
  personalized: number
  fallback: number
  sentTopicIds: Set<string>
}> {
  const allDevices = await firebaseRead<
    Record<
      string,
      DeviceRecord & {
        interests?: string[]
        engagement?: Record<
          string,
          { score: number; clicks: number; lastUpdate: number }
        >
        sentHistory?: Record<string, number>
      }
    >
  >('devices')
  if (!allDevices) return { sent: 0, personalized: 0, fallback: 0, sentTopicIds: new Set() }

  const iconUrl = `${origin}/icon-192.png`
  const badgeUrl = `${origin}/icon-192.png`
  const todayKey = new Date().toISOString().slice(0, 10)

  let sentCount = 0
  let personalizedCount = 0
  let fallbackCount = 0
  const sentTopicIds = new Set<string>()
  const deviceHistoryUpdates: Array<{ deviceId: string; topicId: string }> = []
  const sendPromises: Promise<void>[] = []

  for (const [deviceId, device] of Object.entries(allDevices)) {
    if (!device.pushSubscription || !device.notificationsEnabled) continue

    // Per-device sent history (defense in depth — even if a story somehow
    // slips past the global filter, this user never sees it twice).
    const deviceHistory = new Set(Object.keys(device.sentHistory || {}))

    // Filter candidates: exclude anything in global OR device history.
    // This is the "absolutely never twice" guarantee.
    const availableCandidates = candidates.filter(
      (c) => !globalHistory.has(c.topicId) && !deviceHistory.has(c.topicId),
    )

    // Pick the best story for this device
    let bestStory: { topicId: string; title: string; summary?: string; imageUrl?: string | null } | null = null
    let bestScore = -1
    let usedPersonalization = false

    const interests = device.interests || []
    const engagement = device.engagement || {}

    if (interests.length > 0 || Object.keys(engagement).length > 0) {
      for (const c of availableCandidates) {
        let score = c.coverage // base
        for (const sector of c.sectors) {
          if (interests.includes(sector)) score += 5
          score += (engagement[sector]?.score || 0) * 0.05
        }
        if (score > bestScore) {
          bestScore = score
          bestStory = {
            topicId: c.topicId,
            title: c.title,
            summary: c.summary,
            imageUrl: c.imageUrl,
          }
          usedPersonalization = true
        }
      }
    }

    // If no personalized match, try any available candidate (sorted by coverage)
    if (!bestStory && availableCandidates.length > 0) {
      const fallbackPick = availableCandidates
        .slice()
        .sort((a, b) => b.coverage - a.coverage)[0]
      bestStory = {
        topicId: fallbackPick.topicId,
        title: fallbackPick.title,
        summary: fallbackPick.summary,
        imageUrl: fallbackPick.imageUrl,
      }
    }

    // Last resort: use the provided fallbackStory (only if it's not already
    // in either history — otherwise skip this device entirely)
    if (!bestStory) {
      if (globalHistory.has(fallbackStory.topicId) || deviceHistory.has(fallbackStory.topicId)) {
        // Skip — don't send a duplicate
        continue
      }
      bestStory = fallbackStory
    }

    if (usedPersonalization) personalizedCount++
    else fallbackCount++

    // Record this topicId as sent (for both per-device and global history)
    sentTopicIds.add(bestStory.topicId)
    deviceHistoryUpdates.push({ deviceId, topicId: bestStory.topicId })

    const imageUrl = bestStory.imageUrl
      ? `${origin}/api/img?url=${encodeURIComponent(bestStory.imageUrl)}`
      : `${origin}/icon-512.png`

    // Truncate title for notification body
    let description = bestStory.title
    if (description.length > 100) {
      const truncated = description.slice(0, 100)
      const lastSpace = truncated.lastIndexOf(' ')
      description = truncated.slice(0, lastSpace > 60 ? lastSpace : 100)
    }

    const slotTitles: Record<string, string> = {
      morning: 'Morning Briefing',
      lunch: 'Lunch Briefing',
      evening: 'Evening Briefing',
    }

    const notifId = `notif_${todayKey}_${slot}_${deviceId.slice(-6)}`
    const payload = JSON.stringify({
      title: slotTitles[slot] || 'News Update',
      body: description,
      url: `${origin}/?topic=${bestStory.topicId}`,
      icon: iconUrl,
      badge: badgeUrl,
      image: imageUrl,
      notifId,
      tag: `neutralwire-${slot}`, // tag per slot so morning/lunch/evening don't overwrite
    })

    if (dryRun) {
      // In dry-run mode, count the "send" as successful but don't actually
      // call web-push. This lets us test the full personalization flow
      // without spamming real devices.
      sentCount++
    } else {
      sendPromises.push(
        webpush
          .sendNotification(
            device.pushSubscription as webpush.PushSubscription,
            payload,
            {
              TTL: 3600,
              urgency: 'high',
              topic: `neutralwire-${slot}`,
            },
          )
          .then(() => sentCount++)
          .catch(() => {}),
      )
    }
  }

  if (!dryRun) {
    await Promise.allSettled(sendPromises)
  }

  // ── Persist per-device sent history ──
  // Each device gets the newly-sent topicId added to its sentHistory map.
  // This is a defense-in-depth layer on top of the global history — even
  // if a story somehow slips past the global filter, this user still
  // never sees it twice.
  // Skip in dry-run mode.
  if (!dryRun) {
    let historyWritten = 0
    for (const { deviceId, topicId } of deviceHistoryUpdates) {
      try {
        const ok = await firebasePatch(`devices/${deviceId}/sentHistory`, {
          [topicId]: Date.now(),
        })
        if (ok) historyWritten++
      } catch {
        // silent — best-effort
      }
    }
    console.log(`[pushify] sentHistory written: ${historyWritten}/${deviceHistoryUpdates.length}`)
  } else {
    console.log(`[pushify] DRY RUN — would have sent ${sentCount} notifications, ${deviceHistoryUpdates.length} sentHistory updates`)
  }

  return {
    sent: sentCount,
    personalized: personalizedCount,
    fallback: fallbackCount,
    sentTopicIds,
  }
}

// ---------- Web-push fallback ----------

interface DeviceRecord {
  pushSubscription?: {
    endpoint: string
    keys: { p256dh: string; auth: string }
  }
  pushIsStandalone?: boolean
  notificationsEnabled?: boolean
}

async function sendViaWebPush(
  notification: NotificationData,
): Promise<{ success: boolean; sent: number; error?: string }> {
  const allDevices = await firebaseRead<Record<string, DeviceRecord>>('devices')
  if (!allDevices) return { success: false, sent: 0 }

  // Build absolute icon URLs (iOS requires full URLs, not relative paths).
  const origin = notification.origin || 'https://neutralwire.vercel.app'
  const iconUrl = `${origin}/icon-192.png`
  const badgeUrl = `${origin}/icon-192.png`

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.description,
    url: notification.url,
    icon: iconUrl, // Full URL — shows the NW logo in the notification header
    badge: badgeUrl, // Full URL — shows the NW logo in the status bar
    image: notification.image,
    notifId: notification.notifId,
    tag: 'neutralwire-news',
  })

  let sentCount = 0
  const sendPromises: Promise<void>[] = []

  for (const [, device] of Object.entries(allDevices)) {
    if (!device.pushSubscription || !device.notificationsEnabled) continue

    sendPromises.push(
      webpush
        .sendNotification(
          device.pushSubscription as webpush.PushSubscription,
          payload,
          {
            TTL: 3600,
            urgency: 'high',
            topic: 'neutralwire-news',
          },
        )
        .then(() => sentCount++)
        .catch(() => {}),
    )
  }

  await Promise.allSettled(sendPromises)
  return { success: sentCount > 0, sent: sentCount }
}

// ---------- Pushify API helpers ----------

export async function getPushifySubscribers(): Promise<
  Array<{ id: number; subscriber_id: string }>
> {
  try {
    const res = await fetch(`${PUSHIFY_BASE_URL}/subscribers`, {
      headers: {
        Authorization: `Bearer ${PUSHIFY_API_KEY}`,
        Accept: 'application/json',
        'User-Agent': 'NeutralWire/1.0',
      },
      cache: 'no-store',
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data.data || []).map((s: { id: number }) => ({
      id: s.id,
      subscriber_id: String(s.id),
    }))
  } catch {
    return []
  }
}

export async function getPushifySubscriberCount(): Promise<number> {
  try {
    const res = await fetch(`${PUSHIFY_BASE_URL}/subscribers`, {
      headers: {
        Authorization: `Bearer ${PUSHIFY_API_KEY}`,
        Accept: 'application/json',
        'User-Agent': 'NeutralWire/1.0',
      },
      cache: 'no-store',
    })
    if (!res.ok) return 0
    const data = await res.json()
    return data.meta?.total_results || data.data?.length || 0
  } catch {
    return 0
  }
}

export async function getPushifyWebsites(): Promise<
  Array<{ id: string; domain: string; pixel_key: string }>
> {
  try {
    const res = await fetch(`${PUSHIFY_BASE_URL}/websites`, {
      headers: {
        Authorization: `Bearer ${PUSHIFY_API_KEY}`,
        Accept: 'application/json',
        'User-Agent': 'NeutralWire/1.0',
      },
      cache: 'no-store',
    })
    if (!res.ok) return []
    const data = await res.json()
    return data.data || []
  } catch {
    return []
  }
}
