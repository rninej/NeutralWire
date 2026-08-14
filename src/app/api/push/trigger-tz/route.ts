import { NextRequest, NextResponse } from 'next/server'
import webpush from 'web-push'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } from '@/lib/vapid'
import type { TopicArticle } from '@/lib/news-aggregator'

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

// ── Briefing windows (LOCAL time, 2h wide for 30-min cron) ──
const SLOT_WINDOWS = {
  morning: { startHour: 6, startMinute: 30, endHour: 8, endMinute: 30 },
  lunch: { startHour: 11, startMinute: 30, endHour: 13, endMinute: 30 },
  evening: { startHour: 18, startMinute: 30, endHour: 20, endMinute: 30 },
} as const

type Slot = keyof typeof SLOT_WINDOWS

// Max age for global sent-history entries (14 days). Entries older than
// this are pruned so the history doesn't grow forever and block all
// future stories.
const HISTORY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Generate a SEMANTIC FINGERPRINT for a story title.
 *
 * This normalizes the title by:
 *   1. Lowercasing
 *   2. Removing all numbers (so "139 killed" and "169 killed" match)
 *   3. Removing common articles/stopwords ("the", "a", "in", "of", etc.)
 *   4. Sorting the remaining keywords alphabetically (so word order doesn't matter)
 *
 * Two stories about the SAME EVENT with different numbers/wording will
 * produce the SAME fingerprint:
 *   "At least 169 killed in Colombia's largest earthquake in years"
 *   "At least 139 killed in Colombia's largest earthquake in years"
 *   → both become: "colombia earthquake killed largest years"
 *
 * This prevents duplicate notifications when a story develops (death toll
 * updates, headline rewording, etc.) — the second version is recognized
 * as the same story and skipped.
 */
const FINGERPRINT_STOPWORDS = new Set([
  'the', 'a', 'an', 'in', 'of', 'at', 'to', 'for', 'on', 'and', 'or',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'by', 'with',
  'from', 'as', 'its', 'it', 'that', 'this', 'these', 'those', 'has',
  'have', 'had', 'will', 'would', 'could', 'should', 'may', 'might',
  'not', 'no', 'but', 'if', 'then', 'than', 'so', 'do', 'does', 'did',
  'about', 'after', 'before', 'more', 'most', 'some', 'any', 'all',
  'new', 'says', 'said', 'say', 'report', 'reports', 'amid', 'while',
  'over', 'under', 'up', 'down', 'out', 'off', 'into', 'onto', 'upon',
])

function storyFingerprint(title: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ') // remove numbers + punctuation
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length >= 3 && !FINGERPRINT_STOPWORDS.has(w))
    .sort()
    .join(' ')
  // Only return a fingerprint if we have at least 3 significant keywords
  // (otherwise the fingerprint is too generic and might block unrelated stories)
  const wordCount = cleaned.split(' ').filter(Boolean).length
  return wordCount >= 3 ? cleaned : ''
}

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

function isInSlotWindow(hour: number, minute: number, slot: Slot): boolean {
  const win = SLOT_WINDOWS[slot]
  const currentMin = hour * 60 + minute
  return currentMin >= win.startHour * 60 + win.startMinute &&
         currentMin <= win.endHour * 60 + win.endMinute
}

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
  const dryRun = req.nextUrl.searchParams.get('dry') === '1'
  const forceEvening = req.nextUrl.searchParams.get('forceEvening') === '1'
  const forceSlot = req.nextUrl.searchParams.get('forceSlot') as Slot | null

  if (secret !== TRIGGER_TZ_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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

    let allStories: TopicArticle[] = []
    try {
      const categories = ['mycountry', 'relevant', 'world', 'technology', 'business', 'science', 'top']
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

    // ── Filter fresh stories using BOTH topicId AND fingerprint ──
    // A story is "fresh" if:
    //   - Its topicId is NOT in sentSet (not the exact same story), AND
    //   - Its fingerprint is NOT in sentSet (not a semantic duplicate)
    // This prevents "139 killed" and "169 killed" from both being sent.
    const freshStories = candidates.filter((s) => {
      if (sentSet.has(s.topicId)) return false // exact duplicate
      const fp = storyFingerprint(s.title)
      if (fp && sentSet.has(fp)) return false // semantic duplicate
      return true
    })

    if (freshStories.length === 0) {
      console.log('[trigger-tz] All stories already sent — skipping')
      return NextResponse.json({ ok: true, message: 'All stories already sent', sent: 0, toNotify: toNotify.length, ts: Date.now() })
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
    const allSentTopicIds = new Set<string>()
    const allSentFingerprints = new Set<string>()

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
        // (so different users get different stories when possible).
        // ALSO deprioritize stories whose FINGERPRINT matches a story already
        // sent in this run (catches "139 killed" vs "169 killed" — same event,
        // different numbers, sent to different devices in the same cron run).
        const scored = freshStories.map((s) => {
          const fp = storyFingerprint(s.title)
          const alreadySentTopic = allSentTopicIds.has(s.topicId)
          const alreadySentFp = fp && allSentFingerprints.has(fp)
          return {
            story: s,
            score: scoreStoryForDevice(s, target.interests, target.engagement)
              - (alreadySentTopic ? 50 : 0)        // deprioritize exact dup
              - (alreadySentFp ? 50 : 0),          // deprioritize semantic dup
          }
        })
        scored.sort((a, b) => b.score - a.score)
        const bestStory = scored[0].story

        allSentTopicIds.add(bestStory.topicId)
        const bestFp = storyFingerprint(bestStory.title)
        if (bestFp) allSentFingerprints.add(bestFp)

        // ── Use the OG share image as the notification image ──
        // The /api/og-image endpoint generates an image with the article's
        // photo + NEUTRALWIRE banner + bias bar (left/center/right
        // percentages). This is the same image used for social share
        // previews. Using it as the notification image gives users a
        // rich preview with the bias visualization before they tap.
        const ogImageUrl = `${origin}/api/og-image?topicId=${encodeURIComponent(bestStory.topicId)}&title=${encodeURIComponent(bestStory.title.slice(0, 80))}&leanLeft=${bestStory.leanLeft}&leanCenter=${bestStory.leanCenter}&leanRight=${bestStory.leanRight}&imageUrl=${encodeURIComponent(bestStory.imageUrl || '')}`

        const payload = JSON.stringify({
          title: slotLabels[target.slot],
          body: bestStory.title.slice(0, 100),
          url: `/?topic=${bestStory.topicId}`,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          image: ogImageUrl,
          tag: `briefing-${target.slot}`,
          notifId: `tz_${target.dateKey}_${target.slot}_${target.deviceId.slice(-6)}`,
        })

        await webpush.sendNotification(
          target.subscription as webpush.PushSubscription,
          payload,
        )
        sentCount++

        // Record BOTH topicId AND fingerprint in global history.
        // topicId prevents exact duplicates (same story re-sent).
        // fingerprint prevents semantic duplicates (same event, different
        // numbers — e.g. "139 killed" → "169 killed" won't be sent again).
        await firebaseWrite(
          `notification-sent-history/${bestStory.topicId}`,
          now,
        ).catch(() => {})
        const sentFp = storyFingerprint(bestStory.title)
        if (sentFp) {
          await firebaseWrite(
            `notification-sent-history/${sentFp}`,
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
        // We fire-and-forget this (don't await) so it doesn't slow down
        // the push sending. The summary API deduplicates concurrent
        // requests for the same topicId, so multiple cron runs won't
        // generate the same summary twice.
        try {
          const articlesForSummary = (bestStory.articles || []).slice(0, 12).map((a) => ({
            title: a.title,
            description: a.description,
            sourceName: a.sourceName,
            leaning: a.leaning,
          }))
          if (articlesForSummary.length > 0 || bestStory.summary) {
            fetch(`${PRODUCTION_ORIGIN}/api/summary`, {
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

        await new Promise((r) => setTimeout(r, 100))
      } catch (err) {
        failedCount++
        console.warn(`[trigger-tz] Failed: ${target.deviceId.slice(0, 8)}:`, err instanceof Error ? err.message : err)
      }
    }

    console.log(`[trigger-tz] Complete: ${sentCount} sent, ${failedCount} failed, ${allSentTopicIds.size} unique stories in ${Date.now() - t0}ms`)

    return NextResponse.json({
      ok: true,
      message: 'Notifications dispatched',
      sent: sentCount,
      failed: failedCount,
      toNotify: toNotify.length,
      totalDevices,
      uniqueStories: allSentTopicIds.size,
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
