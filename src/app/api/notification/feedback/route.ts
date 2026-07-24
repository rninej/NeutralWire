import { NextRequest, NextResponse } from 'next/server'
import { firebasePatch } from '@/lib/firebase-server'

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
 * }
 *
 * Records the feedback in Firebase:
 *   - notifications/<notifId>/feedback = 'like' | 'dislike'
 *   - notification-feedback/<action>/<keyword> = count (for AI personalisation)
 *
 * The engagement bump (per-device) is NOT done here because we don't know
 * the deviceId from the SW. Instead, we record aggregate keyword stats
 * that the trigger endpoint uses for future story selection.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      notifId?: string
      action: 'like' | 'dislike'
      title?: string
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
    }

    return NextResponse.json({ ok: true, action: body.action })
  } catch (err) {
    return NextResponse.json(
      { error: 'Feedback failed', detail: String(err) },
      { status: 500 },
    )
  }
}

// Inline import to avoid circular dependency
import { firebaseRead } from '@/lib/firebase-server'

async function firebaseReadStats(key: string): Promise<{
  clicks?: number
  opens?: number
  dismisses?: number
  likes?: number
  dislikes?: number
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
