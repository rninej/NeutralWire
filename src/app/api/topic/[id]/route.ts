import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead } from '@/lib/firebase-server'
import type { CategoryCachePayload, TopicArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Look up a single topic by its topicId.
 *
 * Search order:
 * 1. Firebase archive (archive/<topicId>) — permanent storage of topics
 *    that were sent via notifications. This ensures shared links work
 *    weeks or months later, even after the topic has expired from the
 *    rolling news cache.
 * 2. Firebase newsCache (newsCache/<category>/topics) — the live cache
 *    of currently-displayed news (48h window).
 *
 * This is used by the share-link flow: when someone opens a shared URL
 * like /?topic=abc123, the client calls this endpoint to find and open
 * the correct topic.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: topicId } = await params
  if (!topicId) {
    return NextResponse.json({ error: 'Missing topic id' }, { status: 400 })
  }

  try {
    // 1. Check the archive first (permanent storage).
    const archived = await firebaseRead<TopicArticle & { archivedAt?: number }>(
      `archive/${topicId}`,
    )
    if (archived) {
      // Strip the archivedAt field and return the topic.
      const { archivedAt, ...topic } = archived
      return NextResponse.json({
        topic,
        source: 'archive',
        archivedAt: archivedAt || null,
      })
    }

    // 2. Check the live news cache.
    const all = await firebaseRead<Record<string, CategoryCachePayload>>('newsCache')
    if (all) {
      for (const [catKey, payload] of Object.entries(all)) {
        if (!payload || !Array.isArray(payload.topics)) continue
        const found = payload.topics.find(
          (t: TopicArticle) => t.topicId === topicId,
        )
        if (found) {
          return NextResponse.json({
            topic: found,
            source: 'cache',
            category: catKey,
          })
        }
      }
    }

    return NextResponse.json(
      { error: 'Topic not found. It may have expired.' },
      { status: 404 },
    )
  } catch (err) {
    return NextResponse.json(
      { error: 'Lookup failed', detail: String(err) },
      { status: 500 },
    )
  }
}
