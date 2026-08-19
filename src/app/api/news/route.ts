import { NextRequest, NextResponse } from 'next/server'
import type { Category } from '@/lib/news-sources'
import { NEWS_SOURCES } from '@/lib/news-sources'
import { aggregateCategory, shortenLongTitles, type TopicArticle } from '@/lib/news-aggregator'
import { aggregateMyCountryViaGdelt } from '@/lib/gdelt-aggregator'
import {
  readCachedNews,
  refreshCategory,
  isStale,
  canRefresh,
  isVirtualCategory,
  CACHE_CONSTANTS,
} from '@/lib/news-cache'
import {
  detectCountryServer,
  sourcesForCountry,
  DEFAULT_COUNTRY,
} from '@/lib/country-detect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
// Cap CPU time. Cache hits are <100ms. A cold aggregate (RSS/GDELT)
// takes 5-15s. 20s is a safe ceiling (was 25s — reduced to save CPU).
export const maxDuration = 20

/**
 * Cache-first news endpoint.
 *
 * Behaviour:
 *   1. For virtual categories (`relevant`, `mycountry`), detect the visitor's
 *      country from request headers (server-side, ip-api.com).
 *   2. Read Firebase cache for the (category, country) pair.
 *   3. If fresh: return it (fast).
 *   4. If stale: return it immediately AND kick off a background refresh.
 *   5. If missing: do a synchronous aggregate (one-time per country).
 *
 * Query params:
 *   - category: 'relevant' | 'mycountry' | 'top' | ... (default 'relevant')
 *   - country:  ISO 3166-1 alpha-2 code (overrides auto-detection)
 *   - limit, minCoverage, wait
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const category = (sp.get('category') || 'relevant') as Category
  const limit = Math.min(40, Math.max(5, Number(sp.get('limit') || '24')))
  const minCoverage = Math.max(1, Math.min(8, Number(sp.get('minCoverage') || '1')))
  const wait = sp.get('wait') === '1'
  const slim = sp.get('slim') === '1' // strips articles array → ~80% smaller response
  const countryOverride = sp.get('country') || ''
  // Offset for infinite scroll — skip the first N topics and return the next N.
  // Default 0 (first page). The cache stores 40 topics; offset > 0 returns
  // from the archived/older set when available.
  const offset = Math.max(0, Number(sp.get('offset') || '0'))

  const t0 = Date.now()

  // Resolve the visitor's country for virtual categories.
  let country = countryOverride
  let countryName = ''
  if (isVirtualCategory(category)) {
    if (!country) {
      const detected = await detectCountryServer(req.headers)
      country = detected?.code || DEFAULT_COUNTRY.code
      countryName = detected?.name || DEFAULT_COUNTRY.name
    } else {
      countryName = country
    }
  }

  // For non-virtual categories we still pass an empty country — cachePath
  // ignores it.
  const countrySourceIds = isVirtualCategory(category)
    ? sourcesForCountry(country)
    : []

  // Virtual categories (relevant, mycountry) get MORE topics cached (60)
  // so infinite scroll has more to load — users were running out of news
  // when scrolling to the bottom. Non-virtual categories stay at 40.
  const cacheLimit = isVirtualCategory(category) ? 60 : 40

  // ── Aggregation backend selector ──
  // `mycountry` uses the GDELT Cloud API (aggregates ALL news outlets for
  // the visitor's country — thousands of local + national papers, no AI
  // filtering needed). All other categories use the RSS-based aggregator.
  const isMyCountry = category === 'mycountry'

  // ── Blindspots: special category ──
  // Not aggregated from RSS — instead, reads multiple cached categories
  // (top, world, politics, etc.), filters for topics where ≥80% of
  // coverage comes from ONE side (Left or Right), and returns those.
  // This shows stories the other side is NOT covering — "blindspots".
  const isBlindspots = category === 'blindspots'
  if (isBlindspots) {
    return handleBlindspots(req, limit, minCoverage, slim, offset, t0)
  }

  const aggregate = async (): Promise<{
    topics: TopicArticle[]
    sourceCount: number
    articleCount: number
  }> => {
    if (isMyCountry) {
      // GDELT backend for My Country — comprehensive country-specific news
      const gdeltResult = await aggregateMyCountryViaGdelt(country, cacheLimit)
      // Shorten long titles (>140 chars) via AI in the background
      await shortenLongTitles(gdeltResult.topics)
      return gdeltResult
    }
    // RSS backend for all other categories
    const rssResult = await aggregateCategory(category, {
      limit: cacheLimit,
      minCoverage: 1,
      countrySourceIds,
      countryCode: country,
    })
    return rssResult
  }

  // 1. Try cache first.
  let cached = await readCachedNews(category, country)

  // 2. If no cache at all → do one synchronous aggregate.
  if (!cached) {
    try {
      const agg = await aggregate()
      const payload = {
        updatedAt: Date.now(),
        sourceCount: agg.sourceCount,
        articleCount: agg.articleCount,
        topics: agg.topics,
      }
      void refreshCategory(category, country, async () => Promise.resolve(agg))
      return NextResponse.json({
        category,
        country,
        countryName,
        topics: applyFilters(payload.topics, limit, minCoverage, offset, slim),
        cached: false,
        fresh: true,
        sourceCount: payload.sourceCount,
        articleCount: payload.articleCount,
        fetchedAt: new Date(payload.updatedAt).toISOString(),
        ms: Date.now() - t0,
      })
    } catch (err) {
      return NextResponse.json(
        { error: 'Failed to fetch news', detail: String(err) },
        { status: 500 },
      )
    }
  }

  // 3. Cache exists.
  const truncated = applyFilters(cached.topics, limit, minCoverage, offset, slim)

  // 4. Refresh if stale.
  // CRITICAL: Previously used `after()` for background refresh, but Vercel
  // Hobby KILLS `after()` callbacks as soon as the response is sent. This
  // meant stale categories NEVER got refreshed — users always saw old news.
  //
  // FIX: For first-page requests (offset=0), do a SYNCHRONOUS refresh when
  // the cache is stale. The user sees a brief loading state, then gets
  // FRESH news. For infinite scroll (offset>0), serve stale cache (don't
  // block scrolling with a slow refresh).
  const stale = isStale(cached, category)
  if (stale && canRefresh(category, country)) {
    if (offset === 0 || wait) {
      // First page or explicit wait → synchronous refresh (user gets fresh news)
      try {
        const fresh = await refreshCategory(category, country, async () => aggregate())
        if (fresh) {
          return NextResponse.json({
            category,
            country,
            countryName,
            topics: applyFilters(fresh.topics, limit, minCoverage, offset, slim),
            cached: false,
            fresh: true,
            sourceCount: fresh.sourceCount,
            articleCount: fresh.articleCount,
            fetchedAt: new Date(fresh.updatedAt).toISOString(),
            ms: Date.now() - t0,
          })
        }
      } catch (err) {
        console.warn(`[api/news] synchronous refresh ${category}/${country} failed:`, err)
        // Fall through to serve stale cache
      }
    }
    // For offset > 0: serve stale cache (don't block infinite scroll)
  }

  // Add CDN cache headers so repeated requests (bots, SW, multiple users)
  // are served from the Vercel CDN edge cache WITHOUT running the function.
  // s-maxage=300 (5 min CDN cache), stale-while-revalidate=600 (serve
  // stale for up to 10 min while revalidating). This cuts function CPU
  // dramatically — most requests never hit the function.
  const response = NextResponse.json({
    category,
    country,
    countryName,
    topics: truncated,
    cached: true,
    fresh: !stale,
    sourceCount: cached.sourceCount ?? NEWS_SOURCES.length,
    articleCount: cached.articleCount ?? truncated.length,
    fetchedAt: new Date(cached.updatedAt).toISOString(),
    staleMs: stale ? Date.now() - cached.updatedAt : 0,
    cacheTtlMs: CACHE_CONSTANTS.STALE_MS,
    ms: Date.now() - t0,
  })
  response.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
  return response
}

function applyFilters(
  topics: TopicArticle[],
  limit: number,
  minCoverage: number,
  offset: number = 0,
  slim: boolean = false,
): TopicArticle[] {
  // NOTE: Do NOT re-sort here. The topics are already sorted by the
  // aggregator (with local-boost for the `relevant` category). Re-sorting
  // by coverage would destroy the local-news prioritisation.
  const result = topics
    .filter((t) => t.coverage >= minCoverage)
    .slice(offset, offset + limit)
  // When slim=true, strip the articles array from each topic. This reduces
  // the response size by ~80% (articles contain titles, links, descriptions
  // for every source). Articles are only needed when the user clicks
  // "View sources" or opens the detail view — fetched separately via
  // /api/topic/[id].
  if (slim) {
    return result.map((t) => ({ ...t, articles: [] }))
  }
  return result
}

/**
 * Blindspots handler.
 *
 * Reads multiple cached categories (top, world, politics, business,
 * technology, science, health), merges all topics, then filters for
 * stories where ≥80% of coverage comes from ONE side (Left or Right).
 *
 * A "blindspot" is a story that one side of the political spectrum is
 * covering heavily while the other side is mostly ignoring it. This helps
 * users see what they might be missing based on their usual sources.
 *
 * For each blindspot topic, we add a `blindspotSide` field ('left' or
 * 'right') and `blindspotPct` (the percentage of coverage from that side)
 * so the UI can show a badge like "Only 8% Right" or "Only 12% Left".
 *
 * No RSS/GDELT aggregation is done — this purely filters existing cached
 * data, so it's fast and adds zero CPU cost.
 */
async function handleBlindspots(
  req: NextRequest,
  limit: number,
  minCoverage: number,
  slim: boolean,
  offset: number,
  t0: number,
) {
  // Read ALL cached categories in parallel. Each category is tracked so
  // we know which section a blindspot topic belongs to.
  const catsToCheck: Category[] = [
    'top', 'world', 'politics', 'business', 'technology', 'science', 'health', 'sports',
  ]
  // Also check virtual categories for common countries.
  const virtualCats: Array<{ cat: Category; country: string }> = [
    { cat: 'relevant', country: 'GB' },
    { cat: 'relevant', country: 'US' },
    { cat: 'relevant', country: 'IN' },
    { cat: 'mycountry', country: 'GB' },
    { cat: 'mycountry', country: 'US' },
    { cat: 'mycountry', country: 'IN' },
  ]

  // Fetch all cached categories. Each result is tagged with its source
  // category so we can group blindspots by section in the UI.
  const allCached: Array<{ cat: Category; topics: TopicArticle[] }> = []
  const rssResults = await Promise.all(
    catsToCheck.map(async (cat) => {
      const cached = await readCachedNews(cat, '').catch(() => null)
      return { cat, topics: cached?.topics || [] }
    }),
  )
  allCached.push(...rssResults)

  const virtualResults = await Promise.all(
    virtualCats.map(async ({ cat, country }) => {
      const cached = await readCachedNews(cat, country).catch(() => null)
      // Map virtual categories to their display category (relevant → top,
      // mycountry → world as a fallback section, but we'll use 'mycountry'
      // as its own section label)
      return { cat, topics: cached?.topics || [] }
    }),
  )
  // For virtual categories, only add topics not already seen (they overlap
  // heavily with the RSS categories). Tag them with their virtual cat name.
  allCached.push(...virtualResults)

  // Build a map: topicId → source categories (a topic can appear in
  // multiple category caches). We'll assign each topic to its FIRST
  // (most relevant) category for sectioning.
  const topicToCategory = new Map<string, Category>()
  const seenTopicIds = new Set<string>()
  const seenTitles = new Set<string>()
  const allTopics: TopicArticle[] = []

  // Process in priority order: RSS categories first (top, world, politics,
  // etc.), then virtual (relevant, mycountry). This ensures a topic is
  // assigned to its most specific category.
  for (const { cat, topics } of allCached) {
    for (const t of topics) {
      if (seenTopicIds.has(t.topicId)) continue
      const normTitle = t.title.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
      if (normTitle && seenTitles.has(normTitle)) continue
      seenTopicIds.add(t.topicId)
      if (normTitle) seenTitles.add(normTitle)
      allTopics.push(t)
      topicToCategory.set(t.topicId, cat)
    }
  }

  // Filter for blindspots: ≥80% of coverage from one side
  const BLINDSPOT_THRESHOLD = 0.8
  const MIN_TOTAL = 2
  const blindspots = allTopics
    .map((t) => {
      const total = t.leanLeft + t.leanCenter + t.leanRight
      const leftPct = total > 0 ? t.leanLeft / total : 0
      const rightPct = total > 0 ? t.leanRight / total : 0
      let side: 'left' | 'right' | null = null
      let pct = 0
      if (leftPct >= BLINDSPOT_THRESHOLD) {
        side = 'left'
        pct = Math.round(rightPct * 100)
      } else if (rightPct >= BLINDSPOT_THRESHOLD) {
        side = 'right'
        pct = Math.round(leftPct * 100)
      }
      return { topic: t, side, pct, total }
    })
    .filter((entry) => entry.side !== null && entry.total >= MIN_TOTAL)
    .sort((a, b) => {
      if (a.pct !== b.pct) return a.pct - b.pct
      return b.topic.coverage - a.topic.coverage
    })

  // Group blindspots by their source category for sectioned display.
  // Each category gets up to 7 topics (1 hero + 6 mini cards).
  const MAX_PER_SECTION = 7
  const sections: Record<string, TopicArticle[]> = {}
  for (const entry of blindspots) {
    const cat = topicToCategory.get(entry.topic.topicId) || 'top'
    const sectionKey = cat
    if (!sections[sectionKey]) sections[sectionKey] = []
    if (sections[sectionKey].length >= MAX_PER_SECTION) continue
    sections[sectionKey].push({
      ...entry.topic,
      blindspotSide: entry.side,
      blindspotPct: entry.pct,
      articles: slim ? [] : entry.topic.articles,
    })
  }

  // Also build a flat list (for backward compat / infinite scroll)
  const result = blindspots
    .slice(offset, offset + limit)
    .map((entry) => ({
      ...entry.topic,
      blindspotSide: entry.side,
      blindspotPct: entry.pct,
      articles: slim ? [] : entry.topic.articles,
    }))

  return NextResponse.json({
    category: 'blindspots',
    country: '',
    countryName: '',
    topics: result,
    // Sections: { world: [...], politics: [...], business: [...], ... }
    // Each section has up to 7 blindspot topics. The client uses this to
    // render a SectionedFeed-style layout with per-category sections.
    sections,
    cached: true,
    fresh: true,
    sourceCount: new Set(allTopics.map((t) => t.articles?.[0]?.sourceId)).size,
    articleCount: allTopics.length,
    fetchedAt: new Date().toISOString(),
    ms: Date.now() - t0,
  })
}
