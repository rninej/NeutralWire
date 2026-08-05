import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
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
// Each window is 90 minutes wide so a 30-min cron catches every user.
const SLOT_WINDOWS = {
  morning: { startHour: 7, startMinute: 0, endHour: 8, endMinute: 30 },
  lunch: { startHour: 12, startMinute: 0, endHour: 13, endMinute: 30 },
  evening: { startHour: 19, startMinute: 0, endHour: 20, endMinute: 30 },
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

  // Run the dispatch in the background so we return 200 immediately.
  after(async () => {
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
        return
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

      for (const [deviceId, device] of Object.entries(devices)) {
        // Skip devices without a push subscription
        if (!device?.pushSubscription?.endpoint) continue
        // Skip browser tabs (only PWA gets notifications)
        if (device.pushIsStandalone === false) continue

        // Skip devices with no timezone (can't determine local time)
        if (!device.timezone) {
          continue
        }

        // Check if it's time for a briefing in this device's timezone
        const slotInfo = getSlotForLocalTime(device.timezone)
        if (!slotInfo) continue

        const { slot, dateKey } = slotInfo

        // ── NEVER TWICE: check if this slot was already sent today ──
        // sentSlotsToday is { morning: '2026-08-05', lunch: '2026-08-05', ... }
        // If the stored dateKey matches today's dateKey, skip.
        const lastSentDate = device.sentSlotsToday?.[slot]
        if (lastSentDate === dateKey) {
          // Already sent this slot today (in the user's local timezone)
          continue
        }

        toNotify.push({
          deviceId,
          slot,
          dateKey,
          subscription: device.pushSubscription,
          interests: device.interests || [],
          engagement: device.engagement || {},
        })
      }

      console.log(`[trigger-tz] ${toNotify.length} device(s) to notify (out of ${Object.keys(devices).length} total)`)

      if (toNotify.length === 0) {
        console.log('[trigger-tz] No devices need notifications right now')
        return
      }

      // ── 3. Fetch stories for the notification content ──
      // Fetch from multiple categories so we have a good candidate pool.
      let allStories: TopicArticle[] = []
      try {
        const categories = ['mycountry', 'relevant', 'world', 'technology', 'business', 'science']
        const results = await Promise.allSettled(
          categories.map(async (cat) => {
            const newsRes = await fetch(
              `${PRODUCTION_ORIGIN}/api/news?category=${cat}&country=GB&limit=5&minCoverage=1`,
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
      const candidates = allStories.filter((s) => {
        if (seenIds.has(s.topicId)) return false
        seenIds.add(s.topicId)
        return true
      })

      if (candidates.length === 0) {
        console.log('[trigger-tz] No stories available — skipping all sends')
        return
      }

      // ── 4. Load global sent-history (never send the same story twice) ──
      const globalHistory = await firebaseRead<Record<string, number>>('notification-sent-history') || {}
      const sentSet = new Set(Object.keys(globalHistory))

      // Filter out already-sent stories
      const freshStories = candidates.filter((s) => !sentSet.has(s.topicId))

      if (freshStories.length === 0) {
        console.log('[trigger-tz] All stories already sent — skipping')
        return
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
        morning: '📰 Morning Briefing',
        lunch: '🍴 Lunch Briefing',
        evening: '🌙 Evening Briefing',
      }

      let sentCount = 0
      let failedCount = 0

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

          // Ensure VAPID is configured before sending (deferred from module load)
          ensureVapid()
          if (!VAPID_PRIVATE_KEY) {
            console.warn('[trigger-tz] VAPID_PRIVATE_KEY not set — skipping actual send (dev mode)')
            continue
          }

          await webpush.sendNotification(
            target.subscription as webpush.PushSubscription,
            payload,
          )
          sentCount++

          // Mark this slot as sent for today (in the user's local timezone)
          await firebaseWrite(
            `devices/${target.deviceId}/sentSlotsToday/${target.slot}`,
            target.dateKey,
          )

          // Small delay between sends to avoid burst
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

      console.log(`[trigger-tz] Complete: ${sentCount} sent, ${failedCount} failed, ${toNotify.length - sentCount - failedCount} skipped (dry=${dryRun}) in ${Date.now() - t0}ms`)
    } catch (err) {
      console.error('[trigger-tz] FATAL:', err)
    }
  })

  return NextResponse.json({
    ok: true,
    message: 'Timezone-aware trigger dispatched in background',
    dryRun,
    ts: Date.now(),
  })
}
