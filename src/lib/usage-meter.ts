/**
 * usage-meter.ts — EMERGENCY usage attribution meter (Nov 16, 2026).
 *
 * Owner report: Vercel Fluid Active CPU climbing ~1 hour/day (rolling 30-day
 * counter at 21h vs the 4h Hobby fair-use cap) with no attribution. This
 * module makes every serverless execution COUNT ITSELF so tomorrow's
 * analysis can answer "which component takes how much" with real numbers
 * that add up to the day's total.
 *
 * What is measured (per UTC day, per server instance):
 *   - Every API route invocation: wall ms + process.cpuUsage() delta (the
 *     closest in-function proxy for Vercel's "Active CPU" — JSON parsing,
 *     clustering, crypto, string building all show up here; pure I/O waits
 *     do not), response status, Firebase bytes downloaded during the call,
 *     and the trigger source (extcron / vcron / usercron / bot / user / …).
 *   - after() TAILS separately — routes that respond fast then keep
 *     working post-response (cron/refresh-all, api/news, cron/digest) are
 *     where maxDuration gets burned; beginTail()/endTail() capture that
 *     span, attributed to the same route under source 'tail'.
 *   - STAGES inside the heavy libs (news-cache aggregation, AI calls,
 *     pre-generation) via trackStage()/meterStage().
 *   - Individual AI provider requests (provider/model, ms, ok) via
 *     trackAiCall() — the quota-burn ledger.
 *   - RUN records (recordRun) — one small node per significant event
 *     (a refresh tick, an aggregation, a pre-gen wave) with details.
 *
 * Storage: Firebase RTDB node usageMeter/<YYYY-MM-DD>/…, written PER
 * INSTANCE (usageMeter/<day>/routes/<route>/<instanceId>) so concurrent
 * instances never clobber each other; the report endpoint sums them.
 * Writes are tiny PATCHes rate-limited to one per 10s per instance —
 * the meter must never become a burner itself.
 *
 * Kill switch: USAGE_METER_OFF=1 disables all Firebase writes.
 */

import { firebasePatch, firebaseWrite, getFirebaseStats } from '@/lib/firebase-server'

const ROOT = 'usageMeter'
const FLUSH_MIN_INTERVAL_MS = 10_000
const SLOW_SAMPLE_MS = 3_000
const MAX_SLOW_PER_DAY = 80
const MAX_RUN_RECORDS_PER_ROUTE = 60
const MAX_LOCAL_DAYS = 2

const OFF = process.env.USAGE_METER_OFF === '1'

/** Stable id for this serverless instance (used as the Firebase child key
 *  so parallel instances accumulate instead of overwriting). */
export const USAGE_INSTANCE_ID =
  Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)

const INSTANCE_STARTED_AT = Date.now()

// ── helpers ──────────────────────────────────────────────────────────

/** RTDB keys may not contain . # $ / [ ] — sanitize route/stage keys. */
function keySafe(k: string): string {
  return (
    k
      .replace(/[.#$/[\]]/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 90) || 'unknown'
  )
}

/** UTC day key, e.g. 2026-11-16 (dashes are legal RTDB key chars). */
function dayKey(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** process.cpuUsage() in ms (user+system), or null off-Node. */
function cpuNow(): number | null {
  try {
    if (typeof process !== 'undefined' && typeof process.cpuUsage === 'function') {
      const u = process.cpuUsage()
      return (u.user + u.system) / 1000
    }
  } catch {
    /* ignore */
  }
  return null
}

function firebaseBytesNow(): number | null {
  try {
    return getFirebaseStats().sessionDownloadBytes
  } catch {
    return null
  }
}

// ── in-memory day records ────────────────────────────────────────────

interface SourceAgg {
  count: number
  wallMs: number
}
interface StageAgg {
  count: number
  ms: number
}
interface RouteAgg {
  count: number
  wallMs: number
  cpuMs: number
  maxWallMs: number
  fbBytes: number
  status: Record<string, number>
  bySource: Record<string, SourceAgg>
  stages: Record<string, StageAgg>
}

interface DayRecord {
  routes: Record<string, RouteAgg>
  ai: Record<string, { calls: number; ok: number; ms: number }>
  aiModels: Record<string, { calls: number; ok: number; ms: number }>
  dirty: boolean
  runCounts: Record<string, number>
  slowCount: number
}

const DAYS = new Map<string, DayRecord>()

function day(now: number = Date.now()): DayRecord {
  const k = dayKey(now)
  let d = DAYS.get(k)
  if (!d) {
    d = { routes: {}, ai: {}, aiModels: {}, dirty: false, runCounts: {}, slowCount: 0 }
    DAYS.set(k, d)
    // Keep only the newest MAX_LOCAL_DAYS local days (memory hygiene).
    const keys = Array.from(DAYS.keys()).sort()
    while (keys.length > MAX_LOCAL_DAYS) {
      const drop = keys.shift()
      if (drop === undefined) break
      DAYS.delete(drop)
    }
  }
  return d
}

function ensureRoute(d: DayRecord, route: string): RouteAgg {
  let r = d.routes[route]
  if (!r) {
    r = d.routes[route] = {
      count: 0,
      wallMs: 0,
      cpuMs: 0,
      maxWallMs: 0,
      fbBytes: 0,
      status: {},
      bySource: {},
      stages: {},
    }
  }
  return r
}

// ── trigger-source classification ────────────────────────────────────

const BOT_UA =
  /googlebot|bingbot|slurp|duckduckbot|yandexbot|baiduspider|facebookexternalhit|twitterbot|linkedinbot|semrushbot|ahrefsbot|mj12bot|petalbot|dotbot|applebot|google-inspectiontool|gptbot|claudebot|ccbot|perplexitybot|bytespider|amazonbot/i
const SCRIPT_UA =
  /^(python-requests|curl|wget|scrapy|go-httpclient|java|okhttp|node-fetch|axios|postman)/i

/**
 * Classify WHO caused this request. The distinction matters for the CPU
 * audit: 'extcron' (cron-job.org secret), 'vcron' (vercel.json schedule),
 * 'usercron' (visitor lease), 'bot' (crawlers), 'tail' (after() tails).
 */
export function classifySource(req: unknown): string {
  try {
    const r = req as {
      headers?: Headers | Record<string, string | string[] | undefined>
      url?: string
      nextUrl?: { searchParams?: URLSearchParams }
    }
    const h = (name: string): string => {
      const hs = r.headers
      if (!hs) return ''
      if (typeof (hs as Headers).get === 'function') return (hs as Headers).get(name) || ''
      const rec = hs as Record<string, string | string[] | undefined>
      const v = rec[name] ?? rec[name.toLowerCase()]
      return Array.isArray(v) ? v[0] || '' : v || ''
    }
    const ua = h('user-agent')
    if (ua.toLowerCase().includes('cron-job.org') || ua.toLowerCase().includes('cronjob')) {
      return 'extcron'
    }
    if (h('x-vercel-cron') || h('x-vercel-cron-job')) return 'vcron'
    if (r.nextUrl?.searchParams?.has?.('lease')) return 'usercron'
    const url = r.url || ''
    if (/[?&]lease=/.test(url)) return 'usercron'
    if (h('x-nextjs-prerender')) return 'prerender'
    if (BOT_UA.test(ua)) return 'bot'
    if (!ua || SCRIPT_UA.test(ua.trim())) return 'script'
    return 'user'
  } catch {
    return 'unknown'
  }
}

// ── core recording ───────────────────────────────────────────────────

function record(
  route: string,
  wallMs: number,
  cpuMs: number,
  src: string,
  status: string,
  fb0: number | null,
): void {
  const d = day()
  const r = ensureRoute(d, route)
  r.count++
  r.wallMs += wallMs
  r.cpuMs += cpuMs
  if (wallMs > r.maxWallMs) r.maxWallMs = wallMs
  r.status[status] = (r.status[status] || 0) + 1
  if (fb0 !== null) {
    const fbNow = firebaseBytesNow()
    if (fbNow !== null) r.fbBytes += Math.max(0, fbNow - fb0)
  }
  let s = r.bySource[src]
  if (!s) s = r.bySource[src] = { count: 0, wallMs: 0 }
  s.count++
  s.wallMs += wallMs
  d.dirty = true

  if (wallMs >= SLOW_SAMPLE_MS && d.slowCount < MAX_SLOW_PER_DAY) {
    d.slowCount++
    if (!OFF) {
      void firebaseWrite(`${ROOT}/${dayKey()}/slow/${USAGE_INSTANCE_ID}-${d.slowCount}`, {
        route,
        wallMs,
        cpuMs: Math.round(cpuMs),
        src,
        ts: Date.now(),
      })
    }
  }
}

// ── public API: route wrapper ────────────────────────────────────────

 
/**
 * Wrap an API route handler (GET/POST/…) so every invocation meters
 * wall time + CPU + Firebase bytes + source, e.g.
 *
 *   async function GET$(req: NextRequest) { … }
 *   export const GET = trackRequest('api/news', GET$)
 */
export function trackRequest(
  routeKey: string,
  handler: (...args: any[]) => Promise<Response>,
): (...args: any[]) => Promise<Response> {
  const safe = keySafe(routeKey)
  return async function metered(this: unknown, ...args: any[]): Promise<Response> {
    const wall0 = Date.now()
    const cpu0 = cpuNow()
    const fb0 = firebaseBytesNow()
    let status = 'error'
    try {
      const res = await handler.apply(this, args)
      status = String(res.status)
      return res
    } catch (err) {
      status = 'throw'
      throw err
    } finally {
      const wall = Date.now() - wall0
      const cpu = cpuNow()
      record(
        safe,
        wall,
        cpu !== null && cpu0 !== null ? Math.max(0, cpu - cpu0) : 0,
        classifySource(args[0]),
        status,
        fb0,
      )
      void flush()
    }
  }
}

// ── public API: after() tails ────────────────────────────────────────

const activeTails = new Map<string, { wall: number; cpu: number | null }>()

/**
 * Mark the START of post-response work (call right before registering
 * `after(async () => …)`). The handler has already returned by then —
 * without this, a 60s maxDuration tail would be invisible to the meter.
 */
export function beginTail(routeKey: string): void {
  activeTails.set(keySafe(routeKey), { wall: Date.now(), cpu: cpuNow() })
}

/** Mark the END of the post-response work; records it under source 'tail'. */
export function endTail(routeKey: string): void {
  const safe = keySafe(routeKey)
  const t = activeTails.get(safe)
  if (!t) return
  activeTails.delete(safe)
  const wall = Date.now() - t.wall
  const cpu = cpuNow()
  trackStage(safe, 'after-tail', wall)
  record(
    safe,
    wall,
    cpu !== null && t.cpu !== null ? Math.max(0, cpu - t.cpu) : 0,
    'tail',
    'tail',
    null,
  )
  void flush()
}

// ── public API: stages ────────────────────────────────────────────────

/** Accumulate a named stage's time/count under a route. */
export function trackStage(routeKey: string, stage: string, ms: number, count = 1): void {
  const d = day()
  const r = ensureRoute(d, keySafe(routeKey))
  const st = keySafe(stage)
  let s = r.stages[st]
  if (!s) s = r.stages[st] = { count: 0, ms: 0 }
  s.count += count
  s.ms += ms
  d.dirty = true
}

/** Run fn(), recording its duration as a stage. Never swallows errors. */
export async function meterStage<T>(
  routeKey: string,
  stage: string,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now()
  try {
    return await fn()
  } finally {
    trackStage(routeKey, stage, Date.now() - t0)
  }
}

// ── public API: AI ledger ────────────────────────────────────────────

/** One provider HTTP request: provider ('gemini'|'groq'|'openrouter'), model, ms, ok. */
export function trackAiCall(provider: string, model: string, ms: number, ok: boolean): void {
  const d = day()
  let p = d.ai[provider]
  if (!p) p = d.ai[provider] = { calls: 0, ok: 0, ms: 0 }
  p.calls++
  if (ok) p.ok++
  p.ms += ms

  const mk = keySafe(`${provider}/${model}`)
  let m = d.aiModels[mk]
  if (!m) m = d.aiModels[mk] = { calls: 0, ok: 0, ms: 0 }
  m.calls++
  if (ok) m.ok++
  m.ms += ms
  d.dirty = true
}

// ── public API: run records ──────────────────────────────────────────

/**
 * Record one significant EVENT (a refresh tick, an aggregation run, a
 * pre-gen wave). Small fire-and-forget PUT under
 * usageMeter/<day>/runs/<route>/<instance>-<seq>; capped per route so a
 * hot path can never spam the DB.
 */
export function recordRun(routeKey: string, data: Record<string, unknown>): void {
  if (OFF) return
  const d = day()
  const safe = keySafe(routeKey)
  const n = (d.runCounts[safe] = (d.runCounts[safe] || 0) + 1)
  if (n > MAX_RUN_RECORDS_PER_ROUTE) return
  void firebaseWrite(`${ROOT}/${dayKey()}/runs/${safe}/${USAGE_INSTANCE_ID}-${n}`, {
    ...data,
    inst: USAGE_INSTANCE_ID,
    ts: Date.now(),
  })
}

// ── flush ────────────────────────────────────────────────────────────

let lastFlush = 0
let flushing = false

/**
 * Persist dirty day aggregates to Firebase. Rate-limited to one write per
 * 10s per instance; body is one small PATCH with per-instance child keys
 * (no cross-instance clobbering, no per-request writes). Never throws.
 */
export async function flush(): Promise<void> {
  if (OFF) return
  if (flushing) return
  const now = Date.now()
  if (now - lastFlush < FLUSH_MIN_INTERVAL_MS) return
  lastFlush = now
  flushing = true
  try {
    for (const [dk, d] of DAYS) {
      if (!d.dirty) continue
      d.dirty = false
      const body: Record<string, unknown> = {}
      let cpuSum = 0
      let wallSum = 0
      let reqSum = 0
      for (const [rk, agg] of Object.entries(d.routes)) {
        body[`routes/${rk}/${USAGE_INSTANCE_ID}`] = {
          count: agg.count,
          wallMs: agg.wallMs,
          cpuMs: Math.round(agg.cpuMs),
          maxWallMs: agg.maxWallMs,
          fbBytes: agg.fbBytes,
          status: agg.status,
          bySource: agg.bySource,
          stages: agg.stages,
          updatedAt: Date.now(),
        }
        cpuSum += agg.cpuMs
        wallSum += agg.wallMs
        reqSum += agg.count
      }
      if (Object.keys(d.ai).length > 0 || Object.keys(d.aiModels).length > 0) {
        body[`ai/${USAGE_INSTANCE_ID}`] = {
          providers: d.ai,
          models: d.aiModels,
          updatedAt: Date.now(),
        }
      }
      body[`instances/${USAGE_INSTANCE_ID}`] = {
        startedAt: INSTANCE_STARTED_AT,
        env: process.env.VERCEL_ENV || process.env.NODE_ENV || 'local',
        node: typeof process !== 'undefined' ? process.version : 'unknown',
        totals: {
          requests: reqSum,
          wallMs: wallSum,
          cpuMs: Math.round(cpuSum),
        },
        updatedAt: Date.now(),
      }
      if (Object.keys(body).length > 1 || (Object.keys(body).length === 1 && !body[`instances/${USAGE_INSTANCE_ID}`])) {
        const ok = await firebasePatch(`${ROOT}/${dk}`, body)
        if (!ok) {
          // failed flush → try again on the next trigger
          d.dirty = true
          lastFlush = 0
        }
      }
    }
  } catch {
    /* never break a route because of the meter */
  } finally {
    flushing = false
  }
}

// ── public API: local snapshot (for the report endpoint) ─────────────

/** This instance's un-flushed in-memory day records (merged into the
 *  report so live numbers are never more than one flush window stale). */
export function localSnapshot(): Record<string, DayRecord> {
  const out: Record<string, DayRecord> = {}
  for (const [dk, d] of DAYS) {
    out[dk] = {
      routes: Object.fromEntries(
        Object.entries(d.routes).map(([rk, agg]) => [
          rk,
          { ...agg, cpuMs: Math.round(agg.cpuMs) },
        ]),
      ),
      ai: d.ai,
      aiModels: d.aiModels,
      dirty: d.dirty,
      runCounts: d.runCounts,
      slowCount: d.slowCount,
    }
  }
  return out
}
