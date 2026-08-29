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
const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
]

// Groq: text models in preference order. Discovery filters to what the
// key can actually access.
const GROQ_MODELS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'llama-3.3-70b-versatile',
  'qwen/qwen3-32b',
  'llama-3.1-8b-instant',
]

// ── LIVE MODEL DISCOVERY ──
// One-time per server instance: fetch each provider's model list and
// intersect it with our preferences. Solves the recurring failure mode
// where a hallucinated or retired model ID made every call to that
// provider 404 — the main cause of "cannot reach AI provider" (502).
// Discovery failures are non-fatal: we fall back to the static lists.
interface DiscoveredModels {
  gemini: string[] | null
  groq: string[] | null
  openrouter: string[] | null
}
let discovered: DiscoveredModels | null = null
let discoveryInFlight: Promise<DiscoveredModels> | null = null

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
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

async function discoverProviderModels(): Promise<DiscoveredModels> {
  const [geminiList, groqList, orList] = await Promise.all([
    GEMINI_API_KEY
      ? fetchJson(`${GEMINI_URL}?key=${GEMINI_API_KEY}&pageSize=200`, {}).then(
          (d) => (d as { models?: Array<{ name?: string }> })?.models
              ?.map((m) => (m.name || '').replace(/^models\//, ''))
              .filter(Boolean) ?? null,
        )
      : Promise.resolve(null),
    GROQ_API_KEY
      ? fetchJson(GROQ_MODELS_URL, { Authorization: `Bearer ${GROQ_API_KEY}` }).then(
          (d) => (d as { data?: Array<{ id?: string }> })?.data
              ?.map((m) => m.id || '')
              .filter(Boolean) ?? null,
        )
      : Promise.resolve(null),
    OPENROUTER_API_KEY
      ? fetchJson(OPENROUTER_MODELS_URL, { Authorization: `Bearer ${OPENROUTER_API_KEY}` }).then(
          (d) => (d as { data?: Array<{ id?: string }> })?.data
              ?.map((m) => m.id || '')
              .filter(Boolean) ?? null,
        )
      : Promise.resolve(null),
  ])

  const result: DiscoveredModels = {
    // Keep the preference ORDER but only models that exist in the live list.
    gemini: geminiList ? GEMINI_MODELS.filter((m) => geminiList.includes(m)) : null,
    groq: groqList ? GROQ_MODELS.filter((m) => groqList.includes(m)) : null,
    openrouter: orList ? OPENROUTER_MODELS.filter((m) => orList.includes(m)) : null,
  }
  console.log(
    `[ai] model discovery: gemini=${result.gemini?.length ?? 'n/a'} groq=${result.groq?.length ?? 'n/a'} openrouter=${result.openrouter?.length ?? 'n/a'}`,
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

/** Effective model list for a provider: discovered ∩ preferred, falling
 *  back to the static preference list when discovery failed. */
function effectiveModels(
  discoveredList: string[] | null,
  preferred: string[],
): string[] {
  if (discoveredList && discoveredList.length > 0) return discoveredList
  return preferred
}

// ── Auto-deprecation detection ──
// When a model returns 404 or a deprecation error, it's added here and
// skipped for ALL future calls in this server instance. This makes the
// fallback chain self-healing — when a provider retires a model, the
// system automatically stops using it without needing a code update.
const deprecatedModels = new Set<string>()

const OPENROUTER_MODEL = 'google/gemma-4-26b-a4b-it:free'
const GROQ_COMPOUND_MODEL = 'compound-beta'

// OpenRouter free-model preferences. The first one found in the LIVE model
// list is used (discovery filters); the old single hard-coded ID 404'd
// permanently when OpenRouter retired it — another "cannot reach AI
// provider" contributor.
const OPENROUTER_MODELS = [
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-3-27b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'qwen/qwen-2.5-72b-instruct:free',
]

/** First OpenRouter preference that exists in the discovered list. */
function pickOpenRouterModel(discoveredList: string[] | null): string {
  if (discoveredList) {
    const found = OPENROUTER_MODELS.find((m) => discoveredList.includes(m))
    if (found) return found
  }
  return OPENROUTER_MODEL
}

interface ChatCall {
  systemPrompt: string
  userPrompt: string
  /** Optional max output tokens. Default 400. Set higher for long summaries. */
  maxTokens?: number
}

let lastProvider = 'none'

export function getLastProvider(): string {
  return lastProvider
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
  // If the response has thinking as plain text before **The Big Picture**,
  // strip everything before the first ** heading
  const firstHeading = cleaned.indexOf('**')
  if (firstHeading > 0) {
    const beforeHeading = cleaned.slice(0, firstHeading).trim()
    // Only strip if the text before the heading looks like thinking
    // (not empty, not already a heading)
    if (beforeHeading.length > 20 && !beforeHeading.startsWith('**')) {
      cleaned = cleaned.slice(firstHeading)
    }
  }
  return cleaned.trim()
}

/**
 * Check if a model has been auto-deprecated (returned 404 or deprecation
 * error in a previous call). Deprecated models are skipped entirely.
 */
function isDeprecated(key: string): boolean {
  return deprecatedModels.has(key)
}

/**
 * Mark a model as deprecated based on the API response.
 *
 * Triggers on:
 *   - HTTP 404 (model not found)
 *   - HTTP 400 with "deprecat" / "decommission" / "not available" in the error
 *   - Any response containing "has been deprecated" or "is no longer supported"
 */
function checkDeprecation(key: string, status: number, errText: string): boolean {
  const lowerErr = errText.toLowerCase()
  if (
    status === 404 ||
    (status === 400 && (lowerErr.includes('deprecat') || lowerErr.includes('decommission') || lowerErr.includes('not available'))) ||
    lowerErr.includes('has been deprecated') ||
    lowerErr.includes('is no longer supported') ||
    lowerErr.includes('model_not_found')
  ) {
    if (!deprecatedModels.has(key)) {
      deprecatedModels.add(key)
      console.warn(`[ai] Auto-deprecated ${key} (status ${status}: ${errText.slice(0, 100)})`)
    }
    return true
  }
  return false
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

  // Make sure model discovery has run (no-op after the first call).
  const disc = await getDiscoveredModels()
  const geminiModels = effectiveModels(disc.gemini, GEMINI_MODELS)
  const groqModels = effectiveModels(disc.groq, GROQ_MODELS)

  // Pick up to 2 available models per provider (skip deprecated + rate-limited)
  const available = (keys: Array<{ key: string; model: string }>) =>
    keys.filter(({ key }) => {
      if (isDeprecated(key)) return false
      const limitedAt = rateLimitedModels.get(key)
      return !limitedAt || now - limitedAt >= RATE_LIMIT_COOLDOWN_MS
    })

  const geminiAvail = available(geminiModels.map((m) => ({ key: `gemini-${m}`, model: m }))).slice(0, 2)
  const groqAvail = available(groqModels.map((m) => ({ key: `groq-${m}`, model: m }))).slice(0, 2)

  // 1+2. Fire off up to TWO models from BOTH Gemini and Groq in parallel —
  // if the first model is rate-limited or slow, the second still races.
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

  // 5. Sequential retry: remaining models not yet tried
  for (const model of geminiModels) {
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
  for (const model of groqModels) {
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

  // Make sure model discovery has run (no-op after the first call).
  const disc = await getDiscoveredModels()
  const geminiModels = effectiveModels(disc.gemini, GEMINI_MODELS)

  const modelOk = (key: string) => {
    if (isDeprecated(key)) return false
    const limitedAt = rateLimitedModels.get(key)
    return !limitedAt || now - limitedAt >= RATE_LIMIT_COOLDOWN_MS
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
    const groqModels = effectiveModels(disc.groq, GROQ_MODELS)
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

  // 4. Race them
  if (candidates.length > 0) {
    try {
      const answer = await Promise.any(candidates)
      if (answer) {
        lastProvider = 'AI (web search, parallel)'
        return answer
      }
    } catch {
      // All failed — fall through to sequential retry
    }
  }

  // 5. Sequential retry on remaining Gemini models WITH search
  for (const model of geminiModels) {
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

  // 6. Last resort: ANY regular model WITHOUT web search. The caller's
  //    system prompt said to use ({/compound}) only when it genuinely
  //    can't answer from training data, so this path is rare — but an
  //    honest "here's what I know, may be outdated" answer beats a
  //    refusal. The caveat prefix tells the user it's not live info.
  const noSearchAnswer = await callAI(opts)
  if (noSearchAnswer) {
    lastProvider = 'AI (training-data fallback)'
    return `(From my training data — may not reflect the latest developments:) ${noSearchAnswer}`
  }
  return null
}

// ---------- Vision (image understanding) ----------
// Used to verify that a candidate topic image actually SHOWS something
// related to the story (e.g. not a supermarket storefront on a
// Netanyahu headline). Groq llama-4-scout and Gemini flash are both
// multimodal and cheap; we race them and take the first answer.
const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'
const GEMINI_VISION_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash']

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
        console.warn(`[ai] Groq ${model} rate-limited`)
      } else {
        // Check for deprecation — auto-deprecate if detected
        checkDeprecation(key, res.status, errText)
        if (!deprecatedModels.has(key)) {
          console.warn(`[ai] Groq ${model} ${res.status}: ${errText.slice(0, 200)}`)
        }
      }
      return null
    }

    const data = await res.json()
    return stripThinking(data.choices?.[0]?.message?.content?.trim() || '') || null
  } catch {
    clearTimeout(timeout)
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
        console.warn(`[ai] Gemini ${model} rate-limited`)
      } else {
        checkDeprecation(key, res.status, errText)
        if (!deprecatedModels.has(key)) {
          console.warn(`[ai] Gemini ${model} ${res.status}: ${errText.slice(0, 200)}`)
        }
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
}

// ---------- OpenRouter ----------
async function callOpenRouter(
  systemPrompt: string,
  userPrompt: string,
  useWebSearch: boolean,
  maxTokens: number = 400,
): Promise<string | null> {
  if (!OPENROUTER_API_KEY) return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)

  try {
    // Web search: OpenRouter DEPRECATED the `plugins: [{id: 'web'}]` body
    // param in favour of appending `:online` to the model name. We try the
    // modern suffix first and fall back to the legacy plugins body if the
    // suffix is rejected (belt + braces while the API migrates).
    const disc = await getDiscoveredModels()
    const model = pickOpenRouterModel(disc.openrouter)
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
      // The `:online` suffix can fail on models that don't support it —
      // retry ONCE with the legacy plugins body before giving up.
      if (useWebSearch && (res.status === 400 || res.status === 404)) {
        try {
          const legacyBody = {
            ...body,
            model: model,
            plugins: [{ id: 'web' }],
          }
          const legacyRes = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://neutralwire.org',
              'X-Title': 'NeutralWire',
            },
            body: JSON.stringify(legacyBody),
            cache: 'no-store',
            signal: controller.signal,
          })
          if (legacyRes.ok) {
            const legacyData = await legacyRes.json()
            return (
              stripThinking(legacyData.choices?.[0]?.message?.content?.trim() || '') || null
            )
          }
        } catch {
          // legacy retry failed — fall through
        }
      }
      checkDeprecation('openrouter', res.status, errText)
      if (!deprecatedModels.has('openrouter')) {
        console.warn(`[ai] OpenRouter ${res.status} (web=${useWebSearch}): ${errText.slice(0, 200)}`)
      }
      return null
    }

    const data = await res.json()
    return stripThinking(data.choices?.[0]?.message?.content?.trim() || '') || null
  } catch (err) {
    clearTimeout(timeout)
    console.warn('[ai] OpenRouter failed:', err instanceof Error ? err.message : err)
    return null
  }
}
