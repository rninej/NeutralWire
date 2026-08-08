import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead } from '@/lib/firebase-server'
import type { TopicArticle } from '@/lib/news-aggregator'
import { isVirtualCategory } from '@/lib/news-cache'
import { detectCountryServer, DEFAULT_COUNTRY } from '@/lib/country-detect'

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
 * Search order (OPTIMIZED — was reading 21 full category caches = up to
 * 6MB Firebase download per click):
 *   1. Firebase archive (archive/<topicId>) — permanent, tiny (~2KB).
 *      This is the FIRST check because notification-sent topics are
 *      archived and are the most commonly clicked (via push notification).
 *   2. If a `?cat=` hint is provided by the client, check that category
 *      FIRST (1 read). This is the fastest path for feed clicks.
 *   3. Fallback: sequential scan of the 10 most-likely categories,
 *      stopping at the first match. The order is based on which tabs
 *      users click most (relevant → top → world → politics → mycountry
 *      → business → technology → science → health → sports).
 *      We NO LONGER check 16 virtual-country variants (relevant__US,
 *      mycountry__IN, etc.) — they overlap heavily with relevant__GB
 *      and top. This cuts worst-case Firebase downloads from ~6MB to
 *      ~1.5MB, and typical case to ~300KB (archive + 1 category).
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
    // 1. Check the archive first (permanent storage, tiny read).
    // This is the fastest path for notification-sent topics.
    const archived = await firebaseRead<TopicArticle & { archivedAt?: number }>(
      `archive/${topicId}`,
    )
    if (archived) {
      const { archivedAt, ...topic } = archived
      const safeTopic: TopicArticle = {
        ...topic,
        articles: Array.isArray(topic.articles) ? topic.articles : [],
        leanLeft: topic.leanLeft ?? 0,
        leanCenter: topic.leanCenter ?? 0,
        leanRight: topic.leanRight ?? 0,
        coverage: topic.coverage ?? 0,
        firstSeen: topic.firstSeen ?? 0,
        latestSeen: topic.latestSeen ?? 0,
        imageUrl: topic.imageUrl ?? null,
        summary: topic.summary ?? '',
      }
      const res = NextResponse.json({
        topic: safeTopic,
        source: 'archive',
        archivedAt: archivedAt || null,
      })
      // Archive entries are permanent — cache at the CDN for 24h so
      // repeat clicks (back button, shared links) don't hit the function.
      res.headers.set('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800')
      return res
    }

    // 2. Build the search list — hinted category first, then the
    // most-likely categories in priority order.
    // Each entry is a Firebase path under newsCache/.
    const detectedCountry = countryHint ||
      (await detectCountryServer(req.headers).then((c) => c?.code || DEFAULT_COUNTRY.code).catch(() => DEFAULT_COUNTRY.code))

    // Build the category paths to check. We use a Set to avoid duplicates
    // (e.g. if the hint is "top" and "top" is already in the list).
    const searchPaths: string[] = []
    const seenPaths = new Set<string>()

    const addPath = (cat: string, country: string = '') => {
      const isVirtual = cat === 'relevant' || cat === 'mycountry'
      const path = isVirtual
        ? `${cat}__${(country || 'INT').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'INT'}`
        : cat
      if (!seenPaths.has(path)) {
        seenPaths.add(path)
        searchPaths.push(path)
      }
    }

    // Hint first (if provided)
    if (catHint) addPath(catHint, detectedCountry)

    // Then the most-likely categories in priority order.
    // Virtual categories use the detected country.
    addPath('relevant', detectedCountry)
    addPath('top')
    addPath('world')
    addPath('politics')
    addPath('mycountry', detectedCountry)
    addPath('business')
    addPath('technology')
    addPath('science')
    addPath('health')
    addPath('sports')
    // Also check blindspots (cheap — it's a single cached node if it exists)
    addPath('blindspots')

    // 3. Sequential scan — stop at the first category that has the topic.
    // Sequential (not parallel) to minimize Firebase download bandwidth:
    // if we read all 11 in parallel, we'd download ~3MB even when the
    // topic is in the first one. Sequential stops as soon as we find it.
    for (const catKey of searchPaths) {
      const payload = await firebaseRead<{ topics?: TopicArticle[] }>(`newsCache/${catKey}`)
      if (payload && Array.isArray(payload.topics)) {
        const found = payload.topics.find((t: TopicArticle) => t.topicId === topicId)
        if (found) {
          const res = NextResponse.json({
            topic: found,
            source: 'cache',
            category: catKey,
          })
          // Cache hits for 5 min — the topic won't move categories in
          // that window, and 5 min is short enough that a stale entry
          // (topic rotated out of cache) will be corrected on next fetch.
          res.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
          return res
        }
      }
    }

    // Not found anywhere — return 404 WITHOUT caching (so the next
    // request after the topic IS cached/archived will find it).
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
