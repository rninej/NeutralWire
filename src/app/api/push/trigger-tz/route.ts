import { NextRequest, NextResponse } from 'next/server'
import webpush from 'web-push'
import { firebaseDelete, firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import { readCachedNews, isVirtualCategory } from '@/lib/news-cache'
import { consumeLease, jobRecentlyRan, markJobRun, CRON_JOB_INTERVALS } from '@/lib/mesh/lease-server'
import { buildBriefingPayload } from '@/lib/push/briefing-payload'
import {
  titleSignature,
  isNearDuplicateSignature,
  dropNearDuplicateTopics,
} from '@/lib/push/story-dedup'
import { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } from '@/lib/vapid'
import type { TopicArticle } from '@/lib/news-aggregator'
import type { Category } from '@/lib/news-sources'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 55

// VAPID setup deferred to handler (not module load) to avoid crashes in dev.
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

const TRIGGER_TZ_SECRET = 'nw-tz-trigger-9f3a7c2e1b8d4f6a'

// ── Briefing targets (LOCAL time) ──
// The user wants notifications at EXACTLY:
//   Morning: 8:00 AM
//   Lunch: 1:00 PM (13:00)
//   Evening: 8:00 PM (20:00)
//
// The cron runs every 30 minutes. We use a ±15 minute window around each
// target (7:45-8:15, 12:45-13:15, 19:45-20:15) so the cron catches the
// target time on one of its 30-minute passes.
//
// This is EXACT — no DST issues because we use Intl.DateTimeFormat with
// the device's IANA timezone (e.g. "Asia/Kolkata", "Europe/London").
// The IANA timezone database automatically handles DST transitions.
const SLOT_TARGETS = {
  morning: { hour: 8, minute: 0 },
  lunch: { hour: 13, minute: 0 },
  evening: { hour: 20, minute: 0 },
} as const

// ±15 minute window around each target
const SLOT_WINDOW_MINUTES = 15

type Slot = keyof typeof SLOT_TARGETS

// Max age for global sent-history entries (14 days). Entries older than
// this are pruned so the history doesn't grow forever and block all
// future stories.
const HISTORY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Semantic story dedup lives in src/lib/push/story-dedup.ts (stemmed
 * keyword-set similarity + entity-overlap rules). It replaces the old
 * local storyFingerprint(): the EXACT-match sorted-keyword fingerprint
 * could not catch "same event, slightly different words" — the Sep-2026
 * OpenAI/Australia incident sent the SAME NEWS twice in one day because
 * the re-headlined twin produced a different keyword set and a new
 * topicId. The shared module now guards (1) the candidate pool, (2) the
 * freshness filter vs sent-history, and (3) the within-run picks.
 */

// Near-duplicate matching against sent-history is aggressive only inside
// this window: a re-headlined twin within 3 days is the SAME news for the
// user (the OpenAI/Australia complaint), while a story that re-emerges
// after 3 days can be a genuine new development of the running saga.
const NEAR_DUP_WINDOW_MS = 72 * 60 * 60 * 1000

function getLocalTime(timezone: string): { hour: number; minute: number; dateKey: string } | null {
  if (!timezone) return null
  try {
    const now = new Date()
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
    const parts = formatter.formatToParts(now)
    const get = (type: string) => parts.find((p) => p.type === type)?.value || ''
    const hour = parseInt(get('hour'), 10)
    const minute = parseInt(get('minute'), 10)
    if (isNaN(hour) || isNaN(minute)) return null
    return { hour, minute, dateKey: `${get('year')}-${get('month')}-${get('day')}` }
  } catch {
    return null
  }
}

/**
 * Check if the current local time is within ±15 minutes of a slot target.
 *
 * Example: morning target is 8:00. Window is 7:45-8:15.
 * The cron runs every 30 min, so it will hit either 7:46, 8:01, or 8:16
 * (depending on offset). The ±15 window ensures we catch the target on
 * one of these passes.
 *
 * DST is handled automatically by Intl.DateTimeFormat with the IANA
 * timezone — the database knows when DST starts/ends for each timezone.
 */
function isInSlotWindow(hour: number, minute: number, slot: Slot): boolean {
  const target = SLOT_TARGETS[slot]
  const currentMin = hour * 60 + minute
  const targetMin = target.hour * 60 + target.minute
  return Math.abs(currentMin - targetMin) <= SLOT_WINDOW_MINUTES
}

function getSlotForLocalTime(timezone: string): { slot: Slot; dateKey: string } | null {
  const local = getLocalTime(timezone)
  if (!local) return null
  for (const slot of Object.keys(SLOT_TARGETS) as Slot[]) {
    if (isInSlotWindow(local.hour, local.minute, slot)) {
      return { slot, dateKey: local.dateKey }
    }
  }
  return null
}

// ── Sector keywords for per-device story personalization ──
const SECTOR_KEYWORDS: Record<string, string[]> = {
  politics: ['trump', 'biden', 'starmer', 'parliament', 'congress', 'senate', 'election', 'labour', 'conservative', 'government', 'minister', 'president', 'policy', 'cabinet', 'downing street', 'white house', 'supreme court', 'lawmaker', 'legislation'],
  world: ['ukraine', 'russia', 'putin', 'china', 'israel', 'gaza', 'hamas', 'iran', 'middle east', 'europe', 'nato', 'united nations', 'refugee', 'ceasefire', 'nuclear', 'war', 'conflict'],
  business: ['stock', 'market', 'economy', 'inflation', 'interest rate', 'federal reserve', 'gdp', 'recession', 'tariff', 'trade war', 'merger', 'earnings', 'ipo', 'oil price', 'wall street', 'banking', 'finance'],
  technology: ['ai ', 'artificial intelligence', 'openai', 'google', 'apple', 'microsoft', 'meta ', 'facebook', 'amazon', 'tesla', 'nvidia', 'chip', 'tiktok', 'elon musk', 'iphone', 'android', 'startup', 'crypto', 'bitcoin', 'cyber', 'hack'],
  science: ['nasa', 'spacex', 'rocket', 'mars', 'moon', 'space', 'astronaut', 'telescope', 'physics', 'chemistry', 'biology', 'genome', 'dna', 'researchers', 'scientists', 'discovery', 'breakthrough', 'climate', 'carbon', 'earthquake'],
  health: ['covid', 'pandemic', 'vaccine', 'hospital', 'nhs', 'fda', 'medicine', 'drug', 'pharma', 'cancer', 'disease', 'outbreak', 'virus', 'flu', 'mental health', 'diabetes', 'heart', 'stroke'],
  sports: ['premier league', 'champions league', 'world cup', 'nba', 'nfl', 'arsenal', 'chelsea', 'liverpool', 'cricket', 'rugby', 'golf', 'f1', 'boxing', 'ufc', 'olympics', 'football', 'tennis'],
}

function detectSectors(title: string): string[] {
  const text = title.toLowerCase()
  const matched = new Set<string>()
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    for (const kw of keywords) {
      if (text.includes(kw)) { matched.add(sector); break }
    }
  }
  return Array.from(matched)
}

/**
 * Score a story for a specific device based on their interests + engagement.
 * Higher score = more relevant to this user.
 */
function scoreStoryForDevice(
  story: TopicArticle,
  interests: string[],
  engagement: Record<string, { score: number; clicks: number }>,
): number {
  let score = story.coverage * 2 // base: more sources = more important
  const sectors = detectSectors(story.title)
  for (const sector of sectors) {
    if (interests.includes(sector)) score += 30 // user is interested
    const eng = engagement[sector]
    if (eng) {
      if (eng.score > 0) score += eng.score * 0.3 // positive engagement
      if (eng.score < 0) score -= Math.abs(eng.score) * 0.5 // negative engagement (disliked)
    }
  }
  // Recency boost: newer stories get a small bonus
  const ageHours = (Date.now() - story.latestSeen) / (60 * 60 * 1000)
  if (ageHours < 6) score += 10
  else if (ageHours < 24) score += 5
  return score
}

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  const secret = req.nextUrl.searchParams.get('secret') || ''
  const leaseId = req.nextUrl.searchParams.get('lease') || ''
  const peer = req.nextUrl.searchParams.get('peer') || ''
  const dryRun = req.nextUrl.searchParams.get('dry') === '1'
  const forceEvening = req.nextUrl.searchParams.get('forceEvening') === '1'
  const forceSlot = req.nextUrl.searchParams.get('forceSlot') as Slot | null

  // ── Auth: admin secret (external cron / debug) OR one-time mesh lease
  // (a visitor's browser driving the schedule — the userCron experiment).
  // Per-device sentSlotsToday + the global sent-history make double
  // triggering harmless (devices never get the same slot twice), and the
  // lease path additionally respects a 14-minute interval floor.
  let authorized = secret === TRIGGER_TZ_SECRET
  let viaLease = false
  if (!authorized && leaseId) {
    const lease = await consumeLease(leaseId, peer, 'notify')
    authorized = lease.ok
    viaLease = lease.ok
    if (!lease.ok) {
      console.warn(`[trigger-tz] lease rejected: ${lease.reason}`)
    }
  }
  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── Rogue-instance guard (the Sep 23 incident class) ──
  // This route writes REAL per-device "sent" marks to the production
  // database (the DB URL is compiled into firebase-server). A LOCAL
  // dev/standalone server reached by a browser (the user-cron mesh
  // triggers its OWN origin, and the DB is shared) would happily mark
  // every in-window device "sent" while its local/throwaway VAPID key
  // makes every actual push fail with 403 — silently cancelling that
  // timezone's briefings for the entire day. Refuse non-dry runs from
  // local origins unless explicitly overridden with ?allowLocal=1.
  const isLocalOrigin =
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.nextUrl.origin)
  if (isLocalOrigin && !dryRun && req.nextUrl.searchParams.get('allowLocal') !== '1') {
    return NextResponse.json(
      {
        ok: false,
        refused: 'local-origin',
        message:
          'Refusing to send pushes from a local instance: it would write real device marks to the production database while pushes fail with a local VAPID key (this silently cancels the day’s briefings for whole timezones). Use ?dry=1 for diagnostics or ?allowLocal=1 to deliberately override.',
        ts: Date.now(),
      },
      { status: 403 },
    )
  }

  if (viaLease && !dryRun && !forceSlot) {
    if (await jobRecentlyRan('notify', CRON_JOB_INTERVALS.notify.serverFloorMs)) {
      return NextResponse.json({
        ok: true,
        skipped: 'interval',
        message: 'Notification pass ran recently — floor respected',
        sent: 0,
        ts: Date.now(),
      })
    }
    await markJobRun('notify')
  }

  console.log(`[trigger-tz] Starting at ${new Date().toISOString()} (dry=${dryRun})`)

  try {
    // ── 1. Load ALL devices ──
    const devices = await firebaseRead<Record<string, {
      pushSubscription?: { endpoint: string; keys: { p256dh: string; auth: string } }
      pushIsStandalone?: boolean
      timezone?: string
      interests?: string[]
      engagement?: Record<string, { score: number; clicks: number }>
      sentSlotsToday?: Record<string, string>
      countryCode?: string
    }>>('devices')

    if (!devices) {
      return NextResponse.json({ ok: true, message: 'No devices found', sent: 0, ts: Date.now() })
    }

    // ── 2. Determine which devices need notifications ──
    const toNotify: Array<{
      deviceId: string
      slot: Slot
      dateKey: string
      subscription: { endpoint: string; keys: { p256dh: string; auth: string } }
      interests: string[]
      engagement: Record<string, { score: number; clicks: number }>
    }> = []

    let totalDevices = 0, skipNoSub = 0, skipNotStandalone = 0
    let skipNoTimezone = 0, skipNotInWindow = 0, skipAlreadySent = 0

    for (const [deviceId, device] of Object.entries(devices)) {
      totalDevices++
      if (!device?.pushSubscription?.endpoint) { skipNoSub++; continue }
      // Only skip EXPLICITLY false (not undefined — old PWA installs)
      if (device.pushIsStandalone === false) { skipNotStandalone++; continue }

      // Force mode: skip all checks
      if (forceEvening || forceSlot) {
        const forcedSlot: Slot = forceSlot || 'evening'
        const deviceTimezone = device.timezone || 'UTC'
        const localInfo = getLocalTime(deviceTimezone)
        const dateKey = (localInfo?.dateKey || new Date().toISOString().slice(0, 10)) + '-forced'
        toNotify.push({
          deviceId, slot: forcedSlot, dateKey,
          subscription: device.pushSubscription,
          interests: device.interests || [],
          engagement: device.engagement || {},
        })
        continue
      }

      // Normal mode: check timezone + time window
      const deviceTimezone = device.timezone || 'UTC'
      if (!device.timezone) skipNoTimezone++

      const slotInfo = getSlotForLocalTime(deviceTimezone)
      if (!slotInfo) { skipNotInWindow++; continue }

      const { slot, dateKey } = slotInfo

      // Never twice: check if already sent today
      const lastSentDate = device.sentSlotsToday?.[slot]
      if (lastSentDate === dateKey) { skipAlreadySent++; continue }

      toNotify.push({
        deviceId, slot, dateKey,
        subscription: device.pushSubscription,
        interests: device.interests || [],
        engagement: device.engagement || {},
      })
    }

    console.log(`[trigger-tz] ${toNotify.length} to notify (total=${totalDevices} noSub=${skipNoSub} notStandalone=${skipNotStandalone} noTz=${skipNoTimezone} notInWindow=${skipNotInWindow} alreadySent=${skipAlreadySent})`)

    // ── Notification Like-button flag ──
    // Read once per run (one Firebase read). notifLike=false → the payload
    // tells the SW to ship the notification WITHOUT the Like action button
    // (only "Not Interested"). Absent/true → the [Like | Not Interested]
    // pair. Flipping the flag in /debug applies to every notification sent
    // from the next cron run onward.
    let notifLike = true
    try {
      const storedFlag = await firebaseRead<boolean | string>('featureFlags/notifLike')
      if (storedFlag === false || storedFlag === 'false') notifLike = false
    } catch {
      // Firebase hiccup → default to ON (never break notification sending)
    }

    if (toNotify.length === 0) {
      return NextResponse.json({
        ok: true, message: 'No devices need notifications', sent: 0,
        totalDevices,
        skipBreakdown: { skipNoSub, skipNotStandalone, skipNoTimezone, skipNotInWindow, skipAlreadySent },
        ts: Date.now(),
      })
    }

    // ── 3. Fetch stories ──
    // Determine dominant country for story fetching
    const countryCounts: Record<string, number> = {}
    for (const target of toNotify) {
      const dev = devices[target.deviceId]
      const cc = dev?.countryCode || 'GB'
      countryCounts[cc] = (countryCounts[cc] || 0) + 1
    }
    const dominantCountry = Object.entries(countryCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'GB'

    // ── DIRECT Firebase reads (Fluid CPU optimization) ──
    // The old code self-fetched ${PRODUCTION_ORIGIN}/api/news for 7
    // categories — 7 extra serverless function invocations per cron run,
    // each paying a cold-start module load (plus a JSON HTTP round trip
    // through the CDN). We now read the SAME Firebase cache nodes that
    // /api/news serves from, in-process, and apply the EXACT same filter
    // /api/news applied (limit=5, minCoverage=1, offset=0, slim=false →
    // topics.filter(coverage >= 1).slice(0, 5)). The notification picks
    // identical stories; ~7 invocations per run are eliminated.
    //
    // Behaviour-preservation notes:
    //   - Stale caches: /api/news returns the stale payload immediately
    //     (and refreshes in the background for the NEXT run) — a direct
    //     read returns the same stale payload, so THIS run's picks are
    //     identical. Freshness is kept by /api/cron/refresh-all (every
    //     30 min) and visitor traffic, exactly as before.
    //   - Missing cache node (only on a truly first-ever run): fall back
    //     to the HTTP self-fetch for that category — /api/news aggregates
    //     synchronously on a missing cache, so even that edge case picks
    //     the same stories.
    let allStories: TopicArticle[] = []
    try {
      const categories: Category[] = [
        'mycountry', 'relevant', 'world', 'technology', 'business', 'science', 'top',
      ]
      const results = await Promise.allSettled(
        categories.map(async (cat) => {
          const country = isVirtualCategory(cat) ? dominantCountry : ''
          const cached = await readCachedNews(cat, country).catch(() => null)
          if (cached && Array.isArray(cached.topics)) {
            // EXACT replica of /api/news applyFilters(limit=5, minCoverage=1)
            return cached.topics.filter((t) => t.coverage >= 1).slice(0, 5)
          }
          // Cold-start fallback: no cache node at all — use the HTTP route
          // (it aggregates synchronously on a missing cache).
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
        if (result.status === 'fulfilled') allStories.push(...result.value)
      }
    } catch { /* continue */ }

    // Dedup
    const seenIds = new Set<string>()
    let candidates = allStories.filter((s) => {
      if (seenIds.has(s.topicId)) return false
      seenIds.add(s.topicId)
      return true
    })

    // ── US politics filter (non-US only) ──
    if (dominantCountry !== 'US') {
      const usPatterns = [
        'trump', 'biden', 'harris', 'obama', 'gop', 'republican', 'democrat',
        'us congress', 'us senate', 'us house', 'scotus', 'white house',
        'capitol', 'pentagon', 'senator', 'congressman', 'us poll', 'us election',
        'us primary', 'us governor', 'senate hearing', 'house hearing',
        'fbi', 'cia', 'doj', 'us border', 'us military', 'us troops',
      ]
      const before = candidates.length
      candidates = candidates.filter((s) => {
        const t = s.title.toLowerCase()
        return !usPatterns.some((p) => t.includes(p))
      })
      console.log(`[trigger-tz] US filter: ${before} → ${candidates.length}`)
    }

    if (candidates.length === 0) {
      return NextResponse.json({ ok: true, message: 'No stories after filter', sent: 0, toNotify: toNotify.length, ts: Date.now() })
    }

    // ── 3b. Near-duplicate drop INSIDE the candidate pool ──
    // The same event legitimately lives in several rooms (mycountry +
    // world + technology…). topicId-level dedup keeps both entries; the
    // stemmed-similarity pass keeps the FIRST (highest-priority room,
    // priority order: mycountry, relevant, world, technology, business,
    // science, top) and drops the re-headlined twins so the pool that the
    // per-device scoring sees contains ONE story per event.
    const beforeNearDupDrop = candidates.length
    candidates = dropNearDuplicateTopics(candidates)
    if (candidates.length !== beforeNearDupDrop) {
      console.log(`[trigger-tz] Near-dup candidate drop: ${beforeNearDupDrop} → ${candidates.length}`)
    }

    // ── 4. Load + prune global sent-history ──
    // The sent-history tracks BOTH topicIds AND semantic fingerprints.
    // topicIds catch exact duplicates (same story re-sent).
    // Fingerprints catch semantic duplicates (same event, different numbers
    // or wording — e.g. "139 killed" updated to "169 killed").
    const globalHistory = await firebaseRead<Record<string, number>>('notification-sent-history') || {}
    const now = Date.now()
    const sentSet = new Set<string>()
    const prunedHistory: Record<string, number> = {}
    let prunedCount = 0
    for (const [key, ts] of Object.entries(globalHistory)) {
      if (now - ts < HISTORY_MAX_AGE_MS) {
        sentSet.add(key)
        prunedHistory[key] = ts
      } else {
        prunedCount++
      }
    }
    // Write pruned history back (removes old entries so the node doesn't grow forever)
    if (prunedCount > 0 && !dryRun) {
      await firebaseWrite('notification-sent-history', prunedHistory).catch(() => {})
      console.log(`[trigger-tz] Pruned ${prunedCount} old entries from sent-history`)
    }

    // ── Filter fresh stories using topicId + signature + NEAR-DUPLICATE ──
    // A story is "fresh" when NONE of these hold:
    //   - its topicId is in sentSet (exact same story),
    //   - its stemmed signature exactly matches a sent signature,
    //   - it NEAR-DUPLICATES a signature sent in the last 72h (the
    //     "OpenAI hacked Australia" twice-in-a-day bug: re-headlined twin,
    //     different words, different topicId — the exact-match-only guard
    //     passed it straight through).
    const recentSigEntries: Array<{ sig: string; ts: number }> = []
    for (const [key, ts] of Object.entries(prunedHistory)) {
      if (key.includes(' ') && typeof ts === 'number' && now - ts <= NEAR_DUP_WINDOW_MS) {
        recentSigEntries.push({ sig: key, ts })
      }
    }
    let nearDupBlocked = 0
    const freshStories = candidates.filter((s) => {
      if (sentSet.has(s.topicId)) return false // exact duplicate
      const sig = titleSignature(s.title)
      if (sig && sentSet.has(sig)) return false // exact signature duplicate
      if (sig) {
        for (const e of recentSigEntries) {
          if (isNearDuplicateSignature(s.title, e.sig)) {
            nearDupBlocked++
            return false // semantic near-duplicate of recently-sent news
          }
        }
      }
      return true
    })

    if (freshStories.length === 0) {
      console.log('[trigger-tz] All stories already sent — skipping')
      return NextResponse.json({ ok: true, message: 'All stories already sent', sent: 0, toNotify: toNotify.length, nearDupBlocked, ts: Date.now() })
    }

    // ── 5. Send PERSONALIZED push per device ──
    // For each device, pick the BEST story based on their interests + engagement.
    // This ensures users get stories they're more likely to click.
    const origin = PRODUCTION_ORIGIN
    const slotLabels: Record<Slot, string> = {
      morning: 'Morning Briefing',
      lunch: 'Lunch Briefing',
      evening: 'Evening Briefing',
    }

    let sentCount = 0
    let failedCount = 0
    let firstError: string | null = null
    const allSentTopicIds = new Set<string>()
    const allSentSignatures: string[] = []
    // og-image URLs already pre-warmed at the CDN this run (keyed by URL:
    // the same story picked by several devices shares one composite URL).
    const prewarmedImages = new Set<string>()

    ensureVapid()

    if (!VAPID_PRIVATE_KEY) {
      console.warn('[trigger-tz] VAPID_PRIVATE_KEY not set — cannot send pushes')
      return NextResponse.json({ ok: true, message: 'VAPID not configured', sent: 0, ts: Date.now() })
    }

    for (const target of toNotify) {
      if (dryRun) {
        console.log(`[trigger-tz] DRY RUN: would send ${target.slot} to ${target.deviceId.slice(0, 8)}`)
        continue
      }

      try {
        // Race condition double-check
        const deviceNow = await firebaseRead<Record<string, string>>(
          `devices/${target.deviceId}/sentSlotsToday`
        )
        if (deviceNow?.[target.slot] === target.dateKey) {
          console.log(`[trigger-tz] Race: ${target.slot} already sent to ${target.deviceId.slice(0, 8)}`)
          continue
        }

        // Mark sent BEFORE push (prevents duplicates if function is killed)
        await firebaseWrite(
          `devices/${target.deviceId}/sentSlotsToday/${target.slot}`,
          target.dateKey,
        )

        // ── Pick the BEST story for THIS device ──
        // Score each fresh story based on the device's interests + engagement.
        // Stories already sent to OTHER devices in this run are deprioritized
        // (so different users get different stories when possible), INCLUDING
        // near-duplicate re-headlines of stories already picked in this run
        // (catches "139 killed" vs "169 killed" — same event, different
        // numbers — and the OpenAI/Australia same-event-different-words twin).
        const scored = freshStories.map((s) => {
          const sig = titleSignature(s.title)
          const alreadySentTopic = allSentTopicIds.has(s.topicId)
          let alreadySentNearDup = false
          if (sig) {
            for (const sent of allSentSignatures) {
              if (isNearDuplicateSignature(s.title, sent)) {
                alreadySentNearDup = true
                break
              }
            }
          }
          return {
            story: s,
            score: scoreStoryForDevice(s, target.interests, target.engagement)
              - (alreadySentTopic ? 50 : 0)        // deprioritize exact dup
              - (alreadySentNearDup ? 50 : 0),     // deprioritize semantic dup
          }
        })
        scored.sort((a, b) => b.score - a.score)
        const bestStory = scored[0].story

        allSentTopicIds.add(bestStory.topicId)
        const bestSig = titleSignature(bestStory.title)
        if (bestSig) allSentSignatures.push(bestSig)

        // ── Notification image — ONLY when the article HAS a photo ──
        // The /api/og-image endpoint composites the article photo + NW
        // banner + bias bar; when the story has NO image it renders a
        // plain dark card with just the bias bar — which looked like a
        // broken "black image" in the notification shade. Stories without
        // an image now ship NO image at all (the OS falls back to the
        // large icon), exactly as requested.
        const ogImageUrl = bestStory.imageUrl
          ? `${origin}/api/og-image?topicId=${encodeURIComponent(bestStory.topicId)}&title=${encodeURIComponent(bestStory.title.slice(0, 80))}&leanLeft=${bestStory.leanLeft}&leanCenter=${bestStory.leanCenter}&leanRight=${bestStory.leanRight}&imageUrl=${encodeURIComponent(bestStory.imageUrl)}`
          : null

        // Size-guarded: a monster imageUrl (URL-encoded inside the
        // og-image proxy URL) must never make web-push throw for every
        // device that picks this story — the guard strips the image
        // and, in the absurd worst case, truncates the body.
        const payload = buildBriefingPayload({
          title: slotLabels[target.slot],
          body: bestStory.title.slice(0, 100),
          url: `/?topic=${bestStory.topicId}`,
          // ABSOLUTE icon/badge URLs — some Android/iOS display paths
          // fail to resolve relative paths in the payload (the
          // "mini icon missing in the notification header" bug).
          origin,
          image: ogImageUrl,
          tag: `briefing-${target.slot}`,
          notifId: `tz_${target.dateKey}_${target.slot}_${target.deviceId.slice(-6)}`,
          // Like-button gate (featureFlags/notifLike, read once per run
          // above). false → the SW omits the Like action button.
          likeButton: notifLike,
        })

        // ── Pre-warm the composite image at the CDN BEFORE the push ──
        // Android/iOS fetch the notification image AT DISPLAY TIME with
        // a short internal deadline. /api/og-image composites photo +
        // banner + bias bar on its FIRST request (serverless cold start
        // + remote photo fetch up to 8s) — cold, it regularly misses that
        // deadline, and the OS degrades the notification to the compact
        // layout: NO big image and NO icon overlay (the "20-30% of
        // notifications arrive without the image though the story clearly
        // has a photo" bug). Fetching the exact URL once per story here
        // (bounded 6s) warms the Vercel edge cache (s-maxage=604800) so
        // the OS display fetch is a fast edge HIT. Only the FIRST device
        // picking this story pays the wait; every later device AND every
        // later OS fetch rides the cache.
        if (ogImageUrl && !prewarmedImages.has(ogImageUrl)) {
          prewarmedImages.add(ogImageUrl)
          try {
            await fetch(ogImageUrl, {
              signal: AbortSignal.timeout(6000),
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (compatible; NeutralWireBot/1.0; +https://neutralwire.org)',
                Accept: 'image/jpeg',
              },
            }).catch(() => {}) // best-effort — a cold edge is still correct, just slower
          } catch {
            // best-effort
          }
        }

        await webpush.sendNotification(
          target.subscription as webpush.PushSubscription,
          payload,
          {
            // TTL 1h — a briefing older than that is stale by design.
            TTL: 3600,
            // 'high' urgency = FCM high-priority on Android → immediate
            // delivery instead of Doze batching (matches the pushify path).
            urgency: 'high',
          },
        )
        sentCount++

        // Record topicId AND stemmed signature in global history.
        // topicId prevents exact duplicates (same story re-sent).
        // signature prevents semantic duplicates — now with stemmed
        // near-duplicate matching (see story-dedup.ts), so the
        // re-headlined twin of a sent story can no longer slip through.
        await firebaseWrite(
          `notification-sent-history/${bestStory.topicId}`,
          now,
        ).catch(() => {})
        const sentSig = titleSignature(bestStory.title)
        if (sentSig) {
          await firebaseWrite(
            `notification-sent-history/${sentSig}`,
            now,
          ).catch(() => {})
        }

        // Archive so notification link works forever
        await firebaseWrite(`archive/${bestStory.topicId}`, {
          ...bestStory,
          archivedAt: now,
        }).catch(() => {})

        // ── Pre-generate the neutral summary for this story ──
        // When the user clicks the notification, the topic detail opens
        // and the neutral summary loads. If we generate it NOW (in the
        // cron), the summary is already cached in Firebase by the time
        // the user clicks — so the detail page loads instantly.
        //
        // ── CPU SAVING (Fluid Active CPU) ──
        // BEFORE firing the /api/summary invocation, check Firebase for
        // an existing REAL summary. /api/summary itself checks the cache
        // before generating, but the HTTP invocation still costs a
        // function cold-start + module load + a Firebase read. Skipping
        // the invocation entirely when the summary already exists (often
        // the case — /api/refresh pre-generates summaries for the top 3
        // topics of every refresh, and these stories come from the same
        // top-of-cache positions) removes the whole invocation for free.
        // The template-summary markers mirror /api/summary's
        // isTemplateSummary(): a template fallback is treated as missing
        // so the POST still runs and regenerates a real LLM summary.
        // The whole check stays FIRE-AND-FORGET (not awaited) so it never
        // delays the push loop — exactly like the fetch it guards.
        void (async () => {
          try {
            const articlesForSummary = (bestStory.articles || []).slice(0, 12).map((a) => ({
              title: a.title,
              description: a.description,
              sourceName: a.sourceName,
              leaning: a.leaning,
            }))
            if (articlesForSummary.length === 0 && !bestStory.summary) return

            const existingSummary = await firebaseRead<{ summary?: string }>(
              `summaries/${bestStory.topicId}`,
            ).catch(() => null)
            const existingText = existingSummary?.summary || ''
            const isTemplate =
              existingText.includes('indicating significant public interest') ||
              existingText.includes('The breadth of coverage suggests') ||
              existingText.includes('Source details are no longer available for this archived story')
            if (!existingText || isTemplate) {
              await fetch(`${PRODUCTION_ORIGIN}/api/summary`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  topicId: bestStory.topicId,
                  title: bestStory.title,
                  topicSummary: bestStory.summary || '',
                  articles: articlesForSummary,
                }),
                signal: AbortSignal.timeout(12000),
              }).catch(() => {}) // fire-and-forget — don't block push sending
            }
          } catch {
            // silent — summary generation is a nice-to-have, not critical
          }
        })()

        await new Promise((r) => setTimeout(r, 100))
      } catch (err) {
        failedCount++
        const errMsg = err instanceof Error ? err.message : String(err)
        if (!firstError) firstError = errMsg
        console.warn(`[trigger-tz] Failed: ${target.deviceId.slice(0, 8)}:`, errMsg)
        // ── Roll back the "sent" mark (the Sep 23 lesson) ──
        // The mark is written BEFORE the push so a function kill mid-loop
        // can't double-send. But a CAUGHT error means nothing was
        // delivered — leaving the mark in place silently burns this
        // device's briefing slot for the REST OF THE DAY. (Sep 23: a run
        // whose pushes all failed marked every London device "sent" in
        // the 07:00 and 12:00 UTC windows — morning + lunch briefings
        // vanished for the whole timezone with zero visibility.) Un-mark
        // so the next in-window trigger (mesh 20 min / external cron
        // 30 min — the ±15-minute windows always catch at least one more
        // pass) retries the device. A function KILL (no catch) still
        // keeps the mark — the ambiguous case stays safe against
        // double-sends.
        await firebaseDelete(
          `devices/${target.deviceId}/sentSlotsToday/${target.slot}`,
        )
      }
    }

    console.log(`[trigger-tz] Complete: ${sentCount} sent, ${failedCount} failed, ${allSentTopicIds.size} unique stories, ${nearDupBlocked} near-dup blocked, in ${Date.now() - t0}ms`)

    return NextResponse.json({
      ok: true,
      message: 'Notifications dispatched',
      sent: sentCount,
      failed: failedCount,
      firstError,
      toNotify: toNotify.length,
      totalDevices,
      uniqueStories: allSentTopicIds.size,
      nearDupBlocked,
      skipBreakdown: { skipNoSub, skipNotStandalone, skipNoTimezone, skipNotInWindow, skipAlreadySent },
      historyPruned: prunedCount,
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
