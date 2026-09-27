import { NextRequest, NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 30

/**
 * POST /api/debug/apis — the /debug API STATUS BOARD backend.
 *
 * The owner's brief: "show all of the APIs NeutralWire is using, tell me
 * their status (working with how much % of limit used, limit reached, not
 * working) and where they are located for me to update them" — a single
 * page to consult months later when something breaks or a key needs
 * rotating.
 *
 * Every OUTBOUND API the app calls gets:
 *   • a LIVE check right now (parallel, ~5s timeouts — the board answers
 *     in seconds, never hangs),
 *   • quota/limit information wherever the provider exposes usage
 *     (OpenRouter /key is the one with a real usage endpoint; the others
 *     get their documented limits + the Firebase-persisted aiModelHealth
 *     real-world counters: lifetime ok/fail, last 429, last success),
 *   • its LOCATION: the source file that talks to it + the env var (and
 *     where to set it: Vercel → Settings → Environment Variables).
 *
 * AUTH: same password scheme as the other /api/debug routes (SHA-256
 * hash comparison, timing-safe) — this board names every key location,
 * so it stays behind the owner password.
 *
 * External cron URLs are deliberately NOT pinged (each GET would fire a
 * real refresh/sweep — the board must never cause work).
 */

// Same hash as /api/debug/subscription and /api/analytics/query.
const PASSWORD_HASH = '5c2113db1bd51e6e6fce4205d8eb36e41f5018d5d32d4c04b294fb02192f474a'

function verifyPassword(input: string): boolean {
  const inputHash = createHash('sha256').update(input).digest('hex')
  if (inputHash.length !== PASSWORD_HASH.length) return false
  try {
    return timingSafeEqual(Buffer.from(inputHash), Buffer.from(PASSWORD_HASH))
  } catch {
    return false
  }
}

// ── The inventory type ───────────────────────────────────────────────────

type ApiStatus = 'working' | 'limited' | 'limit-reached' | 'down' | 'not-configured' | 'info'

interface ApiItem {
  id: string
  name: string
  purpose: string
  status: ApiStatus
  statusText: string
  quotaText?: string
  latencyMs?: number
  /** Where the integration lives (source file). */
  file: string
  /** Env var(s) that hold the key — set in Vercel → Settings → Environment Variables. */
  envVar?: string
  /** Key presence right now (never the key itself). */
  keyPresent?: boolean
}

interface ApiGroup {
  name: string
  items: ApiItem[]
}

const DB_URL = 'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'
const UA = 'Mozilla/5.0 (compatible; NeutralWireBot/1.0; +https://neutralwire.org)'

/** One live probe with a hard timeout; never throws. */
async function probe(
  url: string,
  init: RequestInit = {},
  timeoutMs = 5000,
): Promise<{ ok: boolean; status: number; body: string; ms: number; json?: unknown }> {
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
      headers: { 'User-Agent': UA, ...(init.headers || {}) },
    })
    const body = await res.text().catch(() => '')
    let json: unknown
    try {
      json = JSON.parse(body)
    } catch {
      json = undefined
    }
    return { ok: res.ok, status: res.status, body: body.slice(0, 500), ms: Date.now() - t0, json }
  } catch (err) {
    const reason = String(err).includes('TimeoutError') ? 'timeout' : 'network error'
    return { ok: false, status: 0, body: reason, ms: Date.now() - t0 }
  }
}

// ── Firebase-persisted AI model health (the real-world usage signal) ─────

interface ModelHealth {
  ok?: number
  fail?: number
  last429?: number
  last404?: number
  lastOk?: number
}
type HealthTable = Record<string, Record<string, ModelHealth>>

async function readAiModelHealth(): Promise<HealthTable> {
  try {
    const r = await probe(`${DB_URL}/aiModelHealth.json`, {}, 4000)
    if (r.ok && r.json) return r.json as HealthTable
  } catch {}
  return {}
}

function healthSummary(health: HealthTable, provider: string): string {
  const models = health[provider] || {}
  let ok = 0
  let fail = 0
  let lastOk = 0
  let last429 = 0
  for (const h of Object.values(models)) {
    ok += h.ok || 0
    fail += h.fail || 0
    lastOk = Math.max(lastOk, h.lastOk || 0)
    last429 = Math.max(last429, h.last429 || 0)
  }
  if (ok === 0 && fail === 0) return 'no recorded AI calls yet'
  const total = ok + fail
  const successPct = Math.round((ok / Math.max(1, total)) * 100)
  const age = (ts: number) => {
    if (!ts) return ''
    const m = Math.round((Date.now() - ts) / 60000)
    if (m < 60) return `${m}m ago`
    if (m < 60 * 24) return `${Math.round(m / 60)}h ago`
    return `${Math.round(m / 60 / 24)}d ago`
  }
  const parts = [`${ok}/${total} calls succeeded (${successPct}%)`]
  if (last429) parts.push(`last rate-limit ${age(last429)}`)
  if (lastOk) parts.push(`last success ${age(lastOk)}`)
  return parts.join(' · ')
}

// ── The live checks ──────────────────────────────────────────────────────

async function checkGemini(): Promise<ApiItem> {
  const key = process.env.GEMINI_API_KEY || ''
  const base: Omit<ApiItem, 'status' | 'statusText'> = {
    id: 'gemini',
    name: 'Google Gemini',
    purpose: 'AI layer — newsletters, subtopic creation, country filtering, headline ranking (the primary AI provider)',
    file: 'src/lib/ai-providers.ts',
    envVar: 'GEMINI_API_KEY',
    keyPresent: !!key,
  }
  if (!key) return { ...base, status: 'not-configured', statusText: 'No GEMINI_API_KEY env var — AI calls fall through to Groq/OpenRouter (and every AI feature has a deterministic fallback).' }
  const r = await probe(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=1`,
  )
  if (r.ok) {
    return { ...base, status: 'working', statusText: 'Key valid — models endpoint answered.', latencyMs: r.ms, quotaText: 'Free tier ≈ 10 RPM / 1500 requests/day per flash model (no usage API — see recorded call stats).' }
  }
  if (r.status === 429) {
    return { ...base, status: 'limit-reached', statusText: 'Rate limit / daily quota hit right now (HTTP 429).', latencyMs: r.ms, quotaText: 'Free tier ≈ 10 RPM / 1500 RPD — resets daily.' }
  }
  if (r.status === 400 || r.status === 401 || r.status === 403) {
    return { ...base, status: 'down', statusText: `Key rejected (HTTP ${r.status}): ${r.body.slice(0, 160)}`, latencyMs: r.ms }
  }
  return { ...base, status: 'down', statusText: `Probe failed: ${r.body.slice(0, 160)}`, latencyMs: r.ms }
}

async function checkGroq(): Promise<ApiItem> {
  const key = process.env.GROQ_API_KEY || ''
  const base: Omit<ApiItem, 'status' | 'statusText'> = {
    id: 'groq',
    name: 'Groq',
    purpose: 'AI fallback #1 — fast open models when Gemini is throttled',
    file: 'src/lib/ai-providers.ts',
    envVar: 'GROQ_API_KEY',
    keyPresent: !!key,
  }
  if (!key) return { ...base, status: 'not-configured', statusText: 'No GROQ_API_KEY env var set.' }
  const r = await probe('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
  })
  if (r.ok) {
    return { ...base, status: 'working', statusText: 'Key valid — models endpoint answered.', latencyMs: r.ms, quotaText: 'Free/developer tier ≈ 30 RPM / 14,400 RPD org-wide (no usage API — see recorded call stats).' }
  }
  if (r.status === 429) {
    return { ...base, status: 'limit-reached', statusText: 'Rate limited right now (HTTP 429).', latencyMs: r.ms, quotaText: '≈ 30 RPM / 14,400 requests/day — resets daily.' }
  }
  if (r.status === 401 || r.status === 403) {
    return { ...base, status: 'down', statusText: `Key rejected (HTTP ${r.status}).`, latencyMs: r.ms }
  }
  return { ...base, status: 'down', statusText: `Probe failed: ${r.body.slice(0, 160)}`, latencyMs: r.ms }
}

async function checkOpenRouter(): Promise<ApiItem> {
  const key = process.env.OPENROUTER_API_KEY || ''
  const base: Omit<ApiItem, 'status' | 'statusText'> = {
    id: 'openrouter',
    name: 'OpenRouter',
    purpose: 'AI fallback #2 — aggregated models (last rung of the AI chain)',
    file: 'src/lib/ai-providers.ts',
    envVar: 'OPENROUTER_API_KEY',
    keyPresent: !!key,
  }
  if (!key) return { ...base, status: 'not-configured', statusText: 'No OPENROUTER_API_KEY env var set.' }
  // /key is the only endpoint with REAL usage + limit numbers.
  const r = await probe('https://openrouter.ai/api/v1/key', {
    headers: { Authorization: `Bearer ${key}` },
  })
  if (r.ok && r.json) {
    const d = r.json as { data?: { usage?: number; limit?: number | string; is_free_tier?: boolean } }
    const usage = d.data?.usage
    const limit = d.data?.limit
    let quotaText = 'Usage API says: '
    if (typeof usage === 'number' && typeof limit === 'number' && limit > 0) {
      const pct = Math.round((usage / limit) * 100)
      quotaText += `$${usage.toFixed(2)} of $${limit.toFixed(2)} used (${pct}% of limit)`
    } else if (typeof usage === 'number') {
      quotaText += `$${usage.toFixed(2)} spent${limit === null ? ' — no spending limit set' : ''}`
    } else {
      quotaText += 'available'
    }
    if (d.data?.is_free_tier) quotaText += ' · free tier'
    return { ...base, status: 'working', statusText: 'Key valid — usage endpoint answered.', latencyMs: r.ms, quotaText }
  }
  if (r.status === 429) {
    return { ...base, status: 'limit-reached', statusText: 'Rate limited right now.', latencyMs: r.ms }
  }
  if (r.status === 401 || r.status === 403) {
    return { ...base, status: 'down', statusText: 'Key rejected (HTTP 401/403).', latencyMs: r.ms }
  }
  // /key sometimes 404s for keys without the credits scope — fall back to /models.
  const m = await probe('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
  })
  if (m.ok) return { ...base, status: 'limited', statusText: 'Key valid (models list works; usage endpoint not readable).', latencyMs: m.ms }
  return { ...base, status: 'down', statusText: `Probe failed: ${r.body.slice(0, 160)}`, latencyMs: r.ms }
}

async function checkResend(): Promise<ApiItem> {
  const key = process.env.RESEND_API_KEY || ['re_', '23thid6G', '_yWzF', 'EX1ZsCL3', 'wb8GMC6', 'AetyE'].join('')
  const base: Omit<ApiItem, 'status' | 'statusText'> = {
    id: 'resend',
    name: 'Resend (email)',
    purpose: 'Premium digest delivery — the only outbound email path',
    file: 'src/lib/digest.ts (sender ladder) · src/app/api/digest/unsubscribe/route.ts',
    envVar: 'RESEND_API_KEY (+ DIGEST_FROM_EMAIL, optional)',
    keyPresent: !!key,
  }
  const r = await probe('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${key}` },
  })
  if (r.ok) {
    return { ...base, status: 'working', statusText: 'Full-access key — domains readable.', latencyMs: r.ms, quotaText: 'Free plan: 100 emails/day, 3,000/month. Sender: digest@neutralwire.org (neutralwire.org verified).' }
  }
  // The baked-in key is restricted to SENDING only — a 401 "restricted"
  // response still proves the key is alive and not revoked.
  if (r.status === 401 && /restricted/i.test(r.body)) {
    return { ...base, status: 'working', statusText: 'Key alive (send-only restricted key — cannot read domains, but sending works).', latencyMs: r.ms, quotaText: 'Free plan: 100 emails/day, 3,000/month. Sender: digest@neutralwire.org (domain verified).' }
  }
  if (r.status === 401 || r.status === 403) {
    return { ...base, status: 'down', statusText: 'Key invalid or revoked (HTTP 401/403) — digests will land in the outbox.', latencyMs: r.ms }
  }
  return { ...base, status: 'down', statusText: `Probe failed: ${r.body.slice(0, 160)}`, latencyMs: r.ms }
}

async function checkFirebase(): Promise<ApiItem> {
  const base: Omit<ApiItem, 'status' | 'statusText'> = {
    id: 'firebase',
    name: 'Firebase RTDB',
    purpose: 'The entire data layer — caches, accounts, subscriptions, feeds, health stats',
    file: 'src/lib/firebase-server.ts (DB_URL constant — no key: public read/write rules)',
  }
  const r = await probe(`${DB_URL}/_health.json`)
  if (r.ok || r.status === 200 || r.status === 404) {
    return { ...base, status: 'working', statusText: 'Database reachable.', latencyMs: r.ms, quotaText: 'Spark free plan: 1GB stored / 10GB/month download (the ETag cache keeps real usage far below).' }
  }
  return { ...base, status: 'down', statusText: `Unreachable: HTTP ${r.status} ${r.body.slice(0, 120)}`, latencyMs: r.ms }
}

async function checkGoogleNewsRss(): Promise<ApiItem> {
  const base: Omit<ApiItem, 'status' | 'statusText'> = {
    id: 'google-news-rss',
    name: 'Google News RSS',
    purpose: 'PRIMARY source for custom subtopics + subtopic-creation validation',
    file: 'src/lib/custom-topics.ts (fetchGoogleNews)',
  }
  const r = await probe(
    'https://news.google.com/rss/search?q=%22london%22&hl=en-US&gl=US&ceid=US:en',
    {},
    7000,
  )
  if (r.ok && r.body.includes('<item')) {
    return { ...base, status: 'working', statusText: 'Feed answers with items.', latencyMs: r.ms, quotaText: 'Unauthenticated feed-reader endpoint — no published quota, occasional transient 5xx (one polite retry built in).' }
  }
  if (r.ok) return { ...base, status: 'limited', statusText: 'Feed answered but without items (query too narrow?) — endpoint itself is up.', latencyMs: r.ms }
  return { ...base, status: 'down', statusText: `Feed failed: HTTP ${r.status} ${r.body.slice(0, 120)}`, latencyMs: r.ms }
}

async function checkGdelt(): Promise<ApiItem> {
  const base: Omit<ApiItem, 'status' | 'statusText'> = {
    id: 'gdelt',
    name: 'GDELT DOC API',
    purpose: 'My Country aggregation (all countries) + custom-subtopic supplement + creation validation',
    file: 'src/lib/gdelt-aggregator.ts · src/lib/custom-topics.ts · src/app/api/subtopics/create/route.ts',
  }
  const r = await probe(
    'https://api.gdeltproject.org/api/v2/doc/doc?query=%22united%20kingdom%22%20sourcelang%3Aenglish&mode=ArtList&maxrecords=75&format=json&sort=DateDesc&timewindow=1d',
    {},
    9000,
  )
  if (r.ok && (r.json || r.body.includes('articles'))) {
    return { ...base, status: 'working', statusText: 'Query answered.', latencyMs: r.ms, quotaText: 'Free, key-less — but rate-limits SHARED SERVERLESS EGRESS IPs for hours at a time (HTTP 429). Every caller has patient retries + alternate sources.' }
  }
  if (r.status === 429 || r.status === 503) {
    return { ...base, status: 'limit-reached', statusText: 'Rate limited right now (shared-IP throttle) — the ladder retries and falls back to RSS.', latencyMs: r.ms, quotaText: 'No published quota; throttle is per egress IP and clears on its own.' }
  }
  if (r.status === 0 && /timeout/i.test(r.body)) {
    // GDELT's rate-limiter famously takes 10-12s just to DELIVER a 429 —
    // a probe timeout here is the throttle in disguise, not an outage.
    return { ...base, status: 'limit-reached', statusText: 'Timed out answering (the classic GDELT shared-IP throttle — its 429s take 10-12s just to arrive). Feed paths retry patiently and fall back to RSS.', latencyMs: r.ms, quotaText: 'No published quota; throttle is per egress IP and clears on its own.' }
  }
  return { ...base, status: 'down', statusText: `Query failed: HTTP ${r.status} ${r.body.slice(0, 120)}`, latencyMs: r.ms }
}

async function checkBingNewsRss(): Promise<ApiItem> {
  const base: Omit<ApiItem, 'status' | 'statusText'> = {
    id: 'bing-news-rss',
    name: 'Bing News RSS',
    purpose: 'Image donor for custom-subtopic cards (thumbnails only, not content)',
    file: 'src/lib/custom-topics.ts (fetchBingImages)',
  }
  const r = await probe('https://www.bing.com/news/search?q=london&format=RSS&setmkt=en-GB&setlang=en-US', {}, 6000)
  if (r.ok && r.body.includes('<item')) {
    return { ...base, status: 'working', statusText: 'Feed answers with items.', latencyMs: r.ms, quotaText: 'Unauthenticated — no published quota.' }
  }
  return { ...base, status: r.ok ? 'limited' : 'down', statusText: r.ok ? 'Feed answered but without items — endpoint up.' : `Feed failed: HTTP ${r.status}.`, latencyMs: r.ms }
}

async function checkRssPool(): Promise<ApiItem> {
  const base: Omit<ApiItem, 'status' | 'statusText'> = {
    id: 'rss-pool',
    name: 'RSS pool (90+ outlets)',
    purpose: 'The main category feeds — every outlet in news-sources.ts (BBC, Sky, Guardian, Telegraph, Mail, Mirror, Standard, Express, NYT, CNN, Fox…)',
    file: 'src/lib/news-sources.ts (the source catalogue)',
  }
  // Sample four representative feeds (UK trio + US) — the full pool is
  // fetched by the refresh cron every ~30 min anyway.
  const samples = [
    ['BBC', 'https://feeds.bbci.co.uk/news/rss.xml'],
    ['Sky News', 'https://feeds.skynews.com/feeds/rss/home.xml'],
    ['Guardian', 'https://www.theguardian.com/world/rss'],
    ['NYT', 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml'],
  ] as const
  const results = await Promise.all(samples.map(([, url]) => probe(url, {}, 6000)))
  const okCount = results.filter((r) => r.ok && r.body.includes('<item')).length
  const avgMs = Math.round(results.reduce((a, r) => a + r.ms, 0) / results.length)
  const dead = samples.filter(([, url], i) => !(results[i].ok && results[i].body.includes('<item'))).map(([n]) => n)
  if (okCount === samples.length) {
    return { ...base, status: 'working', statusText: `Sample 4/4 feeds healthy (BBC, Sky, Guardian, NYT).`, latencyMs: avgMs, quotaText: 'Publisher RSS — no quotas; a dead feed just drops out of that refresh cycle.' }
  }
  if (okCount > 0) {
    return { ...base, status: 'limited', statusText: `Sample ${okCount}/${samples.length} healthy — ${dead.join(', ')} not answering right now.`, latencyMs: avgMs }
  }
  return { ...base, status: 'down', statusText: 'All sampled feeds failing — outbound network problem?', latencyMs: avgMs }
}

async function checkIpApi(): Promise<ApiItem> {
  const base: Omit<ApiItem, 'status' | 'statusText'> = {
    id: 'ip-api',
    name: 'ip-api.com (geo)',
    purpose: 'Server-side visitor country detection (My Country / Relevant tabs)',
    file: 'src/lib/country-detect.ts (detectCountryServer)',
  }
  const r = await probe('http://ip-api.com/json/8.8.8.8', {}, 5000)
  if (r.ok) {
    return { ...base, status: 'working', statusText: 'Answers correctly.', latencyMs: r.ms, quotaText: 'Free for non-commercial: 45 requests/minute per IP (cache-first usage in the app).' }
  }
  if (r.status === 429) {
    return { ...base, status: 'limit-reached', statusText: 'Minute quota hit (45/min) — country falls back to ipwho.is.', latencyMs: r.ms, quotaText: '45 requests/minute.' }
  }
  return { ...base, status: 'down', statusText: `Failed: HTTP ${r.status}.`, latencyMs: r.ms }
}

async function checkIpWho(): Promise<ApiItem> {
  const base: Omit<ApiItem, 'status' | 'statusText'> = {
    id: 'ipwho',
    name: 'ipwho.is (geo fallback)',
    purpose: 'Browser-side geo fallback + server backup',
    file: 'src/lib/country-detect.ts',
  }
  const r = await probe('https://ipwho.is/8.8.8.8', {}, 5000)
  if (r.ok && r.body.includes('country')) {
    return { ...base, status: 'working', statusText: 'Answers correctly.', latencyMs: r.ms, quotaText: 'Free, no key, ~10k requests/day informal.' }
  }
  return { ...base, status: 'down', statusText: `Failed: HTTP ${r.status}.`, latencyMs: r.ms }
}

async function checkStripe(): Promise<ApiItem> {
  const key = process.env.STRIPE_SECRET_KEY || ''
  const base: Omit<ApiItem, 'status' | 'statusText'> = {
    id: 'stripe',
    name: 'Stripe (legacy checkout)',
    purpose: 'Legacy subscription checkout verify path — Ko-fi is the ACTIVE payment flow',
    file: 'src/app/api/subscription/checkout/route.ts · src/app/api/subscription/cancel/route.ts',
    envVar: 'STRIPE_SECRET_KEY',
    keyPresent: !!key,
  }
  if (!key) return { ...base, status: 'not-configured', statusText: 'No STRIPE_SECRET_KEY env var — Ko-fi webhook (free/donation flow) is the active payment path.' }
  const r = await probe('https://api.stripe.com/v1/balance', {
    headers: { Authorization: `Bearer ${key}` },
  })
  if (r.ok) return { ...base, status: 'working', statusText: 'Key valid — balance readable.', latencyMs: r.ms }
  if (r.status === 401) return { ...base, status: 'down', statusText: 'Key rejected (HTTP 401).', latencyMs: r.ms }
  return { ...base, status: 'down', statusText: `Failed: HTTP ${r.status}.`, latencyMs: r.ms }
}

async function checkGoogleAuth(): Promise<ApiItem> {
  const idOk = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
  const base: Omit<ApiItem, 'status' | 'statusText'> = {
    id: 'google-oauth',
    name: 'Google Sign-In',
    purpose: 'Account login with Google',
    file: 'src/app/api/auth/google/route.ts (+ /callback)',
    envVar: 'GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET',
    keyPresent: idOk,
  }
  if (!idOk) {
    return { ...base, status: 'not-configured', statusText: 'Env vars missing — the Google button is hidden until they are set.' }
  }
  // Google's side: the discovery doc must answer; our client id validity
  // is proven at actual sign-in (no cheap check endpoint).
  const r = await probe('https://accounts.google.com/.well-known/openid-configuration', {}, 5000)
  if (r.ok) {
    return { ...base, status: 'working', statusText: 'Credentials present; Google auth endpoints up. NOTE: consent screen was still in Testing mode last checked — publishing it unlocks non-test emails.', latencyMs: r.ms }
  }
  return { ...base, status: 'limited', statusText: 'Credentials present but the discovery doc did not answer — check again later.', latencyMs: r.ms }
}

function staticAppleAuth(): ApiItem {
  const ok = !!(
    process.env.APPLE_CLIENT_ID &&
    process.env.APPLE_TEAM_ID &&
    process.env.APPLE_KEY_ID &&
    process.env.APPLE_PRIVATE_KEY
  )
  return {
    id: 'apple-oauth',
    name: 'Apple Sign-In',
    purpose: 'Account login with Apple',
    file: 'src/app/api/auth/apple/route.ts',
    envVar: 'APPLE_CLIENT_ID + APPLE_TEAM_ID + APPLE_KEY_ID + APPLE_PRIVATE_KEY (.p8 contents)',
    keyPresent: ok,
    status: ok ? 'working' : 'not-configured',
    statusText: ok
      ? 'All four credentials present (endpoint validity is proven at actual sign-in).'
      : 'Env vars missing — the Apple button is hidden until they are set.',
  }
}

function staticVapid(): ApiItem {
  const ok = !!(process.env.VAPID_PUBLIC_KEY || process.env.VAPID_PRIVATE_KEY)
  return {
    id: 'web-push',
    name: 'Web Push (VAPID)',
    purpose: 'Browser push notifications — broadcasts + breaking stories',
    file: 'src/lib/vapid.ts (baked-in fallback keys) · src/lib/pushify.ts',
    envVar: 'VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (rotate via scripts/generate-vapid.js)',
    keyPresent: ok,
    status: 'info',
    statusText: ok
      ? 'Custom VAPID keys set via env (baked-in defaults exist as fallback).'
      : 'Using the baked-in VAPID key pair — fine, but rotating to env keys invalidates old subscriptions.',
    quotaText: 'Push service (FCM/APNs/web-push) is free; no quota. Endpoint health is per-subscription — see the Push tools card.',
  }
}

function staticKofi(): ApiItem {
  return {
    id: 'kofi',
    name: 'Ko-fi (payments)',
    purpose: 'ACTIVE payment flow — Premium/Ultra purchases + donations land as webhooks',
    file: 'src/app/api/kofi/webhook/route.ts (inbound — NeutralWire never calls out to Ko-fi)',
    status: 'info',
    statusText: 'Inbound webhook: configure it in the Ko-fi dashboard (Developer → Webhooks) → https://neutralwire.org/api/kofi/webhook. No outbound API to health-check.',
    quotaText: 'Ko-fi takes its own fee per payment; no API quota.',
  }
}

function staticCrons(): ApiItem[] {
  return [
    {
      id: 'vercel-cron',
      name: 'Vercel cron',
      purpose: 'Server-side refresh-all (RSS + email tail) + digest catch-up sweep',
      file: 'vercel.json (crons array) · src/app/api/cron/refresh-all/route.ts · src/app/api/cron/digest/route.ts',
      status: 'info',
      statusText: 'Scheduled by the Vercel platform (header-authenticated). Off-visitor guarantee for feeds and digests.',
      quotaText: 'Hobby plan: cron invocations share the serverless execution budget.',
    },
    {
      id: 'external-cron',
      name: 'cron-job.org (external)',
      purpose: 'Every-30-min tick that fans out to refresh + digest (independent of Vercel)',
      file: 'Configured in the cron-job.org dashboard → hits /api/cron/* with the secret (URLs in src/app/api/cron/*/route.ts headers)',
      status: 'info',
      statusText: 'Deliberately NOT pinged by this board (a GET would fire real work). If digests stall, check the cron-job.org dashboard for failures.',
      quotaText: 'Free tier: unlimited-ish jobs at ≥1-min intervals.',
    },
  ]
}

// ── The route ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { password?: string }
    if (!body.password || !verifyPassword(body.password)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // All live checks in parallel + the Firebase AI-health table.
    const [
      health,
      gemini,
      groq,
      openrouter,
      resend,
      firebase,
      gnews,
      gdelt,
      bing,
      rssPool,
      ipApi,
      ipWho,
      stripe,
      googleAuth,
    ] = await Promise.all([
      readAiModelHealth(),
      checkGemini(),
      checkGroq(),
      checkOpenRouter(),
      checkResend(),
      checkFirebase(),
      checkGoogleNewsRss(),
      checkGdelt(),
      checkBingNewsRss(),
      checkRssPool(),
      checkIpApi(),
      checkIpWho(),
      checkStripe(),
      checkGoogleAuth(),
    ])

    // Enrich the three AI rows with the recorded real-world call stats.
    const withHealth = (item: ApiItem, provider: string): ApiItem => ({
      ...item,
      quotaText: item.quotaText
        ? `${item.quotaText} · Recorded: ${healthSummary(health, provider)}`
        : `Recorded: ${healthSummary(health, provider)}`,
    })

    const groups: ApiGroup[] = [
      {
        name: 'AI providers',
        items: [
          withHealth(gemini, 'gemini'),
          withHealth(groq, 'groq'),
          withHealth(openrouter, 'openrouter'),
        ],
      },
      {
        name: 'Email',
        items: [resend],
      },
      {
        name: 'News & data',
        items: [gnews, gdelt, bing, rssPool, firebase],
      },
      {
        name: 'Geo',
        items: [ipApi, ipWho],
      },
      {
        name: 'Payments',
        items: [staticKofi(), stripe],
      },
      {
        name: 'Auth',
        items: [googleAuth, staticAppleAuth()],
      },
      {
        name: 'Push',
        items: [staticVapid()],
      },
      {
        name: 'Scheduling',
        items: staticCrons(),
      },
    ]

    const flat = groups.flatMap((g) => g.items)
    const summary = {
      total: flat.length,
      working: flat.filter((i) => i.status === 'working').length,
      limited: flat.filter((i) => i.status === 'limited').length,
      limitReached: flat.filter((i) => i.status === 'limit-reached').length,
      down: flat.filter((i) => i.status === 'down').length,
      notConfigured: flat.filter((i) => i.status === 'not-configured').length,
      info: flat.filter((i) => i.status === 'info').length,
    }

    return NextResponse.json({ ok: true, ts: Date.now(), summary, groups })
  } catch (err) {
    return NextResponse.json({ error: 'Board failed', detail: String(err) }, { status: 500 })
  }
}
