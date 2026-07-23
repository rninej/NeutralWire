/**
 * Multi-provider AI fallback chain (optimized for fast parallel execution).
 *
 * Call order (first that works wins, all in parallel):
 * 1. Gemini — multiple models in parallel (free, with optional Google Search)
 * 2. Groq — llama-3.3-70b-versatile + openai/gpt-oss-120b (free)
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
 */

const GROQ_API_KEY = process.env.GROQ_API_KEY || ''
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || ''
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

// ── Gemini models ──
// Only include models that actually exist (verified via API).
// Deprecated models (1.5-*) and non-existent models (3.1-pro, 3-flash)
// have been removed to avoid wasting time on 404s.
// gemini-2.5-flash/flash-lite are marked "no longer available to new users"
// but may still work on some accounts — kept as last resort.
const GEMINI_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
]

// ── Groq models ──
const GROQ_MODELS = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b']

// Track rate-limited models to skip them in future calls (per-process)
const rateLimitedModels = new Map<string, number>()
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000

const OPENROUTER_MODEL = 'google/gemma-4-26b-a4b-it:free'
const GROQ_COMPOUND_MODEL = 'compound-beta'

interface ChatCall {
  systemPrompt: string
  userPrompt: string
}

let lastProvider = 'none'

export function getLastProvider(): string {
  return lastProvider
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
  const candidates: Array<Promise<string | null>> = []

  // 1. Fire off the first available Gemini model
  const firstGemini = GEMINI_MODELS.find((m) => {
    const limitedAt = rateLimitedModels.get(`gemini-${m}`)
    return !limitedAt || now - limitedAt >= RATE_LIMIT_COOLDOWN_MS
  })
  if (firstGemini && GEMINI_API_KEY) {
    candidates.push(callGemini(opts.systemPrompt, opts.userPrompt, firstGemini, false))
  }

  // 2. Fire off the first available Groq model
  if (GROQ_API_KEY) {
    const firstGroq = GROQ_MODELS.find((m) => {
      const limitedAt = rateLimitedModels.get(`groq-${m}`)
      return !limitedAt || now - limitedAt >= RATE_LIMIT_COOLDOWN_MS
    })
    if (firstGroq) {
      candidates.push(callGroq(opts.systemPrompt, opts.userPrompt, firstGroq))
    }
  }

  // 3. Fire off OpenRouter (last resort but parallel for speed)
  if (OPENROUTER_API_KEY) {
    candidates.push(callOpenRouter(opts.systemPrompt, opts.userPrompt, false))
  }

  // 4. Race them — first NON-NULL answer wins.
  // We can't use Promise.any directly because it returns the first resolved
  // value even if it's null. Instead, we wrap each promise to reject on null
  // so Promise.any only resolves when a real answer comes through.
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

  // 5. Sequential retry: try remaining Gemini models not yet tried
  for (const model of GEMINI_MODELS) {
    if (model === firstGemini) continue
    const limitedAt = rateLimitedModels.get(`gemini-${model}`)
    if (limitedAt && now - limitedAt < RATE_LIMIT_COOLDOWN_MS) continue

    const answer = await callGemini(opts.systemPrompt, opts.userPrompt, model, false)
    if (answer) {
      lastProvider = `Gemini ${model}`
      return answer
    }
  }

  // 6. Try remaining Groq models
  for (const model of GROQ_MODELS) {
    const limitedAt = rateLimitedModels.get(`groq-${model}`)
    if (limitedAt && now - limitedAt < RATE_LIMIT_COOLDOWN_MS) continue

    const answer = await callGroq(opts.systemPrompt, opts.userPrompt, model)
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

  // 1. Fire off the first available Gemini model WITH Google Search
  const firstGemini = GEMINI_MODELS.find((m) => {
    const limitedAt = rateLimitedModels.get(`gemini-${m}`)
    return !limitedAt || now - limitedAt >= RATE_LIMIT_COOLDOWN_MS
  })
  if (firstGemini && GEMINI_API_KEY) {
    candidates.push(callGemini(opts.systemPrompt, opts.userPrompt, firstGemini, true))
  }

  // 2. Groq compound-beta in parallel
  if (GROQ_API_KEY) {
    candidates.push(callGroq(opts.systemPrompt, opts.userPrompt, GROQ_COMPOUND_MODEL))
  }

  // 3. OpenRouter with web search in parallel
  if (OPENROUTER_API_KEY) {
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
  for (const model of GEMINI_MODELS) {
    if (model === firstGemini) continue
    const limitedAt = rateLimitedModels.get(`gemini-${model}`)
    if (limitedAt && now - limitedAt < RATE_LIMIT_COOLDOWN_MS) continue

    const answer = await callGemini(opts.systemPrompt, opts.userPrompt, model, true)
    if (answer) {
      lastProvider = `Gemini ${model} (Google Search)`
      return answer
    }
  }

  return null
}

// ---------- Groq ----------
async function callGroq(
  systemPrompt: string,
  userPrompt: string,
  model: string,
): Promise<string | null> {
  if (!GROQ_API_KEY) return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 4000)

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
        max_tokens: 400,
        temperature: 0.5,
      }),
      cache: 'no-store',
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      if (res.status === 429) {
        rateLimitedModels.set(`groq-${model}`, Date.now())
        console.warn(`[ai] Groq ${model} rate-limited`)
      } else {
        const errText = await res.text().catch(() => '')
        console.warn(`[ai] Groq ${model} ${res.status}: ${errText.slice(0, 200)}`)
      }
      return null
    }

    const data = await res.json()
    return data.choices?.[0]?.message?.content?.trim() || null
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
): Promise<string | null> {
  if (!GEMINI_API_KEY) return null
  const controller = new AbortController()
  // Search-enabled calls get a slightly longer timeout (search takes time)
  const timeoutMs = useSearch ? 6000 : 4000
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const url = `${GEMINI_URL}/${model}:generateContent?key=${GEMINI_API_KEY}`
    const body: Record<string, unknown> = {
      contents: [
        { role: 'user', parts: [{ text: `${systemPrompt}\n\nUser: ${userPrompt}` }] },
      ],
      generationConfig: {
        maxOutputTokens: 400,
        temperature: 0.5,
      },
    }
    // Only attach the googleSearch tool when explicitly requested.
    // Attaching it for every call makes simple questions slow.
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
      if (res.status === 429) {
        rateLimitedModels.set(`gemini-${model}`, Date.now())
        console.warn(`[ai] Gemini ${model} rate-limited`)
      } else {
        const errText = await res.text().catch(() => '')
        console.warn(`[ai] Gemini ${model} ${res.status}: ${errText.slice(0, 200)}`)
      }
      return null
    }

    const data = await res.json()
    // Gemini may return text in parts[0].text or parts[1].text (when
    // grounding metadata is included). Try both.
    const parts = data.candidates?.[0]?.content?.parts || []
    for (const part of parts) {
      if (part.text) return part.text.trim()
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
): Promise<string | null> {
  if (!OPENROUTER_API_KEY) return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const body: Record<string, unknown> = {
      model: OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 400,
      temperature: 0.5,
    }
    if (useWebSearch) body.plugins = [{ id: 'web' }]

    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://neutralwire.vercel.app',
        'X-Title': 'NeutralWire',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      console.warn(`[ai] OpenRouter ${res.status} (web=${useWebSearch}): ${errText.slice(0, 200)}`)
      return null
    }

    const data = await res.json()
    return data.choices?.[0]?.message?.content?.trim() || null
  } catch (err) {
    clearTimeout(timeout)
    console.warn('[ai] OpenRouter failed:', err instanceof Error ? err.message : err)
    return null
  }
}
