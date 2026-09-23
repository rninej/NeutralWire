import { NextRequest, NextResponse } from 'next/server'
import { findTopicAnywhere } from '@/lib/topic-lookup'
import {
  readStoredSummary,
  getOrCreateGeneration,
  type SummaryRequest,
} from '@/lib/summary-generate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
// AI generation can take 5-10s. Cache hits are <100ms. 15s ceiling
// prevents runaway AI calls from burning Fluid Compute CPU.
export const maxDuration = 15

/**
 * POST/GET /api/summary — the app's on-demand neutral-summary endpoint.
 *
 * The generation pipeline itself lives in src/lib/summary-generate.ts
 * (shared with the server-rendered /story pages and the cron refresh's
 * pre-generation) — this route is the thin HTTP wrapper with identical
 * behaviour to the pre-extraction version.
 */

/** Edge-cache a FOUND summary response (Fluid CPU).
 *
 * A stored summary is immutable content keyed by topicId — every visitor
 * asking for the same topic gets the same bytes. The 5-min s-maxage +
 * stale-while-revalidate means repeat opens (back button, second device,
 * cold service worker) are served from the Vercel CDN without running
 * the function or reading Firebase. The SW already caches this client-
 * side; this covers the cross-device / cold-SW case. 404s are never
 * cached (default) so a topic that gets summarized later is found on the
 * next request — behaviour unchanged.
 */
function withEdgeCache(res: NextResponse): NextResponse {
  res.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
  return res
}

/**
 * GET /api/summary?topicId=xxx
 *
 * Returns a cached summary from memory or Firebase. Does NOT generate
 * new summaries — that's POST's job.
 *
 * This GET endpoint exists so the Service Worker can cache it with SWR
 * (the SW only caches GET requests, not POST). When the user is OFFLINE
 * and opens a topic they've viewed before, the SW serves the cached GET
 * response instantly — the neutral summary works offline.
 *
 * If the summary doesn't exist yet, returns 404 (client falls back to
 * POST which generates it).
 */
export async function GET(req: NextRequest) {
  const topicId = req.nextUrl.searchParams.get('topicId')
  if (!topicId) {
    return NextResponse.json(
      { error: 'Missing topicId query param' },
      { status: 400 },
    )
  }

  const stored = await readStoredSummary(topicId)
  if (stored) {
    return withEdgeCache(
      NextResponse.json({
        topicId,
        summary: stored.summary,
        cached: true,
        source: stored.source,
      }),
    )
  }

  // Not found — client should POST to generate.
  return NextResponse.json(
    { error: 'Summary not yet generated', topicId },
    { status: 404 },
  )
}

/**
 * POST /api/summary
 *
 * Generates a neutral, in-depth summary of a news topic.
 *
 * Caching layers (fastest to slowest):
 *   1. In-process Map (2h TTL) — instant, per-server-instance
 *   2. Firebase Realtime Database — ~200ms, shared across ALL instances
 *   3. Generate fresh (LLM or extractive fallback)
 *
 * Once generated, a summary is persisted to Firebase so every subsequent
 * visitor (on any server) gets it instantly without re-running the LLM.
 * This saves API costs and makes the detail page load fast for everyone.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as SummaryRequest
    if (!body.topicId || !body.title) {
      return NextResponse.json(
        { error: 'Missing required fields: topicId, title' },
        { status: 400 },
      )
    }

    // ── If no articles AND no topicSummary, look up the topic from Firebase ──
    // This happens when the topic was loaded from a slim=1 feed (articles
    // stripped for size). The client sends topicId + title but no article
    // content. Instead of returning 400, we fetch the full topic from
    // Firebase (archive first, then cache categories) and use its articles.
    if (!body.articles?.length && !body.topicSummary) {
      console.log(`[api/summary] No articles + no topicSummary for ${body.topicId} — fetching from Firebase...`)
      const fetchedTopic = await findTopicAnywhere(body.topicId)
      if (fetchedTopic) {
        body.articles = (fetchedTopic.articles || []).slice(0, 12).map((a) => ({
          title: a.title,
          description: a.description,
          sourceName: a.sourceName,
          leaning: a.leaning,
        }))
        body.topicSummary = fetchedTopic.summary || ''
        console.log(`[api/summary] Found topic in Firebase: ${body.articles.length} articles, topicSummary: ${body.topicSummary ? 'yes' : 'no'}`)
      }
      // If still no articles + no topicSummary after Firebase lookup,
      // we can't generate anything — return 422 (not 400) so the client
      // knows this is a content issue, not a bad request.
      if (!body.articles?.length && !body.topicSummary) {
        return NextResponse.json(
          { error: 'Topic not found in Firebase — no content available', topicId: body.topicId },
          { status: 422 },
        )
      }
    }

    // 1-2. Stored summary (memory → Firebase, template-aware).
    const stored = await readStoredSummary(body.topicId)
    if (stored) {
      return NextResponse.json({
        topicId: body.topicId,
        summary: stored.summary,
        cached: true,
        source: stored.source,
      })
    }

    // 3. Generate fresh (deduplicated per-topic by the shared lib).
    const result = await getOrCreateGeneration(body)

    // If summary generation returned null (no articles + no topicSummary),
    // return a 422 so the client knows to hide the summary section
    // instead of showing "Could not generate summary".
    if (!result) {
      return NextResponse.json(
        { error: 'No content available to generate summary', topicId: body.topicId },
        { status: 422 },
      )
    }
    return NextResponse.json({
      topicId: body.topicId,
      summary: result.summary,
      cached: false,
      source: result.fallback ? 'extractive-fallback' : 'generated',
      fallback: result.fallback,
    })
  } catch (err) {
    console.error('[api/summary] error:', err)
    return NextResponse.json(
      { error: 'Failed to generate summary', detail: String(err) },
      { status: 500 },
    )
  }
}
