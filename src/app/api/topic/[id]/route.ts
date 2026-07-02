import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead } from '@/lib/firebase-server'
import type { CategoryCachePayload, TopicArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

const ROOT = 'newsCache'

/**
 * Look up a single topic by its topicId across ALL cached categories
 * in Firebase. This is used by the share-link flow: when someone opens
 * a shared URL like /?topic=abc123, the client calls this endpoint to
 * find and open the correct topic regardless of which category it was
 * from.
 *
 * Reads the entire newsCache/ root in one Firebase call and searches
 * every category's topics array.
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
    // Read the entire newsCache root — one Firebase call.
    const all = await firebaseRead<Record<string, CategoryCachePayload>>(ROOT)
    if (!all) {
      return NextResponse.json({ error: 'No cached news found' }, { status: 404 })
    }

    // Search every category for the topic.
    for (const [catKey, payload] of Object.entries(all)) {
      if (!payload || !Array.isArray(payload.topics)) continue
      const found = payload.topics.find((t: TopicArticle) => t.topicId === topicId)
      if (found) {
        return NextResponse.json({
          topic: found,
          category: catKey,
          cached: true,
        })
      }
    }

    return NextResponse.json({ error: 'Topic not found in any cache' }, { status: 404 })
  } catch (err) {
    return NextResponse.json(
      { error: 'Lookup failed', detail: String(err) },
      { status: 500 },
    )
  }
}
