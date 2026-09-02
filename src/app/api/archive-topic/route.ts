import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import { findTopicAnywhere } from '@/lib/topic-lookup'
import type { TopicArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 10

/**
 * POST /api/archive-topic
 *
 * Archives a topic's full data (with articles) to Firebase so it's
 * permanently available — even after the live cache expires.
 *
 * Called by the CLIENT in the background for each topic in the feed.
 * This spreads the archival work across users' devices instead of
 * doing it all server-side (saves Vercel CPU).
 *
 * The client sends: { topicId, title, summary, imageUrl, coverage,
 *   leanLeft, leanCenter, leanRight, firstSeen, latestSeen, articles }
 *
 * If the topic is already archived, this is a no-op (saves Firebase writes).
 * If not, it fetches the full topic (with articles) from the cache and
 * writes it to archive/<topicId>.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<TopicArticle> & { countryCode?: string }
    const topicId = body.topicId
    if (!topicId) {
      return NextResponse.json({ error: 'Missing topicId' }, { status: 400 })
    }

    // 1. Check if already archived (quick check — if yes, skip)
    const existing = await firebaseRead<{ topicId: string }>(`archive/${topicId}`)
    if (existing?.topicId) {
      return NextResponse.json({ ok: true, alreadyArchived: true })
    }

    // 2. If the client sent articles, use them directly
    let topicToArchive: TopicArticle | null = null
    if (body.articles && Array.isArray(body.articles) && body.articles.length > 0) {
      topicToArchive = body as TopicArticle
    } else {
      // 3. No articles — ONE shared lookup (archive + EVERY live cache
      // key, dynamically listed). The visitor's own caches are covered
      // automatically — no hardcoded country list, no more 404s for
      // countries outside GB/US/IN.
      const cc = (body.countryCode || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3)
      topicToArchive = await findTopicAnywhere(topicId, {
        hint: cc ? `relevant__${cc}` : undefined,
        alsoArchive: false, // we archive right below anyway
      })
    }

    if (!topicToArchive) {
      return NextResponse.json({ ok: false, error: 'Topic not found in cache' }, { status: 404 })
    }

    // 4. Write to archive (permanent storage with articles)
    await firebaseWrite(`archive/${topicId}`, {
      ...topicToArchive,
      archivedAt: Date.now(),
    })

    return NextResponse.json({ ok: true, archived: true, topicId })
  } catch (err) {
    console.warn('[api/archive-topic] error:', err)
    return NextResponse.json(
      { error: 'Archive failed' },
      { status: 500 },
    )
  }
}
