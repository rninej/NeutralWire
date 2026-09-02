/**
 * Multi-provider AI fallback chain (optimized for fast parallel execution).
 *
 * Call order (first that works wins, all in parallel):
 * 1. Gemini — multiple models in parallel (free, with optional Google Search)
 * 2. Groq — openai/gpt-oss-120b + qwen/qwen3.6-27b (free)
 * 3. OpenRouter — google/gemma-4-26b-a4b-it:free (last resort)
 *
 * For compound (web search) fallback:
 * 1. Gemini — multiple models WITH Google Search enabled
 * 2. Groq — compound-beta
 * 3. OpenRouter — with plugins: [{id: 'web'}]
 *
 * Each provider has a 4s timeout. We use Promise.any() so the FIRST provider
 * to return a valid answer wins; the rest are abandoned. This keeps total
 * response time low even when some providers are slow or rate-limited.
 *
 * ── AUTO-DEPRECATION DETECTION ──
 * When a model returns 404 or a "deprecation"/"decommissioned"/"not found"
 * error, it's automatically added to the `deprecatedModels` set and skipped
 * for ALL future calls in this server instance. This means when Groq,
 * Gemini, or OpenRouter retire a model, the fallback chain adapts
 * automatically — no code change needed.
 *
 * The deprecated set is per-instance (cleared on server restart). For
 * permanent removal, update the model lists below.
 */

const GROQ_API_KEY = process.env.GROQ_API_KEY || ''
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models'

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || ''
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'

// ── Preferred models (in priority order) ──
// These are PREFERENCES, not hard requirements: on the first AI call we
// fetch each provider's LIVE model list (memoized per instance) and keep
// only the models that actually exist there. When a provider retires or
// renames a model, discovery automatically falls through to the next
// preference — no more permanent 404s from hallucinated/retired IDs.
//
// UPDATED 2026-09 from free-tier research (Groq docs / deprecation page):
//   - moonshotai/kimi-k2-instruct-0905: DEPRECATED (2026-04-15) → removed.
//   - llama-3.3-70b-versatile: shut for free/developer tier (2026-08-16)
//     → removed from preferences (dynamic fallback can still pick it if
//     the key has access).
//   - llama-3.1-8b-instant: deprecated in favour of gpt-oss-20b → demoted
//     to last place (enterprise keys only).
//   - qwen/qwen3.6-27b: Groq's recommended replacement tier-2 model.
// Groq free tier: ~30 RPM / 14,400 RPD (org-level).
const GEMINI_MODELS = [
  // Google's auto-updating stable aliases FIRST — these exist for every key
  // (new projects included) and always point at a usable flash model.
  // In 2026 gemini-flash-latest resolves to the Gemini 3 Flash generation
  // (10 RPM / 250K TPM / 1500 RPD free tier).
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  // 2.0-flash next: available on free-tier keys but dropped to 5 RPM in
  // 2026 — keep below the aliases so the higher-quota model wins.
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash-001',
  // 2.5 family: free tier available (1500 RPD shared Flash + Flash-Lite)
  // but "not available to new users" via generateContent on some keys —
  // discovery + the health system sort these out automatically.
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  // gemma-3 runs on the Gemini API too (text-only, but it answers).
  'gemma-3-27b-it',
]

// Groq: text models in preference order (see the 2026 deprecation notes
// above). Discovery filters to what the key can actually access, and the
// Firebase health system re-orders by real-world success rate.
const GROQ_MODELS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.6-27b',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'qwen/qwen3-32b',
  'llama-3.1-8b-instant',
]

// Track rate-limited models to skip them in future calls (per-process)
const rateLimitedModels = new Map<string, number>()
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000

// ─────────────────────────────────────────────────────────────────────────
// FIREBASE-PERSISTED MODEL HEALTH — the "learning" half of the fallback.
//
// Vercel serverless instances are short-lived and DON'T share memory, so
// the old in-memory cooldowns/deprecations reset on every cold start —
// every new instance walked into the same rate limits again. Now every
// provider call outcome is recorded in Firebase:
//
//   aiModelHealth/<provider>/<urlencoded-model> = {
//     ok, fail,          — lifetime success/failure counters (learning
//                          "which ones to use": models are sorted by
//                          success rate, preference order as tiebreak)
//     last429,           — epoch ms of the last rate-limit hit (ALL
//                          instances skip the model for 60s after this)
//     last404,           — epoch ms of the last not-found/retirement hit
//                          (soft-block shared across instances, 10 min)
//     lastOk             — epoch ms of the last success
//   }
//
// Reads: once per instance + 60s stale-while-revalidate (never blocks a
//        call — a warm cache answers instantly, refresh runs in background)
// Writes: fire-and-forget, throttled per model (≤1 write / 20s for
//        counters; state events like 429/404 always write immediately).
// Failure to reach Firebase is NON-FATAL — in-memory state still works,
// we just don't share it across instances.
// ─────────────────────────────────────────────────────────────────────────
const HEALTH_DB_URL =
  'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'
const HEALTH_ROOT = 'aiModelHealth'

type HealthEvent = 'ok' | 'fail' | '429' | '404'
interface ModelHealth {
  ok?: number
  fail?: number
  last429?: number
  last404?: number
  lastOk?: number
}
type HealthTable = Record<string, Record<string, ModelHealth>> // provider → model → health

let healthCache: HealthTable | null = null
let healthFetchInFlight: Promise<HealthTable | null> | null = null
let healthLoadedAt = 0
const HEALTH_TTL_MS = 60 * 1000
const HEALTH_WRITE_THROTTLE_MS = 20 * 1000
const lastHealthWrite = new Map<string, number>()

function encodeModelId(model: string): string {
  // Model ids contain '/' (openrouter, groq) and ':' (openrouter :free) —
  // both are illegal in Firebase path segments. encodeURIComponent covers
  // them reversibly.
  return encodeURIComponent(model)
}

async function fetchHealth(): Promise<HealthTable | null> {
  try {
    const res = await fetch(`${HEALTH_DB_URL}/${HEALTH_ROOT}.json`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return null
    const text = await res.text()
    if (!text || text === 'null') return {}
    const raw = JSON.parse(text) as Record<
      string,
      Record<string, ModelHealth>
    >
    // Decode the urlencoded model keys back to real model ids.
    const out: HealthTable = {}
    for (const [provider, models] of Object.entries(raw)) {
      out[provider] = {}
      for (const [encModel, h] of Object.entries(models || {})) {
        try {
          out[provider][decodeURIComponent(encModel)] = h
        } catch {
          out[provider][encModel] = h
        }
      }
    }
    return out
  } catch {
    return null
  }
}

/** Get the (possibly stale) health table; refresh in background when TTL
 *  expired. NEVER blocks on the network when a warm cache exists. */
async function getHealth(): Promise<HealthTable | null> {
  const fresh = healthCache && Date.now() - healthLoadedAt < HEALTH_TTL_MS
  if (fresh) return healthCache
  if (!healthFetchInFlight) {
    healthFetchInFlight = fetchHealth().then((h) => {
      healthFetchInFlight = null
      if (h) {
        healthCache = h
        healthLoadedAt = Date.now()
      } else if (!healthCache) {
        // First load failed — retry on the next call (short-circuit the
        // TTL so we don't hammer Firebase every request either).
        healthLoadedAt = Date.now() - HEALTH_TTL_MS + 10 * 1000
      }
      return healthCache
    })
    // Cold start: we MUST wait for the first load (nothing cached).
    if (!healthCache) return healthFetchInFlight
  }
  return healthCache
}

/** Record a call outcome: update in-memory state NOW, persist to Firebase
 *  (throttled) so every OTHER serverless instance learns it too. */
function recordHealth(
  provider: string,
  model: string,
  event: HealthEvent,
): void {
  // In-memory update (instant).
  const h = ((healthCache ||= {})[provider] ||= {})[model] ||= {}
  if (event === 'ok') {
    h.ok = (h.ok || 0) + 1
    h.lastOk = Date.now()
  } else if (event === 'fail') {
    h.fail = (h.fail || 0) + 1
  } else if (event === '429') {
    h.last429 = Date.now()
  } else if (event === '404') {
    h.last404 = Date.now()
  }

  // Mirror the rate-limit/deprecation state into the fast in-memory maps
  // so the existing selection logic benefits immediately.
  if (event === '429') rateLimitedModels.set(`${provider}-${model}`, Date.now())
  if (event === '404') deprecatedModels.set(`${provider}-${model}`, Date.now())

  // Persist (fire-and-forget, throttled).
  const key = `${provider}/${model}/${event}`
  const last = lastHealthWrite.get(key) || 0
  const stateEvent = event === '429' || event === '404'
  if (!stateEvent && Date.now() - last < HEALTH_WRITE_THROTTLE_MS) return
  lastHealthWrite.set(key, Date.now())
  void (async () => {
    try {
      const path = `${HEALTH_ROOT}/${provider}/${encodeModelId(model)}`
      const res = await fetch(`${HEALTH_DB_URL}/${path}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(h),
        signal: AbortSignal.timeout(4000),
      })
      if (!res.ok) diag(`health write ${provider}/${model} failed: ${res.status}`)
    } catch {
      // Firebase unreachable — in-memory state still applies locally.
    }
  })()
}

/** Shared cross-instance cooldown: true when ANY instance recently saw a
 *  429 (within RATE_LIMIT_COOLDOWN_MS) or 404 (within DEPRECATION_TTL_MS)
 *  for this provider+model. */
function sharedBlocked(provider: string, model: string): boolean {
  const h = healthCache?.[provider]?.[model]
  if (!h) return false
  const now = Date.now()
  if (h.last429 && now - h.last429 < RATE_LIMIT_COOLDOWN_MS) return true
  if (h.last404 && now - h.last404 < DEPRECATION_TTL_MS) return true
  return false
}

/** Learning score for ordering models: success rate first, recency of
 *  success as tiebreak, caller's preference order as final tiebreak. */
function healthScore(provider: string, model: string, prefIndex: number): number {
  const h = healthCache?.[provider]?.[model]
  if (!h) return 1000 - prefIndex // no data → keep preference order
  const ok = h.ok || 0
  const fail = h.fail || 0
  const total = ok + fail
  if (total === 0) return 1000 - prefIndex
  // Success rate 0..1 mapped to a wide band, minus a small penalty for
  // models that have never succeeded recently.
  const rate = ok / total
  let score = 500 + rate * 400
  if (!h.lastOk || Date.now() - h.lastOk > 6 * 60 * 60 * 1000) score -= 50
  return score - prefIndex
}

/** Re-order a provider's effective model list by LEARNED success rate
 *  (Firebase health data), keeping the input (preference) order as the
 *  tiebreak. Models with no data keep their preference position. */
function healthOrdered(provider: string, models: string[]): string[] {
  if (!healthCache) return models
  const scored = models.map((m, i) => ({ m, s: healthScore(provider, m, i) }))
  // Only re-order when we actually have health data for ≥2 models of this
  // provider — otherwise the preference order stands.
  const withData = scored.filter(({ m }) => healthCache?.[provider]?.[m])
  if (withData.length < 2) return models
  return scored.sort((a, b) => b.s - a.s).map((x) => x.m)
}

// ── LIVE MODEL DISCOVERY ──
// One-time per server instance: fetch each provider's FULL model list and
// keep it. At call time we intersect with our preferences; if the
// intersection is empty (provider retired everything we like) we rank the
// FULL live list dynamically and use the best text models it offers.
// Solves the recurring failure mode where a hallucinated, retired, or
// key-restricted model ID made every call to that provider 404 — the main
// cause of "cannot reach AI provider" (502).
// Discovery failures are non-fatal: we fall back to the static lists.
interface DiscoveredModels {
  /** FULL live model list per provider (null = discovery failed). */
  gemini: string[] | null
  groq: string[] | null
  openrouter: string[] | null
}
let discovered: DiscoveredModels | null = null
let discoveryInFlight: Promise<DiscoveredModels> | null = null

async function fetchJson(
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetch(url, { headers, cache: 'no-store', signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return null
    return await res.json()
  } catch {
    clearTimeout(timeout)
    return null
  }
}

/** Paged JSON walker — follows nextPageToken up to `maxPages` pages so a
 *  >200-model catalog (Gemini has 100s of variants incl. embeddings,
 *  image, tts…) isn't truncated mid-alphabet. pageSize=200 missed
 *  gemini-2.0-flash in production because page 1 filled up first. */
async function fetchJsonPaged(
  baseUrl: string,
  headers: Record<string, string>,
  pageParam: (token: string) => string,
  extract: (d: unknown) => string[] | null,
  maxPages = 3,
): Promise<string[] | null> {
  const out: string[] = []
  let token: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const data = await fetchJson(token ? pageParam(token) : baseUrl, headers)
    if (!data) return out.length > 0 ? out : null
    const items = extract(data)
    if (items) out.push(...items)
    const next = (data as { nextPageToken?: string })?.nextPageToken
    if (!next) break
    token = next
  }
  return out.length > 0 ? out : null
}

/** True when the model name is a TEXT generation model we can call with
 *  chat completions / generateContent. Gemini's list is full of
 *  embeddings, image, tts, audio and live models that would 404. */
const GEMINI_BAD_MODEL =
  /embedding|aqa|tts|audio|imagen|image|veo|lyria|live|learnlm|thinking|robotics|computer-use|native|exp-|deprecated|legacy|protection/i

/** Rank ANY list of Gemini model names: best text model first.
 *  Order: -latest aliases > flash > flash-lite > numbered gemini > gemma.
 *  Higher version numbers win inside each tier. */
export function rankGeminiModels(all: string[]): string[] {
  const score = (m: string): number => {
    if (GEMINI_BAD_MODEL.test(m)) return -1000
    let s = 0
    if (/^gemini-(flash|pro)-latest$/.test(m)) s += 200 // stable aliases
    else if (/^gemini-flash-lite-latest$/.test(m)) s += 190
    else if (/flash-lite/.test(m)) s += 120
    else if (/flash/.test(m)) s += 150
    else if (/^gemini-\d/.test(m)) s += 100
    else if (/^gemini-\d+(\.\d+)?-pro/.test(m)) s += 80
    else if (/^gemma-\d/.test(m)) s += 60
    else return -500
    const ver = m.match(/(\d+)\.(\d+)/)
    if (ver) s += Number(ver[1]) * 10 + Number(ver[2])
    if (/preview/.test(m)) s -= 5
    return s
  }
  return [...new Set(all)]
    .map((m) => ({ m, s: score(m) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.m)
}

/** Rank ANY list of Groq model names: usable text models first. */
export function rankGroqModels(all: string[]): string[] {
  const bad = /whisper|tts|guard|play|embed|prompt-guard|audio/i
  const score = (m: string): number => {
    if (bad.test(m)) return -1000
    let s = 0
    if (/gpt-oss/.test(m)) s += 100
    if (/kimi/.test(m)) s += 80
    if (/llama-4/.test(m)) s += 70
    if (/llama-3\.3/.test(m)) s += 60
    if (/qwen/.test(m)) s += 50
    if (/llama-3\.1/.test(m)) s += 40
    if (/gemma/.test(m)) s += 30
    if (/8b|mini/.test(m)) s += 5 // small = fast + generous limits
    return s
  }
  return [...new Set(all)]
    .map((m) => ({ m, s: score(m) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.m)
}

async function discoverProviderModels(): Promise<DiscoveredModels> {
  const [geminiList, groqList, orList] = await Promise.all([
    GEMINI_API_KEY
      ? fetchJsonPaged(
          `${GEMINI_URL}?key=${GEMINI_API_KEY}&pageSize=1000`,
          {},
          (t) => `${GEMINI_URL}?key=${GEMINI_API_KEY}&pageSize=1000&pageToken=${t}`,
          (d) =>
            (d as { models?: Array<{ name?: string }> })?.models
              ?.map((m) => (m.name || '').replace(/^models\//, ''))
              .filter(Boolean) ?? null,
        )
      : Promise.resolve(null),
    GROQ_API_KEY
      ? fetchJson(GROQ_MODELS_URL, { Authorization: `Bearer ${GROQ_API_KEY}` }).then(
          (d) =>
            (d as { data?: Array<{ id?: string }> })?.data
              ?.map((m) => m.id || '')
              .filter(Boolean) ?? null,
        )
      : Promise.resolve(null),
    OPENROUTER_API_KEY
      ? fetchJson(OPENROUTER_MODELS_URL, { Authorization: `Bearer ${OPENROUTER_API_KEY}` }).then(
          (d) =>
            (d as { data?: Array<{ id?: string }> })?.data
              ?.map((m) => m.id || '')
              .filter(Boolean) ?? null,
        )
      : Promise.resolve(null),
  ])

  const result: DiscoveredModels = {
    gemini: geminiList,
    groq: groqList,
    openrouter: orList,
  }

  // Record every PREFERRED model the providers CONFIRM exist —
  // checkDeprecation never retires these on a single 404 (transient
  // errors can't blacklist a model the provider itself says exists).
  const geminiHit = geminiList ? GEMINI_MODELS.filter((m) => geminiList.includes(m)) : []
  const groqHit = groqList ? GROQ_MODELS.filter((m) => groqList.includes(m)) : []
  const orHit = orList ? OPENROUTER_MODELS.filter((m) => orList.includes(m)) : []
  // Also confirm the top DYNAMIC candidates (they come from the provider's
  // own live list, so a single transient 404 shouldn't retire them either).
  const geminiDynamic = geminiList ? rankGeminiModels(geminiList).slice(0, 4) : []
  const groqDynamic = groqList ? rankGroqModels(groqList).slice(0, 4) : []
  discoveryConfirmed = new Set([
    ...geminiHit.map((m) => `gemini-${m}`),
    ...groqHit.map((m) => `groq-${m}`),
    ...geminiDynamic.map((m) => `gemini-${m}`),
    ...groqDynamic.map((m) => `groq-${m}`),
    ...(orHit.length > 0 ? ['openrouter'] : []),
  ])
  console.log(
    `[ai] model discovery: gemini=${geminiList?.length ?? 'n/a'} live (${geminiHit.length} preferred) groq=${groqList?.length ?? 'n/a'} live (${groqHit.length} preferred) openrouter=${orList?.length ?? 'n/a'} live (${orHit.length} preferred)`,
  )
  return result
}

async function getDiscoveredModels(): Promise<DiscoveredModels> {
  if (discovered) return discovered
  if (!discoveryInFlight) {
    discoveryInFlight = discoverProviderModels().then((d) => {
      discovered = d
      discoveryInFlight = null
      return d
    })
  }
  return discoveryInFlight
}

// ── Re-discovery on failure ──
// "When something fails it re-reads the models available." A 404 /
// deprecation means our cached model list is stale (the provider retired
// or renamed something). Invalidate the memo and immediately re-fetch so
// the very NEXT candidate in the same request picks from fresh data.
// Guarded by a 30s min-interval so a burst of failures can't hammer the
// /models endpoints.
let lastRediscovery = 0
const REDISCOVERY_MIN_INTERVAL_MS = 30 * 1000
let rediscoveryInFlight: Promise<DiscoveredModels | null> | null = null

function invalidateDiscovery(reason: string): Promise<DiscoveredModels | null> {
  const now = Date.now()
  if (now - lastRediscovery < REDISCOVERY_MIN_INTERVAL_MS) {
    // Throttled — still drop the stale cache so the NEXT un-throttled
    // call re-fetches (getDiscoveredModels re-runs when discovered=null).
    discovered = null
    discoveryInFlight = null
    return Promise.resolve(null)
  }
  lastRediscovery = now
  discovered = null
  discoveryInFlight = null // a stale in-flight fetch must not repopulate
  discoveryConfirmed = new Set()
  if (rediscoveryInFlight) return rediscoveryInFlight
  rediscoveryInFlight = discoverProviderModels()
    .then((d) => {
      discovered = d
      rediscoveryInFlight = null
      console.log(`[ai] re-discovery after failure (${reason}): gemini=${d.gemini?.length ?? 'n/a'} groq=${d.groq?.length ?? 'n/a'} or=${d.openrouter?.length ?? 'n/a'}`)
      return d
    })
    .catch(() => {
      rediscoveryInFlight = null
      return null
    })
  return rediscoveryInFlight
}

/** Preferred ∩ live, in preference order. Empty when nothing overlaps. */
function intersect(full: string[] | null, preferred: string[]): string[] {
  if (!full) return []
  return preferred.filter((m) => full.includes(m))
}

/** Effective model list for a provider:
 *   1. preferred ∩ live (preference order)
 *   2. if that's empty → dynamically ranked live text models (the
 *      provider retired/renamed everything we preferred, but still has
 *      usable models — e.g. only gemini-flash-latest exists for new keys)
 *   3. if discovery failed entirely → static preference list */
const loggedDynamicFallbacks = new Set<string>()
function effectiveModels(
  full: string[] | null,
  preferred: string[],
  ranker: (all: string[]) => string[],
  providerTag = '',
): string[] {
  if (!full) return preferred
  const hits = intersect(full, preferred)
  if (hits.length > 0) return hits
  const dynamic = ranker(full).slice(0, 4)
  if (dynamic.length > 0) {
    if (!loggedDynamicFallbacks.has(providerTag)) {
      loggedDynamicFallbacks.add(providerTag)
      console.log(`[ai] dynamic model fallback (${providerTag}): using ${dynamic.slice(0, 3).join(', ')}`)
    }
    return dynamic
  }
  return preferred
}

// ── Auto-deprecation detection ──
// When a model returns 404 or a deprecation error, it's added here and
// skipped for ALL future calls in this server instance. This makes the
// fallback chain self-healing — when a provider retires a model, the
// system automatically stops using it without needing a code update.
// (deprecatedModels now lives next to checkDeprecation below, as a
// TTL-based Map — see the DEPRECATION comment.)

// OpenRouter free-model preferences, in rotation order. callOpenRouter
// tries the first available one and ROTATES to the next on failure (a
// single retired/daily-capped model no longer kills the whole provider —
// the old single hard-coded ID 404'd permanently when OpenRouter retired
// it, another "cannot reach AI provider" contributor).
const OPENROUTER_MODELS = [
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-3-27b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'mistralai/mistral-small-3.1-24b-instruct:free',
  'meta-llama/llama-4-scout:free',
]
const OPENROUTER_MODEL = OPENROUTER_MODELS[0]
const GROQ_COMPOUND_MODEL = 'compound-beta'

/** Ordered OpenRouter rotation candidates: preferences found in the live
 *  list first, then (if none match) any other free text models the list
 *  offers. Capped at 3 — enough coverage without burning requests. */
function openRouterCandidates(discoveredList: string[] | null): string[] {
  const hits = discoveredList
    ? OPENROUTER_MODELS.filter((m) => discoveredList.includes(m))
    : []
  if (hits.length > 0) return hits.slice(0, 3)
  if (discoveredList) {
    const anyFree = discoveredList.filter(
      (m) => m.endsWith(':free') && !/nemo|vision|guard|embed/i.test(m),
    )
    if (anyFree.length > 0) return anyFree.slice(0, 3)
  }
  return [OPENROUTER_MODEL]
}

/** First OpenRouter preference that exists in the discovered list. */
function pickOpenRouterModel(discoveredList: string[] | null): string {
  return openRouterCandidates(discoveredList)[0]
}

interface ChatCall {
  systemPrompt: string
  userPrompt: string
  /** Optional max output tokens. Default 400. Set higher for long summaries. */
  maxTokens?: number
}

let lastProvider = 'none'

// ── Per-call diagnostics ──
// Records what each provider call returned so the 502 response can say
// exactly WHY it failed (which provider, which model, what error). This
// replaced hours of blind guessing — one failing request now self-reports.
let lastDiagnostics: string[] = []

export function getLastProvider(): string {
  return lastProvider
}

export function getLastDiagnostics(): string[] {
  return lastDiagnostics
}

function diag(msg: string): void {
  lastDiagnostics.push(msg)
  if (lastDiagnostics.length > 20) lastDiagnostics.shift()
  console.warn(`[ai:diag] ${msg}`)
}

/**
 * Strip chain-of-thought / thinking / reasoning from AI responses.
 *
 * Some models (especially Groq's gpt-oss and Gemini's thinking models)
 * include their internal reasoning in the output. This shows up as:
 *   - <think>...</think> tags
 *   - <reasoning>...</reasoning> tags
 *   - <thinking>...</thinking> tags
 *   - Plain text rambling before the actual summary
 *
 * This function removes all of those and returns only the clean summary.
 */
function stripThinking(text: string): string {
  let cleaned = text
  // Remove <think>...</think>, <reasoning>...</reasoning>, <thinking>...</thinking>
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '')
  cleaned = cleaned.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
  cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
  // Remove unclosed thinking tags (model started thinking but didn't close)
  cleaned = cleaned.replace(/<think>[\s\S]*$/gi, '')
  cleaned = cleaned.replace(/<reasoning>[\s\S]*$/gi, '')
  // If the response has thinking as plain text before the first ** heading,
  // strip everything before the first ** heading.
  // SAFETY: only strip when the prefix does NOT end with sentence
  // punctuation — real answer sentences end with . ! ? : " …, while
  // reasoning trails off mid-thought. (The old rule stripped ANY 20+ char
  // prefix, which ate legitimate answer content like
  // "The IMF is X. **Note**: …".)
  const firstHeading = cleaned.indexOf('**')
  if (firstHeading > 0) {
    const beforeHeading = cleaned.slice(0, firstHeading).trim()
    if (
      beforeHeading.length > 20 &&
      !beforeHeading.startsWith('**') &&
      !/[.!?:;"'”’)\]]$/.test(beforeHeading)
    ) {
      cleaned = cleaned.slice(firstHeading)
    }
  }
  return cleaned.trim()
}

/**
 * Check if a model has been auto-deprecated (returned 404 or deprecation
 * error in a previous call). Deprecated models are skipped for
 * DEPRECATION_TTL_MS (10 min) — NOT forever: warm serverless instances
 * live for hours, and a transient 404 (provider hiccup) used to remove a
 * provider PERMANENTLY from the instance (the "gemini=[NONE]" blackout).
 */
const DEPRECATION_TTL_MS = 10 * 60 * 1000
const deprecatedModels = new Map<string, number>()

function isDeprecated(key: string): boolean {
  const ts = deprecatedModels.get(key)
  if (!ts) return false
  if (Date.now() - ts >= DEPRECATION_TTL_MS) {
    deprecatedModels.delete(key)
    return false
  }
  return true
}

/** Models the live discovery fetch CONFIRMED exist — never deprecate these
 *  on a SINGLE 404 (the model demonstrably exists; one 404 is transient).
 *  But some models exist globally while a specific KEY can't call them
 *  (Gemini free tier: 2.5-flash "not available to new users" — ListModels
 *  shows it, generateContent 404s EVERY time). Those get soft-blocked
 *  after 2 consecutive 404s via consecutive404s. */
let discoveryConfirmed = new Set<string>()
const consecutive404s = new Map<string, number>()

/**
 * Mark a model as deprecated based on the API response.
 *
 * Triggers on:
 *   - HTTP 404 (model not found)
 *   - HTTP 400 with "deprecat" / "decommission" / "not available" in the error
 *   - Any response containing "has been deprecated" or "is no longer supported"
 *
 * EXCEPT when live model discovery confirmed the model exists — a 404 for
 * a model that appears in the provider's /models list is a transient
 * error (overload, routing), not a retirement.
 */
function checkDeprecation(key: string, status: number, errText: string): boolean {
  const lowerErr = errText.toLowerCase()
  const isRetirement =
    status === 404 ||
    (status === 400 && (lowerErr.includes('deprecat') || lowerErr.includes('decommission') || lowerErr.includes('not available'))) ||
    lowerErr.includes('has been deprecated') ||
    lowerErr.includes('is no longer supported') ||
    lowerErr.includes('model_not_found')
  if (!isRetirement) return false

  // Persist the 404 to Firebase (shared cooldown across ALL instances) and
  // RE-READ the provider's live model list — the cached list just proved
  // stale, so the next candidate should come from fresh data.
  const dash = key.indexOf('-')
  if (dash > 0) {
    const provider = key.slice(0, dash)
    const model = key.slice(dash + 1)
    recordHealth(provider, model, '404')
    void invalidateDiscovery(`${key} ${status}`)
  }

  // Discovery-confirmed model: the model exists for the PROVIDER, but this
  // key may still not have access. Allow ONE transient 404; after 2
  // consecutive, soft-block it for the deprecation TTL (it's a key-level
  // restriction, not a fluke).
  if (discoveryConfirmed.has(key)) {
    const n = (consecutive404s.get(key) || 0) + 1
    consecutive404s.set(key, n)
    if (n < 2) {
      diag(`${key}: ${status} ignored (discovery-confirmed, transient #${n})`)
      return false
    }
    deprecatedModels.set(key, Date.now())
    consecutive404s.set(key, 0)
    console.warn(`[ai] soft-blocked ${key} for 10min (${n} consecutive 404s — key-level restriction)`)
    return true
  }
  if (!deprecatedModels.has(key)) {
    deprecatedModels.set(key, Date.now())
    console.warn(`[ai] Auto-deprecated ${key} for 10min (status ${status}: ${errText.slice(0, 100)})`)
  }
  return true
}

/**
 * Try multiple AI providers IN PARALLEL. Returns the first valid answer.
 *
 * Strategy:
 *   - Fire off Gemini (first model), Groq (first model), OpenRouter ALL AT ONCE
 *   - First one that returns a non-null answer wins (Promise.any)
 *   - Other calls are abandoned (no need to wait)
 *   - If all fail, fall back to trying remaining Gemini models sequentially
 *
 * This dramatically reduces latency compared to sequential trying.
 *
 * Does NOT use googleSearch by default (faster). The compound flow handles
 * web search separately.
 */
export async function callAI(opts: ChatCall): Promise<string | null> {
  const now = Date.now()
  const maxTokens = opts.maxTokens ?? 400
  const candidates: Array<Promise<string | null>> = []
  lastDiagnostics = []

  // Make sure model discovery has run (no-op after the first call) and
  // load the SHARED Firebase health table (cross-instance cooldowns +
  // success-rate learning; stale-while-revalidate, never blocks warm).
  const disc = await getDiscoveredModels()
  await getHealth()
  const geminiModels = healthOrdered('gemini', effectiveModels(disc.gemini, GEMINI_MODELS, rankGeminiModels, 'gemini'))
  const groqModels = healthOrdered('groq', effectiveModels(disc.groq, GROQ_MODELS, rankGroqModels, 'groq'))

  // Pick up to 2 available models per provider (skip deprecated +
  // rate-limited, including SHARED Firebase cooldowns).
  const available = (keys: Array<{ key: string; model: string }>) =>
    keys.filter(({ key, model }) => {
      if (isDeprecated(key)) return false
      const limitedAt = rateLimitedModels.get(key)
      if (limitedAt && now - limitedAt < RATE_LIMIT_COOLDOWN_MS) return false
      const dash = key.indexOf('-')
      if (dash > 0 && sharedBlocked(key.slice(0, dash), model)) return false
      return true
    })

  const geminiAvail = available(geminiModels.map((m) => ({ key: `gemini-${m}`, model: m }))).slice(0, 1)
  const groqAvail = available(groqModels.map((m) => ({ key: `groq-${m}`, model: m }))).slice(0, 1)

  // ── Cooldown escape hatch ──
  // If EVERY model of a provider is in the 60s rate-limit cooldown, the
  // volley would fire zero candidates and the call is guaranteed to fail
  // — one 429 burst could silence an instance for a minute (observed:
  // repeated ask-ai 502s while /api/summary worked). Always keep ONE
  // candidate: the least-recently-limited model. Worst case it 429s
  // again (one cheap request); best case the limit cleared and it works.
  const rescueCandidate = (keys: Array<{ key: string; model: string }>, have: string[]) => {
    if (keys.length === 0 || have.length > 0) return null
    const limited = keys
      .filter((k) => !isDeprecated(k.key) && rateLimitedModels.has(k.key))
      .sort(
        (a, b) =>
          (rateLimitedModels.get(a.key) ?? 0) - (rateLimitedModels.get(b.key) ?? 0),
      )
    return limited[0]?.model ?? keys.find((k) => !isDeprecated(k.key))?.model ?? null
  }
  const geminiRescue = rescueCandidate(
    geminiModels.map((m) => ({ key: `gemini-${m}`, model: m })),
    geminiAvail.map((a) => a.model),
  )
  const groqRescue = rescueCandidate(
    groqModels.map((m) => ({ key: `groq-${m}`, model: m })),
    groqAvail.map((a) => a.model),
  )
  if (geminiRescue) geminiAvail.push({ key: `gemini-${geminiRescue}`, model: geminiRescue })
  if (groqRescue) groqAvail.push({ key: `groq-${groqRescue}`, model: groqRescue })

  diag(
    `volley: gemini=[${geminiAvail.map((a) => a.model).join(',') || 'NONE'}] groq=[${groqAvail.map((a) => a.model).join(',') || 'NONE'}] openrouter=${OPENROUTER_API_KEY ? pickOpenRouterModel(disc.openrouter) : 'no-key'} | discovered gemini=${disc.gemini?.length ?? 'n/a'} groq=${disc.groq?.length ?? 'n/a'} or=${disc.openrouter?.length ?? 'n/a'} | deprecated=[${Array.from(deprecatedModels).join(',') || '-'}]`,
  )

  // 1+2. Fire ONE model from EACH provider in parallel (3 requests total
  //  incl. OpenRouter). This is deliberate rate-limit economics: free-tier
  // RPM is shared across the whole site (summaries, title shortening, image
  // verification, ask-ai), and a 5-request volley per question was causing
  // 429 bursts that blacked out whole minutes. One model per provider +
  // sequential fallback below = same coverage, ~40% less quota per call.
  // If the raced model is slow, ANOTHER provider still wins the race.
  for (const { model } of geminiAvail) {
    if (GEMINI_API_KEY) {
      candidates.push(callGemini(opts.systemPrompt, opts.userPrompt, model, false, maxTokens))
    }
  }
  if (GROQ_API_KEY) {
    for (const { model } of groqAvail) {
      candidates.push(callGroq(opts.systemPrompt, opts.userPrompt, model, maxTokens))
    }
  }

  // 3. Fire off OpenRouter (last resort but parallel for speed)
  if (OPENROUTER_API_KEY && !isDeprecated('openrouter')) {
    candidates.push(callOpenRouter(opts.systemPrompt, opts.userPrompt, false, maxTokens))
  }

  // 4. Race them — first NON-NULL answer wins.
  if (candidates.length > 0) {
    const wrappedCandidates = candidates.map((p, i) =>
      p.then((result) => {
        if (result) return result
        throw new Error(`candidate ${i} returned null`)
      }),
    )
    try {
      const answer = await Promise.any(wrappedCandidates)
      if (answer) {
        lastProvider = 'AI (parallel)'
        return answer
      }
    } catch {
      // All candidates returned null or rejected.
      // Fall through to sequential retry below.
    }
  }

  // 5. Sequential retry: remaining models not yet tried. If everything
  // failed so far, re-read the provider model lists ONCE before this pass
  // (a mass failure usually means the cached list is stale).
  const freshDisc = await invalidateDiscovery('callAI all-candidates-failed')
  const geminiRetry = healthOrdered(
    'gemini',
    effectiveModels(freshDisc?.gemini ?? disc.gemini, GEMINI_MODELS, rankGeminiModels, 'gemini'),
  )
  const groqRetry = healthOrdered(
    'groq',
    effectiveModels(freshDisc?.groq ?? disc.groq, GROQ_MODELS, rankGroqModels, 'groq'),
  )
  for (const model of geminiRetry) {
    if (geminiAvail.some((a) => a.model === model)) continue
    const key = `gemini-${model}`
    if (isDeprecated(key)) continue
    const limitedAt = rateLimitedModels.get(key)
    if (limitedAt && now - limitedAt < RATE_LIMIT_COOLDOWN_MS) continue

    const answer = await callGemini(opts.systemPrompt, opts.userPrompt, model, false, maxTokens)
    if (answer) {
      lastProvider = `Gemini ${model}`
      return answer
    }
  }

  // 6. Try remaining Groq models
  for (const model of groqRetry) {
    if (groqAvail.some((a) => a.model === model)) continue
    const key = `groq-${model}`
    if (isDeprecated(key)) continue
    const limitedAt = rateLimitedModels.get(key)
    if (limitedAt && now - limitedAt < RATE_LIMIT_COOLDOWN_MS) continue

    const answer = await callGroq(opts.systemPrompt, opts.userPrompt, model, maxTokens)
    if (answer) {
      lastProvider = `Groq ${model}`
      return answer
    }
  }

  return null
}

/**
 * Try compound (web search) providers IN PARALLEL.
 *
 * Different from callAI: every Gemini call here uses the googleSearch tool.
 * Also tries Groq compound-beta and OpenRouter with web plugin.
 */
export async function callAICompound(opts: ChatCall): Promise<string | null> {
  const now = Date.now()
  const candidates: Array<Promise<string | null>> = []
  lastDiagnostics = []

  // Make sure model discovery has run (no-op after the first call) and
  // load shared health (cross-instance cooldowns + learning).
  const disc = await getDiscoveredModels()
  await getHealth()
  const geminiModels = healthOrdered('gemini', effectiveModels(disc.gemini, GEMINI_MODELS, rankGeminiModels, 'gemini'))

  const modelOk = (key: string) => {
    if (isDeprecated(key)) return false
    const limitedAt = rateLimitedModels.get(key)
    if (limitedAt && now - limitedAt < RATE_LIMIT_COOLDOWN_MS) return false
    const dash = key.indexOf('-')
    if (dash > 0 && sharedBlocked(key.slice(0, dash), key.slice(dash + 1))) return false
    return true
  }

  // 1. Fire off up to TWO Gemini models WITH Google Search in parallel
  const geminiSearchModels = geminiModels
    .filter((m) => modelOk(`gemini-${m}`))
    .slice(0, 2)
  for (const model of geminiSearchModels) {
    if (GEMINI_API_KEY) {
      candidates.push(callGemini(opts.systemPrompt, opts.userPrompt, model, true))
    }
  }

  // 2. Groq compound-beta in parallel (skip if deprecated)
  if (GROQ_API_KEY && !isDeprecated('groq-compound-beta')) {
    candidates.push(callGroq(opts.systemPrompt, opts.userPrompt, GROQ_COMPOUND_MODEL))
    // ALSO race a regular Groq model (no web search, but at least answers
    // from training data) — compound-beta alone has been unreliable.
    const groqModels = effectiveModels(disc.groq, GROQ_MODELS, rankGroqModels, 'groq')
    const groqRegular = groqModels.find((m) => modelOk(`groq-${m}`))
    if (groqRegular) {
      candidates.push(callGroq(opts.systemPrompt, opts.userPrompt, groqRegular))
    }
  }

  // 3. OpenRouter with web search in parallel. OpenRouter REPLACED the old
  //    `plugins: [{id: 'web'}]` API with the `:online` model suffix — use
  //    the suffix (callOpenRouter handles it via useWebSearch).
  if (OPENROUTER_API_KEY && !isDeprecated('openrouter')) {
    candidates.push(callOpenRouter(opts.systemPrompt, opts.userPrompt, true))
  }

  diag(
    `compound volley: gemini-search=[${geminiSearchModels.join(',') || 'NONE'}] groq=${GROQ_API_KEY ? 'compound-beta+regular' : 'no-key'} openrouter=${OPENROUTER_API_KEY ? ':online' : 'no-key'}`,
  )

  // 4. Race them. A model that can't answer without search may reply with
  //    ONLY the ({/compound}) marker — that's a failure for our purposes
  //    (no real content), so treat it as a lost race and continue to the
  //    sequential retries + fallback below.
  if (candidates.length > 0) {
    try {
      const answer = await Promise.any(candidates)
      if (answer) {
        const cleaned = answer
          .replace(/^\(?(\{\/compound\})\)?\s*/g, '')
          .replace(/^\{\/compound\}\s*/g, '')
          .trim()
        if (cleaned.length > 0) {
          lastProvider = 'AI (web search, parallel)'
          return answer
        }
      }
    } catch {
      // All failed — fall through to sequential retry
    }
  }

  // 5. Sequential retry on remaining Gemini models WITH search. Re-read
  //    the model lists first when the whole volley failed (stale list?).
  const freshDisc = await invalidateDiscovery('callAICompound all-candidates-failed')
  const geminiRetry = healthOrdered(
    'gemini',
    effectiveModels(freshDisc?.gemini ?? disc.gemini, GEMINI_MODELS, rankGeminiModels, 'gemini'),
  )
  for (const model of geminiRetry) {
    if (geminiSearchModels.includes(model)) continue
    const key = `gemini-${model}`
    if (isDeprecated(key)) continue
    const limitedAt = rateLimitedModels.get(key)
    if (limitedAt && now - limitedAt < RATE_LIMIT_COOLDOWN_MS) continue

    const answer = await callGemini(opts.systemPrompt, opts.userPrompt, model, true)
    if (answer) {
      lastProvider = `Gemini ${model} (Google Search)`
      return answer
    }
  }

  // 6. Everything failed. NO third volley here — the compound race above
  //    already included a regular (no-search) model as a candidate, so a
  //    training-data answer would have won the race if any provider had
  //    quota left. Firing yet another volley now would just hammer the
  //    same rate-limited free tiers (the 502 domino: volley 1 callAI →
  //    volley 2 compound → volley 3 fallback = up to 15 requests for ONE
  //    question). The caller shows an honest "couldn't verify" message.
  return null
}

// ---------- Vision (image understanding) ----------
// Used to verify that a candidate topic image actually SHOWS something
// related to the story (e.g. not a supermarket storefront on a
// Netanyahu headline). Groq llama-4-scout and Gemini flash are both
// multimodal and cheap; we race them and take the first answer.
const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'
const GEMINI_VISION_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash']

// Unsupported-by-vision-models formats (Gemini/Groq don't take avif; svg
// is usually a site logo, not a photo). These return null → caller
// fail-opens (keeps the image unverified) rather than rejecting.
const VISION_OK_MIME = /^image\/(jpeg|jpg|png|webp|gif)$/i

/**
 * Download an image and encode it as a base64 data payload.
 * Returns null if the image is missing, too large (>2.5MB), or in a
 * format the vision models can't read.
 */
async function fetchImageBase64(
  imageUrl: string,
): Promise<{ mime: string; data: string } | null> {
  try {
    const parsed = new URL(imageUrl)
    const referer = `${parsed.protocol}//${parsed.host}/`
    const res = await fetch(imageUrl, {
      signal: AbortSignal.timeout(6000),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        Referer: referer,
      },
      redirect: 'follow',
      cache: 'no-store',
    })
    if (!res.ok) return null
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim()
    if (!VISION_OK_MIME.test(ct)) return null
    const buf = await res.arrayBuffer()
    if (buf.byteLength < 1000 || buf.byteLength > 2.5 * 1024 * 1024) return null
    return { mime: ct, data: Buffer.from(buf).toString('base64') }
  } catch {
    return null
  }
}

/**
 * Ask a vision model a question about an image. Returns the model's text
 * answer, or null when no vision provider could answer (missing keys,
 * timeouts, unsupported image format, ...). Callers should treat null as
 * "unverifiable" and fail OPEN (keep the image), never as a rejection.
 */
export async function callVisionAI(
  systemPrompt: string,
  userPrompt: string,
  imageUrl: string,
): Promise<string | null> {
  const img = await fetchImageBase64(imageUrl)
  if (!img) return null

  const dataUrl = `data:${img.mime};base64,${img.data}`
  const candidates: Array<Promise<string | null>> = []

  // Groq vision (llama-4-scout) — OpenAI-compatible image_url format
  if (GROQ_API_KEY && !isDeprecated(`groq-${GROQ_VISION_MODEL}`)) {
    const key = `groq-${GROQ_VISION_MODEL}`
    const limitedAt = rateLimitedModels.get(key)
    if (!limitedAt || Date.now() - limitedAt >= RATE_LIMIT_COOLDOWN_MS) {
      candidates.push(
        (async () => {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 8000)
          try {
            const res = await fetch(GROQ_URL, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                model: GROQ_VISION_MODEL,
                messages: [
                  { role: 'system', content: systemPrompt },
                  {
                    role: 'user',
                    content: [
                      { type: 'text', text: userPrompt },
                      { type: 'image_url', image_url: { url: dataUrl } },
                    ],
                  },
                ],
                max_tokens: 16,
                temperature: 0,
              }),
              cache: 'no-store',
              signal: controller.signal,
            })
            clearTimeout(timeout)
            if (!res.ok) {
              const errText = await res.text().catch(() => '')
              if (res.status === 429) {
                rateLimitedModels.set(key, Date.now())
                console.warn(`[ai] Groq vision rate-limited`)
              } else {
                checkDeprecation(key, res.status, errText)
              }
              return null
            }
            const data = await res.json()
            return (
              stripThinking(data.choices?.[0]?.message?.content?.trim() || '') ||
              null
            )
          } catch {
            clearTimeout(timeout)
            return null
          }
        })(),
      )
    }
  }

  // Gemini vision — inline_data format
  const geminiModel = GEMINI_VISION_MODELS.find(
    (m) => !isDeprecated(`gemini-${m}`) && !rateLimitedModels.has(`gemini-${m}`),
  )
  if (geminiModel && GEMINI_API_KEY) {
    candidates.push(
      (async () => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 8000)
        try {
          const url = `${GEMINI_URL}/${geminiModel}:generateContent?key=${GEMINI_API_KEY}`
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [
                {
                  role: 'user',
                  parts: [
                    { text: `${systemPrompt}\n\n${userPrompt}` },
                    { inline_data: { mime_type: img.mime, data: img.data } },
                  ],
                },
              ],
              generationConfig: { maxOutputTokens: 20, temperature: 0 },
            }),
            cache: 'no-store',
            signal: controller.signal,
          })
          clearTimeout(timeout)
          if (!res.ok) {
            const errText = await res.text().catch(() => '')
            if (res.status === 429) {
              rateLimitedModels.set(`gemini-${geminiModel}`, Date.now())
              console.warn(`[ai] Gemini ${geminiModel} (vision) rate-limited`)
            } else {
              checkDeprecation(`gemini-${geminiModel}`, res.status, errText)
            }
            return null
          }
          const data = await res.json()
          const parts = data.candidates?.[0]?.content?.parts || []
          for (const part of parts) {
            if (part.text) return stripThinking(part.text.trim())
          }
          return null
        } catch {
          clearTimeout(timeout)
          return null
        }
      })(),
    )
  }

  if (candidates.length === 0) return null
  try {
    return await Promise.any(candidates)
  } catch {
    return null
  }
}

// ---------- Groq ----------
async function callGroq(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  maxTokens: number = 400,
): Promise<string | null> {
  if (!GROQ_API_KEY) return null
  const controller = new AbortController()
  // 7s: gpt-oss-120b regularly takes 4-6s; the old 4s timeout killed it
  // even when it was about to answer.
  const timeout = setTimeout(() => controller.abort(), 7000)

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.5,
      }),
      cache: 'no-store',
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      const key = `groq-${model}`

      if (res.status === 429) {
        rateLimitedModels.set(key, Date.now())
        recordHealth('groq', model, '429') // shared across ALL instances
        diag(`groq ${model}: 429 rate-limited`)
      } else {
        // Check for deprecation — auto-deprecate if detected
        checkDeprecation(key, res.status, errText)
        if (res.status !== 404) recordHealth('groq', model, 'fail')
        diag(`groq ${model}: ${res.status} ${errText.slice(0, 120)}`)
      }
      return null
    }

    const data = await res.json()
    consecutive404s.delete(`groq-${model}`)
    const answer = stripThinking(data.choices?.[0]?.message?.content?.trim() || '') || null
    if (answer) recordHealth('groq', model, 'ok')
    return answer
  } catch {
    clearTimeout(timeout)
    diag(`groq ${model}: timeout/error after ${7000}ms`)
    return null
  }
}

// ---------- Gemini ----------
async function callGemini(
  systemPrompt: string,
  userPrompt: string,
  model: string = 'gemini-2.0-flash',
  useSearch: boolean = false,
  maxTokens: number = 400,
): Promise<string | null> {
  if (!GEMINI_API_KEY) return null
  const controller = new AbortController()
  // Search grounding needs longer (the model runs tool calls first).
  const timeoutMs = useSearch ? 9000 : 6000
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const url = `${GEMINI_URL}/${model}:generateContent?key=${GEMINI_API_KEY}`
    const body: Record<string, unknown> = {
      contents: [
        { role: 'user', parts: [{ text: `${systemPrompt}\n\nUser: ${userPrompt}` }] },
      ],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.5,
      },
    }
    if (useSearch) {
      body.tools = [{ googleSearch: {} }]
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      const key = `gemini-${model}`

      if (res.status === 429) {
        rateLimitedModels.set(key, Date.now())
        recordHealth('gemini', model, '429') // shared across ALL instances
        diag(`gemini ${model}: 429 rate-limited`)
      } else {
        checkDeprecation(key, res.status, errText)
        if (res.status !== 404) recordHealth('gemini', model, 'fail')
        diag(`gemini ${model}: ${res.status} ${errText.slice(0, 120)}`)
      }
      return null
    }

    const data = await res.json()
    consecutive404s.delete(`gemini-${model}`)
    const parts: Array<{ text?: string; thought?: boolean }> =
      data.candidates?.[0]?.content?.parts || []
    // Gemini 2.5+ thinking models emit their reasoning as a part with
    // thought:true BEFORE the answer part — take the first NON-thought
    // text part (falling back to any text part for older models).
    const answerPart = parts.find((p) => p.text && !p.thought) || parts.find((p) => p.text)
    if (answerPart?.text) {
      const answer = stripThinking(answerPart.text.trim())
      if (answer) recordHealth('gemini', model, 'ok')
      return answer || null
    }
    return null
  } catch {
    clearTimeout(timeout)
    diag(`gemini ${model}: timeout/error after ${timeoutMs}ms`)
    return null
  }
}

// ---------- OpenRouter ----------
async function callOpenRouter(
  systemPrompt: string,
  userPrompt: string,
  useWebSearch: boolean,
  maxTokens: number = 400,
): Promise<string | null> {
  if (!OPENROUTER_API_KEY) return null

  // Web search: OpenRouter DEPRECATED the `plugins: [{id: 'web'}]` body
  // param in favour of appending `:online` to the model name. We try the
  // modern suffix first and fall back to the legacy plugins body if the
  // suffix is rejected (belt + braces while the API migrates).
  const disc = await getDiscoveredModels()
  const candidates = openRouterCandidates(disc.openrouter)

  for (let attempt = 0; attempt < candidates.length; attempt++) {
    const model = candidates[attempt]
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    try {
      const body: Record<string, unknown> = {
        model: useWebSearch ? `${model}:online` : model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.5,
      }

      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://neutralwire.org',
          'X-Title': 'NeutralWire',
        },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        // SELF-REPORTING: every OpenRouter failure goes into the diag
        // array — the 502 response now says which model failed with what
        // status (previously these were console.warn-only and invisible,
        // which is why OpenRouter looked like it failed "silently").
        diag(`openrouter ${model}: ${res.status} ${errText.slice(0, 120)}`)

        // 401/403 = key problem → the whole provider is dead, stop.
        if (res.status === 401 || res.status === 403) {
          deprecatedModels.set('openrouter', Date.now())
          return null
        }
        // 429 (daily free cap / RPM) on ONE model often means the whole
        // free pool is capped for now — rotating just burns another
        // request, so stop after logging. Other errors (404 model gone,
        // 400 bad request) → rotate to the next candidate model.
        if (res.status === 429) {
          recordHealth('openrouter', model, '429')
          return null
        }
        if (res.status === 404) {
          recordHealth('openrouter', model, '404')
          void invalidateDiscovery(`openrouter ${model} 404`)
        } else {
          recordHealth('openrouter', model, 'fail')
        }
        continue
      }

      const data = await res.json()
      const answer = stripThinking(data.choices?.[0]?.message?.content?.trim() || '')
      if (answer) {
        recordHealth('openrouter', model, 'ok')
        return answer
      }

      // `:online` suffix rejected for this model? Retry once with the
      // legacy plugins body before rotating.
      if (useWebSearch) {
        try {
          const legacyRes = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://neutralwire.org',
              'X-Title': 'NeutralWire',
            },
            body: JSON.stringify({
              ...body,
              model,
              plugins: [{ id: 'web' }],
            }),
            cache: 'no-store',
            signal: AbortSignal.timeout(5000),
          })
          if (legacyRes.ok) {
            const legacyData = await legacyRes.json()
            const legacyAnswer = stripThinking(
              legacyData.choices?.[0]?.message?.content?.trim() || '',
            )
            if (legacyAnswer) {
              recordHealth('openrouter', model, 'ok')
              return legacyAnswer
            }
          }
        } catch {
          // legacy retry failed — rotate to next model
        }
      }
      diag(`openrouter ${model}: empty answer`)
    } catch (err) {
      clearTimeout(timeout)
      diag(`openrouter ${model}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return null
}
