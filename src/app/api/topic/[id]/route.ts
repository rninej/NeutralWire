import { NextRequest, NextResponse } from 'next/server'
import { findTopicAnywhere } from '@/lib/topic-lookup'
import type { TopicArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
// Archive hits are permanent → CDN caches for 24h. Cache misses (404s)
// are NOT cached so a topic that hasn't been archived yet will be found
// on the next request after it IS archived.
export const maxDuration = 10

/**
 * Look up a single topic by its topicId.
 *
 * Now delegates to the ONE shared finder (src/lib/topic-lookup.ts):
 *   1. Firebase archive (archive/<topicId>) — permanent, tiny (~2KB).
 *   2. The client's `?cat=` + `?country=` hint (1 read).
 *   3. EVERY live newsCache key — dynamically listed via `?shallow=true`,
 *      so ALL country caches (relevant__CC, mycountry__CC, relevant__INT…)
 *      are covered. The old hardcoded 10-category list skipped most of
 *      them, which 404'd shared/country topics.
 *
 * Topics found in the live cache are archived automatically by the shared
 * finder — they stay resolvable forever, even after cache rotation.
 *
 * CDN caching: archive hits get `s-maxage=86400` (24h CDN cache) so
 * repeat clicks on the same topic (e.g. shared links, back button)
 * don't hit the function at all.
 *
 * Query params:
 *   - cat: category hint (e.g. "relevant", "world") — checked first
 *   - country: ISO code for the hinted category (if virtual)
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: topicId } = await params
  if (!topicId) {
    return NextResponse.json({ error: 'Missing topic id' }, { status: 400 })
  }

  const sp = req.nextUrl.searchParams
  const catHint = sp.get('cat')
  const countryHint = sp.get('country') || ''

  try {
    // Build the hint key (virtual categories carry the country suffix).
    let hint: string | undefined
    if (catHint) {
      const isVirtual = catHint === 'relevant' || catHint === 'mycountry'
      hint = isVirtual
        ? `${catHint}__${(countryHint || 'INT').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'INT'}`
        : catHint
    }

    const topic = await findTopicAnywhere(topicId, { hint })
    if (!topic) {
      // Not found anywhere — 404 WITHOUT caching (so the next request
      // after the topic IS cached/archived will find it).
      return NextResponse.json(
        { error: 'Topic not found. It may have expired.' },
        { status: 404 },
      )
    }

    const { archivedAt, ...rest } = topic
    const safeTopic: TopicArticle = {
      ...rest,
      articles: Array.isArray(rest.articles) ? rest.articles : [],
      leanLeft: rest.leanLeft ?? 0,
      leanCenter: rest.leanCenter ?? 0,
      leanRight: rest.leanRight ?? 0,
      coverage: rest.coverage ?? 0,
      firstSeen: rest.firstSeen ?? 0,
      latestSeen: rest.latestSeen ?? 0,
      imageUrl: rest.imageUrl ?? null,
      summary: rest.summary ?? '',
    }

    const res = NextResponse.json({
      topic: safeTopic,
      source: archivedAt ? 'archive' : 'cache',
      archivedAt: archivedAt || null,
    })
    res.headers.set(
      'Cache-Control',
      'public, s-maxage=86400, stale-while-revalidate=604800',
    )
    return res
  } catch (err) {
    return NextResponse.json(
      { error: 'Lookup failed', detail: String(err) },
      { status: 500 },
    )
  }
}
