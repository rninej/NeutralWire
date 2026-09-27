import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead } from '@/lib/firebase-server'
import { accountForApiKey } from '@/lib/subscriptions'
import { readCustomFeed } from '@/lib/custom-topics'
import type { TopicArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 30

/**
 * GET /api/v1/feed — the NeutralWire feed API (Ultra tier).
 *
 * Auth: `Authorization: Bearer nwul_…` or `?key=nwul_…`. The key resolves
 * to an account via the hashed apiKeys index; only ULTRA accounts pass.
 *
 * Params:
 *   topic   — a built-in category (top, world, politics, business,
 *             technology, science, health, sports) OR a custom subtopic
 *             id (from /api/subtopics) — default 'top'.
 *   limit   — 5-40 (default 20); slim=1 strips per-source article lists.
 *
 * Response: { ok, topic, count, topics: TopicArticle[] } with a
 * descriptive 401/402 when the key is wrong or the tier lapsed.
 */
const BUILTIN_TOPICS = [
  'top', 'world', 'politics', 'business', 'technology', 'science', 'health', 'sports',
]

export async function GET(req: NextRequest) {
  // ── API key (Bearer header or ?key=) ──
  const authHeader = req.headers.get('authorization') || ''
  let key = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : ''
  if (!key) key = req.nextUrl.searchParams.get('key') || ''
  if (!key) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Missing API key',
        hint: 'Pass Authorization: Bearer <your NeutralWire Ultra API key> or ?key=…',
      },
      { status: 401 },
    )
  }

  const account = await accountForApiKey(key)
  if (!account) {
    return NextResponse.json(
      { ok: false, error: 'Invalid API key or the subscription is no longer Ultra.' },
      { status: 401 },
    )
  }

  // ── Params ──
  const sp = req.nextUrl.searchParams
  const topic = (sp.get('topic') || 'top').toLowerCase().replace(/^custom:/, '')
  const limit = Math.min(40, Math.max(5, Number(sp.get('limit') || '20')))
  const slim = sp.get('slim') === '1'

  // ── Custom subtopic feed or a built-in category cache ──
  let topics: TopicArticle[] = []
  let label = topic
  if (!BUILTIN_TOPICS.includes(topic)) {
    const feed = await readCustomFeed(topic).catch(() => null)
    if (!feed || !Array.isArray(feed.topics)) {
      const def = await firebaseRead<{ label?: string }>(`customSubtopics/${topic}`).catch(() => null)
      return NextResponse.json(
        {
          ok: false,
          error: `Unknown topic '${topic}'.`,
          hint: `Built-in topics: ${BUILTIN_TOPICS.join(', ')}. Custom subtopic ids are listed by /api/subtopics.`,
          label: def?.label || null,
        },
        { status: 404 },
      )
    }
    topics = feed.topics
    label = topic
  } else {
    const cached = await firebaseRead<{ topics: TopicArticle[]; updatedAt?: number }>(
      `newsCache/${topic}`,
    ).catch(() => null)
    topics = cached?.topics || []
    label = topic
  }

  const result = topics.slice(0, limit).map((t) => (slim ? { ...t, articles: [] } : t))
  return NextResponse.json(
    {
      ok: true,
      topic: label,
      count: result.length,
      generatedAt: new Date().toISOString(),
      topics: result,
    },
    { headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=240' } },
  )
}
