import { NextResponse } from 'next/server'

/**
 * bot-gate.ts — the Nov 17, 2026 Fluid Active CPU fix.
 *
 * THE METER DATA (usageMeter/2026-11-16, deployed Nov 15/16): of the day's
 * ~5,160 metered requests, 4,664 (90%) came from crawler bots, and the two
 * biggest in-route CPU burners were almost entirely bot-driven:
 *
 *   /api/refresh   359,572 cpuMs (33% of in-route CPU) — 27 BOT hits,
 *                  each running a FULL 21-24s RSS/GDELT re-aggregation.
 *                  Source: the page-client auto-heal effect fires
 *                  /api/refresh ~12s after any render whose feed was
 *                  stale — including Googlebot's JS renders of the home
 *                  page. Every bot render = one full aggregation.
 *   /api/news      474,178 cpuMs (44%) — 1,955 bot hits; the 121 stale-room
 *                  after() re-aggregation tails (1.9s of CPU each) were
 *                  triggered by whoever happened to view a stale room —
 *                  92% bots.
 *   /api/video     55,357 cpuMs — 217 of 229 hits bots.
 *
 * Bots get NOTHING from these data endpoints: crawlers index the SSR HTML
 * (story pages and the home shell are fully server-rendered), not the JSON
 * the hydrated client fetches. Serving crawlers full re-aggregations is
 * pure waste — ~85-90% of the 1hr/day Fluid Active CPU burn.
 *
 * GATE DESIGN (deliberately conservative):
 *   - Only HARD-gates routes whose client call sites are already wrapped
 *     in try/catch (verified: page_client bgRefresh + heal effect,
 *     mesh-relay `.catch(() => null)`, video-player/preview everywhere),
 *     so a 204 empty-body cannot crash a render.
 *   - /api/news is NOT hard-gated (Googlebot's render needs the feed JSON
 *     to index the home page) — bots get the cached payload but never
 *     trigger the background re-aggregation tail, and get a longer CDN
 *     TTL so the edge serves their repeats without hitting the function.
 *   - cron-job.org (extcron), Vercel cron headers and the public API
 *     (/api/v1/feed) are never affected: their UAs don't match.
 *   - metering is unaffected: trackRequest wraps OUTSIDE the gate, so
 *     tomorrow's usage report still counts bot hits (now ~0ms each) —
 *     the before/after delta in the same day-shape is the proof.
 */

// Search-engine / scraper / preview-bot UAs. Matches the meter's
// classifySource 'bot' family plus the headless/preview renderers whose
// fetches cost the same function CPU.
const BOT_GATE_UA =
  /googlebot|google-inspectiontool|apis-google|bingbot|slurp|duckduckbot|yandexbot|baiduspider|facebookexternalhit|facebookbot|twitterbot|linkedinbot|semrushbot|ahrefsbot|mj12bot|petalbot|dotbot|applebot|applebot-extended|gptbot|chatgpt-user|claudebot|claude-web|ccbot|perplexitybot|bytespider|amazonbot|discordbot|discordapp|slackbot|slack-url-probe|telegrambot|whatsapp|embedly|vkshare|skypeuripreview|jetbot|headlesschrome|lighthouse|puppeteer|playwright|phantomjs|screaming frog|sitebulb|seobility|zgrab|whatweb|serpstatbot|dataforseo|ionico|spider|crawl/i

/**
 * True when the request comes from a crawler bot. An absent UA is NOT
 * treated as a bot (Vercel-internal and some legit clients send none) —
 * bots always announce themselves.
 */
export function isBotRequest(req: {
  headers?: Headers | Record<string, string | string[] | undefined>
}): boolean {
  try {
    const hs = req.headers
    if (!hs) return false
    const ua =
      typeof (hs as Headers).get === 'function'
        ? (hs as Headers).get('user-agent') || ''
        : ((hs as Record<string, string | string[] | undefined>)['user-agent'] as
              | string
              | undefined) || ''
    if (!ua) return false
    return BOT_GATE_UA.test(ua)
  } catch {
    return false
  }
}

/**
 * Wrap a route handler: bot UAs get an instant 204 (no aggregation, no
 * Firebase read, no after() tail — near-zero CPU) and everyone else runs
 * the original handler unchanged. Place OUTSIDE trackRequest so gated
 * hits are still metered:
 *
 *   export const GET = trackRequest('api/x', botGate(GET$))
 */
export function botGate<
  T extends (req: any, ...rest: any[]) => Promise<Response>,
>(handler: T): T {
  const gated = async function (this: unknown, req: any, ...rest: any[]): Promise<Response> {
    if (isBotRequest(req)) {
      return new NextResponse(null, {
        status: 204,
        headers: {
          'x-nw-bot-gate': '1',
          'Cache-Control': 'no-store',
        },
      })
    }
    return handler.call(this, req, ...rest)
  } as unknown as T
  return gated
}
