import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Track notification clicks and dismissals for the click prediction system.
 *
 * Body: {
 *   notifId: string,      // e.g. "notif_2026-07-12_morning"
 *   action: 'click' | 'dismiss',
 *   topicId: string,
 *   title: string,
 *   keywords: string[]    // significant words from the title
 * }
 *
 * Updates:
 * - notifications/<notifId>: marks clicked/dismissed
 * - notification-stats/<keyword>: increments click/dismiss count per keyword
 *   (used by the trigger endpoint to score future stories)
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      notifId: string
      action: 'click' | 'dismiss'
      topicId: string
      title: string
      keywords?: string[]
    }

    if (!body.notifId || !body.action) {
      return NextResponse.json({ error: 'Missing notifId or action' }, { status: 400 })
    }

    // 1. Mark the notification as clicked/dismissed.
    const notifKey = `notifications/${body.notifId}`
    const existing = await firebaseRead<{ clicked: boolean; dismissed: boolean }>(notifKey)
    if (existing) {
      await firebaseWrite(notifKey, {
        ...existing,
        clicked: body.action === 'click' ? true : existing.clicked,
        dismissed: body.action === 'dismiss' ? true : existing.dismissed,
        actionAt: Date.now(),
      })
    }

    // 2. Update keyword stats for click prediction.
    // Extract keywords from the title if not provided.
    const keywords = body.keywords || extractKeywords(body.title || '')
    const statsRoot = 'notification-stats'

    for (const keyword of keywords) {
      const key = `${statsRoot}/${keyword}`
      const stats = await firebaseRead<{ clicks: number; opens: number; dismisses: number }>(key) || {
        clicks: 0,
        opens: 0,
        dismisses: 0,
      }

      if (body.action === 'click') {
        stats.clicks = (stats.clicks || 0) + 1
      } else {
        stats.dismisses = (stats.dismisses || 0) + 1
      }

      await firebaseWrite(key, stats)
    }

    return NextResponse.json({ ok: true, tracked: keywords.length })
  } catch (err) {
    return NextResponse.json(
      { error: 'Tracking failed', detail: String(err) },
      { status: 500 },
    )
  }
}

/**
 * Extract significant keywords from a title (for click prediction).
 * Filters out common stop words and short words.
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
    .slice(0, 5) // top 5 keywords per title
}
