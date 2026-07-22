/**
 * Multi-provider AI fallback chain.
 *
 * Call order (first that works wins):
 * 1. Groq — llama-3.3-70b-versatile (free)
 * 2. Groq — openai/gpt-oss-120b (free)
 * 3. Gemini API
 * 4. OpenRouter — google/gemma-4-26b-a4b-it:free
 *
 * Each provider is tried in order. The first one that returns a valid
 * answer wins. This maximizes free quota usage across multiple providers.
 *
 * For compound (web search) fallback:
 * 1. Groq — compound-beta
 * 2. OpenRouter — with plugins: [{id: 'web'}]
 */

const GROQ_API_KEY = process.env.GROQ_API_KEY || ''
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || ''
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

// Models for each provider
const GROQ_MODELS = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b']

// Multiple Gemini models — cycled through when one hits rate limits
const GEMINI_MODELS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.5-flash-preview-05-20',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',
]

const OPENROUTER_MODEL = 'google/gemma-4-26b-a4b-it:free'

// Compound models (web search)
const GROQ_COMPOUND_MODEL = 'compound-beta'

interface ChatCall {
  systemPrompt: string
  userPrompt: string
}

// Track which provider last returned a result (for debug mode)
let lastProvider = 'none'

export function getLastProvider(): string {
  return lastProvider
}

/**
 * Try multiple AI providers in order. Returns the answer or null.
 */
export async function callAI(opts: ChatCall): Promise<string | null> {
  // 1. Try ALL Gemini models first (free, has Google Search built in)
  for (const model of GEMINI_MODELS) {
    const answer = await callGemini(opts.systemPrompt, opts.userPrompt, model)
    if (answer) {
      lastProvider = `Gemini ${model}`
      return answer
    }
  }

  // 2. Try Groq models in order
  for (const model of GROQ_MODELS) {
    const answer = await callGroq(opts.systemPrompt, opts.userPrompt, model)
    if (answer) {
      lastProvider = `Groq ${model}`
      return answer
    }
  }

  // 3. Try OpenRouter (last resort)
  const openrouterAnswer = await callOpenRouter(opts.systemPrompt, opts.userPrompt, false)
  if (openrouterAnswer) {
    lastProvider = `OpenRouter ${OPENROUTER_MODEL}`
    return openrouterAnswer
  }

  return null
}

/**
 * Try compound (web search) providers in order.
 */
export async function callAICompound(opts: ChatCall): Promise<string | null> {
  // 1. Try ALL Gemini models with Google Search (free, built-in grounding)
  for (const model of GEMINI_MODELS) {
    const answer = await callGemini(opts.systemPrompt, opts.userPrompt, model)
    if (answer) {
      lastProvider = `Gemini ${model} (Google Search)`
      return answer
    }
  }

  // 2. Try Groq compound
  if (GROQ_API_KEY) {
    const answer = await callGroq(opts.systemPrompt, opts.userPrompt, GROQ_COMPOUND_MODEL)
    if (answer) {
      lastProvider = `Groq ${GROQ_COMPOUND_MODEL}`
      return answer
    }
  }

  // 3. Try OpenRouter with web search
  if (OPENROUTER_API_KEY) {
    const answer = await callOpenRouter(opts.systemPrompt, opts.userPrompt, true)
    if (answer) {
      lastProvider = `OpenRouter ${OPENROUTER_MODEL} (web)`
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
  const timeout = setTimeout(() => controller.abort(), 8000)

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
      console.warn(`[ai] Groq ${model} ${res.status}`)
      return null
    }

    const data = await res.json()
    return data.choices?.[0]?.message?.content?.trim() || null
  } catch (err) {
    clearTimeout(timeout)
    console.warn(`[ai] Groq ${model} failed:`, err instanceof Error ? err.message : err)
    return null
  }
}

// ---------- Gemini ----------
async function callGemini(
  systemPrompt: string,
  userPrompt: string,
  model: string = 'gemini-2.0-flash',
): Promise<string | null> {
  if (!GEMINI_API_KEY) return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)

  try {
    // Use generateContent with Google Search grounding enabled
    const url = `${GEMINI_URL}/${model}:generateContent?key=${GEMINI_API_KEY}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: `${systemPrompt}\n\nUser: ${userPrompt}` }] }
        ],
        generationConfig: {
          maxOutputTokens: 400,
          temperature: 0.5,
        },
        tools: [{ googleSearch: {} }],
      }),
      cache: 'no-store',
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      console.warn(`[ai] Gemini ${res.status}: ${errText.slice(0, 200)}`)
      return null
    }

    const data = await res.json()
    // Gemini with Google Search returns the text in the same structure
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    return text || null
  } catch (err) {
    clearTimeout(timeout)
    console.warn('[ai] Gemini failed:', err instanceof Error ? err.message : err)
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
  const timeout = setTimeout(() => controller.abort(), 9000)

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
      console.warn(`[ai] OpenRouter ${res.status} (web=${useWebSearch})`)
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
