import { NextRequest, NextResponse } from 'next/server'
import webpush from 'web-push'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } from '@/lib/vapid'
import type { TopicArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 55

// VAPID setup is deferred to inside the handler (not at module load) so
// the route doesn't crash when VAPID_PRIVATE_KEY isn't set (dev env).
// Production has it set as an env var.
let vapidConfigured = false
function ensureVapid() {
  if (vapidConfigured) return
  if (VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
  }
  vapidConfigured = true
}

const PRODUCTION_ORIGIN =
  process.env.NEXT_PUBLIC_SITE_URL || 'https://neutralwire.org'

// Hardcoded secret (same approach as the cron refresh endpoint).
const TRIGGER_TZ_SECRET = 'nw-tz-trigger-9f3a7c2e1b8d4f6a'

/**
 * TIMEZONE-AWARE NOTIFICATION TRIGGER
 *
 * Called by cron-job.org every 30 minutes. For EACH subscribed device,
 * checks the device's local time and sends the appropriate briefing:
 *
 *   - Morning briefing:  7:00–8:30 AM local time
 *   - Lunch briefing:   12:00–1:30 PM local time
 *   - Evening briefing:  7:00–8:30 PM local time
 *
 * If a device's local time falls in one of these windows AND they haven't
 * already received that slot TODAY (in their local timezone), send the
 * notification. Otherwise skip.
 *
 * This means:
 *   - A user in India (UTC+5:30) gets their morning briefing at 7-8:30 AM IST
 *   - A user in the UK (UTC+0/1) gets theirs at 7-8:30 AM GMT/BST
 *   - A user in the US (UTC-5 to -8) gets theirs at 7-8:30 AM their local time
 *
 * The endpoint returns 200 immediately and runs the per-device dispatch in
 * the background (via after()). This keeps cron-job.org's 30s timeout happy.
 *
 * ── DRY RUN MODE ──
 *   ?dry=1 — runs the full logic (computes who would get notified) but
 *   does NOT send any pushes or record anything. Use this for testing.
 *
 * Usage:
 *   GET /api/push/trigger-tz?secret=nw-tz-trigger-9f3a7c2e1b8d4f6a
 *   GET /api/push/trigger-tz?secret=nw-tz-trigger-9f3a7c2e1b8d4f6a&dry=1
 */

// ── Time windows for each slot (in LOCAL hour:minute) ──
// Each window is 2 hours wide so a 30-min cron catches every user
// even if their timezone is slightly off or they're traveling.
// Windows are centered on typical briefing times:
//   Morning:  6:30–8:30 AM (people wake up, check phone)
//   Lunch:   11:30–1:30 PM (lunch break)
//   Evening:  6:30–8:30 PM (after dinner, wind down)
const SLOT_WINDOWS = {
  morning: { startHour: 6, startMinute: 30, endHour: 8, endMinute: 30 },
  lunch: { startHour: 11, startMinute: 30, endHour: 13, endMinute: 30 },
  evening: { startHour: 18, startMinute: 30, endHour: 20, endMinute: 30 },
} as const

type Slot = keyof typeof SLOT_WINDOWS

/**
 * Get the user's current local hour and minute in their timezone.
 * Returns null if the timezone is invalid or unknown.
 */
function getLocalTime(timezone: string): { hour: number; minute: number; dateKey: string } | null {
  if (!timezone) return null
  try {
    const now = new Date()
    // Format: "2026-08-05T07:30:00" in the user's timezone
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    const parts = formatter.formatToParts(now)
    const get = (type: string) => parts.find((p) => p.type === type)?.value || ''
    const year = get('year')
    const month = get('month')
    const day = get('day')
    const hour = parseInt(get('hour'), 10)
    const minute = parseInt(get('minute'), 10)
    if (isNaN(hour) || isNaN(minute)) return null
    // dateKey = YYYY-MM-DD in the user's local timezone
    const dateKey = `${year}-${month}-${day}`
    return { hour, minute, dateKey }
  } catch {
    // Invalid timezone
    return null
  }
}

/**
 * Check if the current local time falls within a slot's window.
 */
function isInSlotWindow(hour: number, minute: number, slot: Slot): boolean {
  const win = SLOT_WINDOWS[slot]
  const currentMin = hour * 60 + minute
  const startMin = win.startHour * 60 + win.startMinute
  const endMin = win.endHour * 60 + win.endMinute
  return currentMin >= startMin && currentMin <= endMin
}

/**
 * Determine which slot (if any) a device should receive right now,
 * based on their local time.
 */
function getSlotForLocalTime(timezone: string): { slot: Slot; dateKey: string } | null {
  const local = getLocalTime(timezone)
  if (!local) return null
  for (const slot of Object.keys(SLOT_WINDOWS) as Slot[]) {
    if (isInSlotWindow(local.hour, local.minute, slot)) {
      return { slot, dateKey: local.dateKey }
    }
  }
  return null
}

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  const secret = req.nextUrl.searchParams.get('secret') || ''
  const dryRun = req.nextUrl.searchParams.get('dry') === '1'

  if (secret !== TRIGGER_TZ_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── Run the dispatch SYNCHRONOUSLY (not in after()) ──
  // Previously this ran in after() (background callback), but Vercel
  // Hobby kills the process shortly after the response is sent, so
  // the background work never completed. Running synchronously means
  // the HTTP request takes a few seconds, but cron-job.org has a 30s
  // timeout which is plenty.
  console.log(`[trigger-tz] Starting at ${new Date().toISOString()} (dry=${dryRun})`)

  try {
    // ── 1. Load ALL subscribed devices ──
    const devices = await firebaseRead<Record<string, {
      pushSubscription?: {
        endpoint: string
        keys: { p256dh: string; auth: string }
      }
      pushIsStandalone?: boolean
      timezone?: string
      interests?: string[]
      engagement?: Record<string, { score: number; clicks: number }>
      sentSlotsToday?: Record<string, string> // slot → dateKey (when last sent)
    }>>('devices')

    if (!devices) {
      console.log('[trigger-tz] No devices found')
      return NextResponse.json({ ok: true, message: 'No devices found', sent: 0, ts: Date.now() })
    }

    // ── 2. For each device, check if it's time for a briefing ──
    const toNotify: Array<{
      deviceId: string
      slot: Slot
      dateKey: string
      subscription: { endpoint: string; keys: { p256dh: string; auth: string } }
      interests: string[]
      engagement: Record<string, { score: number; clicks: number }>
    }> = []

    let totalDevices = 0
    let skipNoSub = 0
    let skipNotStandalone = 0
    let skipNoTimezone = 0
    let skipNotInWindow = 0
    let skipAlreadySent = 0

    for (const [deviceId, device] of Object.entries(devices)) {
      totalDevices++
      // Skip devices without a push subscription
      if (!device?.pushSubscription?.endpoint) { skipNoSub++; continue }
      // Skip browser tabs (only PWA gets notifications)
      if (device.pushIsStandalone === false) { skipNotStandalone++; continue }

      // ── Timezone handling ──
      // Devices with OLDER PWA installs (before timezone tracking was added)
      // don't have a timezone stored. Instead of skipping them (which would
      // mean they NEVER get notifications), fall back to UTC. This ensures
      // ALL subscribed devices get notifications — the timezone is an
      // optimization for correct local-time delivery, not a requirement.
      const deviceTimezone = device.timezone || 'UTC'
      if (!device.timezone) {
        // Log for diagnostics but DON'T skip
        skipNoTimezone++ // counts how many are falling back to UTC
      }

      // Check if it's time for a briefing in this device's timezone
      const slotInfo = getSlotForLocalTime(deviceTimezone)
      if (!slotInfo) { skipNotInWindow++; continue }

      const { slot, dateKey } = slotInfo

      // ── NEVER TWICE: check if this slot was already sent today ──
      const lastSentDate = device.sentSlotsToday?.[slot]
      if (lastSentDate === dateKey) { skipAlreadySent++; continue }

      toNotify.push({
        deviceId,
        slot,
        dateKey,
        subscription: device.pushSubscription,
        interests: device.interests || [],
        engagement: device.engagement || {},
      })
    }

    console.log(`[trigger-tz] ${toNotify.length} device(s) to notify (out of ${totalDevices} total. noSub=${skipNoSub} notStandalone=${skipNotStandalone} noTz(fallbackUTC)=${skipNoTimezone} notInWindow=${skipNotInWindow} alreadySent=${skipAlreadySent})`)

    if (toNotify.length === 0) {
      console.log('[trigger-tz] No devices need notifications right now')
      return NextResponse.json({
        ok: true,
        message: 'No devices need notifications',
        sent: 0,
        totalDevices,
        skipBreakdown: { skipNoSub, skipNotStandalone, skipNoTimezone, skipNotInWindow, skipAlreadySent },
        ts: Date.now(),
      })
    }

    // ── 3. Fetch stories for the notification content ──
    // Use the MOST COMMON country among devices to notify, so the stories
    // are relevant to the majority. Fall back to GB.
    // Also fetch with each target device's country for personalization.
    let allStories: TopicArticle[] = []
    try {
      // Determine the dominant country from devices to notify
      const countryCounts: Record<string, number> = {}
      for (const target of toNotify) {
        // Read the device's country from the devices record
        const dev = devices[target.deviceId]
        // Check for country code in the device data
        const cc = (dev as Record<string, unknown>)?.countryCode as string ||
                   (dev as Record<string, unknown>)?.country as string || 'GB'
        countryCounts[cc] = (countryCounts[cc] || 0) + 1
      }
      const dominantCountry = Object.entries(countryCounts)
        .sort((a, b) => b[1] - a[1])[0]?.[0] || 'GB'

      const categories = ['mycountry', 'relevant', 'world', 'technology', 'business', 'science']
      const results = await Promise.allSettled(
        categories.map(async (cat) => {
          const newsRes = await fetch(
            `${PRODUCTION_ORIGIN}/api/news?category=${cat}&country=${dominantCountry}&limit=5&minCoverage=1`,
            { cache: 'no-store' },
          )
          if (newsRes.ok) {
            const newsData = await newsRes.json()
            return newsData.topics || []
          }
          return []
        }),
      )
      for (const result of results) {
        if (result.status === 'fulfilled') {
          allStories.push(...result.value)
        }
      }
    } catch {
      // continue without stories
    }

    // Dedup by topicId
    const seenIds = new Set<string>()
    let candidates = allStories.filter((s) => {
      if (seenIds.has(s.topicId)) return false
      seenIds.add(s.topicId)
      return true
    })

    // ── Filter out US domestic politics / Trump news ──
    // These are not relevant to non-US users and cause complaints.
    const usPoliticsPatterns = [
      'trump', 'biden', 'harris', 'gop', 'republican', 'democrat',
      'us congress', 'us senate', 'us house', 'scotus', 'us supreme court',
      'white house', 'capitol', 'pentagon', 'senator', 'congressman',
      'us poll', 'us election', 'us primary', 'us governor',
      'rand paul', 'fauci', 'senate hearing', 'house hearing',
    ]
    candidates = candidates.filter((s) => {
      const titleLower = s.title.toLowerCase()
      for (const pattern of usPoliticsPatterns) {
        if (titleLower.includes(pattern)) return false
      }
      return true
    })

    if (candidates.length === 0) {
      console.log('[trigger-tz] No stories available (after US filter) — skipping all sends')
      return NextResponse.json({ ok: true, message: 'No stories available after filtering', sent: 0, toNotify: toNotify.length, ts: Date.now() })
    }

    // ── 4. Load global sent-history (never send the same story twice) ──
    const globalHistory = await firebaseRead<Record<string, number>>('notification-sent-history') || {}
    const sentSet = new Set(Object.keys(globalHistory))

    // Filter out already-sent stories
    const freshStories = candidates.filter((s) => !sentSet.has(s.topicId))

    if (freshStories.length === 0) {
      console.log('[trigger-tz] All stories already sent — skipping')
      return NextResponse.json({ ok: true, message: 'All stories already sent', sent: 0, toNotify: toNotify.length, ts: Date.now() })
    }

    // Pick the best story (highest coverage, freshest)
    const bestStory = freshStories.sort((a, b) => {
      if (b.coverage !== a.coverage) return b.coverage - a.coverage
      return b.latestSeen - a.latestSeen
    })[0]

    console.log(`[trigger-tz] Best story: "${bestStory.title.slice(0, 60)}" (${bestStory.coverage} sources)`)

    // ── 5. Send one push per device ──
    const origin = PRODUCTION_ORIGIN
    const imageUrl = bestStory.imageUrl
      ? `${origin}/api/img?url=${encodeURIComponent(bestStory.imageUrl)}`
      : `${origin}/icon-512.png`

    const slotLabels: Record<Slot, string> = {
      morning: 'Morning Briefing',
      lunch: 'Lunch Briefing',
      evening: 'Evening Briefing',
    }

    let sentCount = 0
    let failedCount = 0

    // Ensure VAPID is configured
    ensureVapid()

    for (const target of toNotify) {
      if (dryRun) {
        console.log(`[trigger-tz] DRY RUN: would send ${target.slot} to device ${target.deviceId.slice(0, 8)} (tz: ${devices[target.deviceId]?.timezone})`)
        continue
      }

      try {
        const payload = JSON.stringify({
          title: slotLabels[target.slot],
          body: bestStory.title.slice(0, 100),
          url: `/?topic=${bestStory.topicId}`,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          image: imageUrl,
          tag: `briefing-${target.slot}`,
          notifId: `tz_${target.dateKey}_${target.slot}_${target.deviceId.slice(-6)}`,
        })

        if (!VAPID_PRIVATE_KEY) {
          console.warn('[trigger-tz] VAPID_PRIVATE_KEY not set — cannot send pushes')
          break
        }

        await webpush.sendNotification(
          target.subscription as webpush.PushSubscription,
          payload,
        )
        sentCount++

        // Mark this slot as sent for today
        await firebaseWrite(
          `devices/${target.deviceId}/sentSlotsToday/${target.slot}`,
          target.dateKey,
        )

        // Small delay between sends
        await new Promise((r) => setTimeout(r, 100))
      } catch (err) {
        failedCount++
        console.warn(`[trigger-tz] Failed to send to device ${target.deviceId.slice(0, 8)}:`, err instanceof Error ? err.message : err)
      }
    }

    // ── 6. Record the sent story in global history ──
    if (!dryRun && sentCount > 0) {
      await firebaseWrite(
        `notification-sent-history/${bestStory.topicId}`,
        Date.now(),
      ).catch(() => {})

      // Archive the topic so the notification link works forever
      await firebaseWrite(`archive/${bestStory.topicId}`, {
        ...bestStory,
        archivedAt: Date.now(),
      }).catch(() => {})
    }

    console.log(`[trigger-tz] Complete: ${sentCount} sent, ${failedCount} failed in ${Date.now() - t0}ms`)

    return NextResponse.json({
      ok: true,
      message: 'Notifications dispatched',
      sent: sentCount,
      failed: failedCount,
      toNotify: toNotify.length,
      totalDevices,
      skipBreakdown: { skipNoSub, skipNotStandalone, skipNoTimezone, skipNotInWindow, skipAlreadySent },
      bestStory: bestStory.title.slice(0, 80),
      dryRun,
      ms: Date.now() - t0,
      ts: Date.now(),
    })
  } catch (err) {
    console.error('[trigger-tz] FATAL:', err)
    return NextResponse.json(
      { error: 'Internal error', detail: err instanceof Error ? err.message : String(err), ts: Date.now() },
      { status: 500 },
    )
  }
}
