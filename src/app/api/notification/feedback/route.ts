import { NextRequest, NextResponse } from 'next/server'
import { firebasePatch, firebaseRead, firebaseWrite } from '@/lib/firebase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Notification feedback endpoint — called by the service worker when the
 * user taps the Like or Dislike action button on a push notification.
 *
 * Body: {
 *   notifId: string,      // e.g. "notif_2026-07-24_morning_abc123"
 *   action: 'like' | 'dislike',
 *   title: string,        // the story title (used for sector detection)
 *   topicId?: string,     // the story's topicId (LIKE → global rank boost)
 * }
 *
 * Records the feedback in Firebase:
 *   - notifications/<notifId>/feedback = 'like' | 'dislike'
 *   - notification-feedback/<action>/<keyword> = count (for AI personalisation)
 *   - topicBoost/<topicId> = { score, updatedAt }   (LIKE only)
 *
 * ── Topic boost ("everyone else a bit") ──
 * When the user taps Like on a notification, the story gets a small
 * ranking boost that applies to EVERY visitor's feed, not just this
 * device: /api/news reads the topicBoost map and moves boosted stories
 * up a few positions (a stable, index-based promotion — see
 * boostTopics() in the news route). Scoring: +6 per like, capped at 24,
 * expiring 7 days after the last like (stale entries are ignored on read
 * and lazily deleted). The boost is deliberately subtle — one like
 * nudges a story ~6 positions up; it takes several likes to reach the
 * top of a feed.
 *
 * The per-USER boost (personal engagement + the auto-pressed like inside
 * the article) happens client-side when the app opens the ?like=1 URL —
 * this endpoint only handles the shared/global signal plus analytics.
 */

// topicBoost scoring constants (shared semantics with /api/news).
const TOPIC_BOOST_STEP = 6
const TOPIC_BOOST_MAX = 24
const TOPIC_BOOST_TTL_MS = 7 * 24 * 60 * 60 * 1000

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      notifId?: string
      action: 'like' | 'dislike'
      title?: string
      topicId?: string
    }

    if (!body.action || !['like', 'dislike'].includes(body.action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }

    // 1. Mark the notification with the feedback
    if (body.notifId) {
      await firebasePatch(`notifications/${body.notifId}`, {
        feedback: body.action,
        feedbackAt: Date.now(),
      })
    }

    // 2. Update keyword stats for like/dislike (aggregate, not per-device)
    // The trigger endpoint reads notification-stats to avoid sending
    // disliked topics and prioritize liked ones.
    if (body.title) {
      const keywords = extractKeywords(body.title)
      for (const keyword of keywords) {
        const key = `notification-stats/${keyword}`
        const stats = await firebaseReadStats(key)
        if (body.action === 'like') {
          stats.likes = (stats.likes || 0) + 1
        } else {
          stats.dislikes = (stats.dislikes || 0) + 1
        }
        await firebasePatch(key, stats)
      }

      // ── Track sector-level dislikes ──
      // When a user clicks "Not Interested", detect which sector (politics,
      // world, sports, etc.) the story belongs to and increment a counter.
      // The trigger reads these to avoid sending stories from disliked sectors.
      if (body.action === 'dislike') {
        const sector = detectSectorFromTitle(body.title)
        if (sector) {
          const sectorKey = `notification-sector-dislikes/${sector}`
          const sectorStats = await firebaseReadStats(sectorKey)
          sectorStats.dislikes = (sectorStats.dislikes || 0) + 1
          sectorStats.lastDislike = Date.now()
          await firebasePatch(sectorKey, sectorStats)
        }
      }
    }

    // ── Topic ranking boost (LIKE only, applies to everyone's feed) ──
    // +6 per notification like, capped at 24, 7-day expiry. Best-effort —
    // the like still counts (keyword stats above) if this write fails.
    if (body.action === 'like' && body.topicId) {
      try {
        const existing = await firebaseRead<{ score?: number; updatedAt?: number }>(
          `topicBoost/${body.topicId}`,
        )
        const now = Date.now()
        const prev = existing?.updatedAt && now - existing.updatedAt < TOPIC_BOOST_TTL_MS
          ? existing.score || 0
          : 0
        await firebaseWrite(`topicBoost/${body.topicId}`, {
          score: Math.min(TOPIC_BOOST_MAX, prev + TOPIC_BOOST_STEP),
          updatedAt: now,
        })
      } catch {
        // silent — best effort
      }
    }

    return NextResponse.json({ ok: true, action: body.action })
  } catch (err) {
    return NextResponse.json(
      { error: 'Feedback failed', detail: String(err) },
      { status: 500 },
    )
  }
}

async function firebaseReadStats(key: string): Promise<{
  clicks?: number
  opens?: number
  dismisses?: number
  likes?: number
  dislikes?: number
  lastDislike?: number
}> {
  try {
    const data = await firebaseRead<{
      clicks?: number
      opens?: number
      dismisses?: number
      likes?: number
      dislikes?: number
    }>(key)
    return data || { clicks: 0, opens: 0, dismisses: 0, likes: 0, dislikes: 0 }
  } catch {
    return { clicks: 0, opens: 0, dismisses: 0, likes: 0, dislikes: 0 }
  }
}

/**
 * Extract significant keywords from a title (for like/dislike tracking).
 * Same logic as /api/notification/track.
 */
function extractKeywords(title: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'from', 'by', 'is', 'was', 'are', 'were', 'be', 'been',
    'being', 'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them',
    'their', 'there', 'here', 'we', 'us', 'our', 'you', 'your', 'he', 'she',
    'his', 'her', 'not', 'no', 'yes', 'do', 'does', 'did', 'has', 'have',
    'had', 'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must',
    'about', 'after', 'before', 'between', 'during', 'through', 'over',
    'under', 'up', 'down', 'out', 'off', 'than', 'too', 'very', 'just',
    'also', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
    'says', 'said', 'say', 'new', 'one', 'two', 'amid', 'news', 'report',
  ])

  return title
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 4 && !stopWords.has(w))
    .slice(0, 5)
}

/**
 * Detect which sector a title belongs to (for dislike tracking).
 * Returns a sector ID or null if no match.
 */
function detectSectorFromTitle(title: string): string | null {
  const text = title.toLowerCase()
  const sectorKeywords: Record<string, string[]> = {
    politics: ['trump', 'biden', 'parliament', 'congress', 'senate', 'election', 'labour', 'conservative', 'government', 'minister', 'prime minister', 'president', 'policy'],
    world: ['ukraine', 'russia', 'china', 'israel', 'gaza', 'iran', 'middle east', 'europe', 'nato', 'war', 'conflict'],
    business: ['stock', 'market', 'economy', 'inflation', 'interest rate', 'gdp', 'recession', 'tariff', 'merger', 'earnings', 'profit'],
    technology: ['ai ', 'artificial intelligence', 'google', 'apple', 'microsoft', 'tesla', 'nvidia', 'chip', 'cyber', 'hack', 'crypto'],
    science: ['nasa', 'spacex', 'rocket', 'space', 'climate', 'carbon', 'earthquake', 'discovery', 'scientists'],
    health: ['covid', 'vaccine', 'hospital', 'nhs', 'cancer', 'disease', 'virus', 'health'],
    sports: ['premier league', 'champions league', 'arsenal', 'chelsea', 'liverpool', 'cricket', 'rugby', 'golf', 'f1', 'boxing', 'olympics', 'football', 'tennis'],
    entertainment: ['movie', 'film', 'oscar', 'netflix', 'celebrity', 'actor', 'music', 'concert', 'gaming'],
  }
  for (const [sector, keywords] of Object.entries(sectorKeywords)) {
    for (const kw of keywords) {
      if (text.includes(kw)) return sector
    }
  }
  return null
}
