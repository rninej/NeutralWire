/**
 * usage-meter-edge.ts — Edge-runtime page-hit counter for middleware.
 *
 * Companion to src/lib/usage-meter.ts (which is Node-only because it uses
 * process.cpuUsage + the firebase-server module). Middleware runs on the
 * Edge runtime, so this module is dependency-free: it counts PAGE
 * navigations (not /api — those are metered by the route wrapper) by
 * path class and UA class, and flushes one tiny PATCH per ~15s to the
 * same usageMeter/<day> Firebase node under pages/<instanceId>.
 *
 * Why counts (not timings): Edge middleware cannot observe the
 * downstream page render — NextResponse.next() returns immediately.
 * The COUNT tells us how many page renders (SSR/ISR) Vercel executed
 * per day and who asked for them (user vs bot vs prerender); combining
 * that with Vercel's own per-function CPU graph gives the render share
 * of the 1h/day. Route-level CPU comes from usage-meter.ts.
 *
 * Kill switch: USAGE_METER_OFF=1.
 */

const DB_URL =
  process.env.FB_DB_URL ||
  'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'

const OFF = typeof process !== 'undefined' && process.env.USAGE_METER_OFF === '1'
const FLUSH_MIN_INTERVAL_MS = 15_000

const EDGE_INSTANCE_ID =
  'E' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

const BOT_UA =
  /googlebot|bingbot|slurp|duckduckbot|yandexbot|baiduspider|facebookexternalhit|twitterbot|linkedinbot|semrushbot|ahrefsbot|mj12bot|petalbot|dotbot|applebot|google-inspectiontool|gptbot|claudebot|ccbot|perplexitybot|bytespider|amazonbot/i

const agg: Record<string, number> = {}
const sources: Record<string, number> = {}
let lastFlush = 0
let dirty = false

/** Bucket a pathname into a page class (kept coarse — counts, not logs). */
function classifyPath(pathname: string): string {
  if (pathname === '/') return 'page:home'
  if (pathname.startsWith('/story/')) return 'page:story'
  if (pathname.startsWith('/debug')) return 'page:debug'
  if (pathname.startsWith('/subscribe')) return 'page:subscribe'
  if (pathname.startsWith('/privacy')) return 'page:privacy'
  if (pathname.startsWith('/_next')) return 'page:_next'
  return 'page:other'
}

function classifyUa(ua: string): string {
  if (!ua) return 'empty'
  const lower = ua.toLowerCase()
  if (lower.includes('cron-job.org')) return 'extcron'
  if (BOT_UA.test(ua)) return 'bot'
  if (/^(python-requests|curl|wget|scrapy|go-httpclient|java|okhttp|node-fetch|axios|postman)/i.test(ua.trim())) {
    return 'script'
  }
  return 'user'
}

/** Middleware calls this for every non-API navigation it passes through. */
export function trackPageHit(pathname: string, userAgent: string): void {
  if (OFF) return
  const cls = classifyPath(pathname)
  agg[cls] = (agg[cls] || 0) + 1
  const src = classifyUa(userAgent)
  sources[src] = (sources[src] || 0) + 1
  dirty = true
}

/**
 * Flush (rate-limited). Called by middleware after a navigation — when the
 * 15s window is open this is a no-op, so at most ~5,700 tiny PATCHes per
 * day per edge instance worst-case, realistically a few hundred.
 */
export async function flushPages(): Promise<void> {
  if (OFF || !dirty) return
  const now = Date.now()
  if (now - lastFlush < FLUSH_MIN_INTERVAL_MS) return
  lastFlush = now
  dirty = false
  try {
    const day = new Date().toISOString().slice(0, 10)
    const body = {
      [`pages/${EDGE_INSTANCE_ID}`]: {
        counts: agg,
        sources,
        updatedAt: now,
      },
    }
    await fetch(`${DB_URL}/${'usageMeter'}/${day}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    })
  } catch {
    dirty = true // retry on a later navigation
  }
}
