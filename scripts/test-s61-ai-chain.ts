/**
 * test-s61-ai-chain.ts — integration tests for the Nov 2026 AI-chain fix
 * (the "every article must flawlessly generate its proper summary" session).
 *
 * Each scenario runs in its OWN `bun scripts/test-s61-ai-chain.ts <name>`
 * process so module-level state (cooldowns, discovery memo, health cache)
 * never leaks between scenarios. A local mock server plays all four
 * endpoints (Gemini, Groq, OpenRouter, Firebase) via the env-overridable
 * URLs the production code already exposes (AI_GEMINI_BASE, AI_GROQ_URL,
 * AI_OPENROUTER_URL, AI_HEALTH_DB_URL, FB_DB_URL, AI_RATE_LIMIT_COOLDOWN_MS,
 * AI_CALL_BUDGET_MS).
 *
 * Scenarios:
 *   or-rotate        OpenRouter upstream-429 rotates to the next host and wins
 *   or-account       account-level 429 stops the whole provider (no rotation)
 *   gemini-daily     daily-cap 429 → long cooldown, no rescue re-probing
 *   wait-retry       RPM cooldown lapses inside the budget → sleep → real answer
 *   summary-backoff  negative-result backoff (interactive vs background)
 *
 * Usage: bun scripts/test-s61-ai-chain.ts <scenario>
 */

const PORT = 4599
const BASE = `http://localhost:${PORT}`
const scenario = process.argv[2] || ''

// ── Scenario-specific env — MUST be set before the modules are imported ──
process.env.GEMINI_API_KEY = 'test-g'
process.env.GROQ_API_KEY = 'test-k'
process.env.OPENROUTER_API_KEY = 'test-o'
process.env.AI_GEMINI_BASE = `${BASE}/gemini`
process.env.AI_GROQ_URL = `${BASE}/groq/openai/v1/chat/completions`
process.env.AI_GROQ_MODELS_URL = `${BASE}/groq/openai/v1/models`
process.env.AI_OPENROUTER_URL = `${BASE}/or/api/v1/chat/completions`
process.env.AI_OPENROUTER_MODELS_URL = `${BASE}/or/api/v1/models`
process.env.AI_HEALTH_DB_URL = `${BASE}/fb`
process.env.FB_DB_URL = `${BASE}/fb`
process.env.AI_RATE_LIMIT_COOLDOWN_MS = '60000'
process.env.AI_CALL_BUDGET_MS = '11000'
if (scenario === 'wait-retry') process.env.AI_RATE_LIMIT_COOLDOWN_MS = '3000'
if (scenario === 'summary-backoff') {
  process.env.AI_CALL_BUDGET_MS = '1500'
  process.env.AI_RATE_LIMIT_COOLDOWN_MS = '1000' // cooldowns lapse fast so step 4 can succeed
}

// ── Mock endpoint state ────────────────────────────────────────────────────
type Mode =
  | 'ok'
  | 'fail-429-rpm' // 429 + retryDelay "26s"
  | 'fail-429-daily' // 429 + PerDay metric + retryDelay "43200s"
  | 'fail-429-plain' // 429, no hints (falls back to RATE_LIMIT_COOLDOWN_MS)
  | 'fail-429-upstream' // OpenRouter upstream capacity body
  | 'fail-429-account' // OpenRouter account free-models cap body
  | 'ok-second-try' // FIRST request fails 429-plain, every later request succeeds

const state = {
  gemini: 'fail-429-rpm' as Mode,
  groq: 'fail-429-rpm' as Mode,
  or: {} as Record<string, Mode>, // per-model modes (unset = fail-429-upstream)
  db: {} as Record<string, unknown>, // mock Firebase store
  counts: { gemini: 0, groq: 0, or: 0, orPerModel: {} as Record<string, number> },
  attempts: {} as Record<string, number>, // per provider-model request counter
  puts: [] as Array<{ path: string; body: string }>, // Firebase write log
}

const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest']
const GROQ_MODELS = ['openai/gpt-oss-120b']
const OR_MODELS = [
  'google/gemma-4-26b-a4b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-chat-v3-0324:free',
]

// ── The mock server ────────────────────────────────────────────────────────
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const path = new URL(req.url).pathname

    // ---- Gemini (AI_GEMINI_BASE replaces the whole .../v1beta/models
    // prefix, so the real paths are /gemini and /gemini/<model>:generateContent) ----
    if (path.startsWith('/gemini')) {
      const genMatch = path.match(/^\/gemini\/([^:]+):generateContent$/)
      if (genMatch) {
        const model = decodeURIComponent(genMatch[1])
        state.counts.gemini++
        const mode = effectiveMode(state.gemini, `gemini-${model}`)
        const r = modeResponse(mode, `GEMINI ${model} ANSWER.`, 'gemini', model)
        return respond(r.status, r.body)
      }
      if (path === '/gemini') {
        return json(200, { models: GEMINI_MODELS.map((m) => ({ name: `models/${m}` })) })
      }
      return json(404, {})
    }

    // ---- Groq ----
    if (path.startsWith('/groq/')) {
      if (path === '/groq/openai/v1/chat/completions' && req.method === 'POST') {
        const body = (await req.json()) as { model?: string }
        const model = body.model || 'unknown'
        state.counts.groq++
        const r = modeResponse(effectiveMode(state.groq, `groq-${model}`), `GROQ ${model} ANSWER.`, 'groq', model)
        return respond(r.status, r.body)
      }
      if (path === '/groq/openai/v1/models') {
        return json(200, { data: GROQ_MODELS.map((id) => ({ id })) })
      }
      return json(404, {})
    }

    // ---- OpenRouter ----
    if (path.startsWith('/or/')) {
      if (path === '/or/api/v1/chat/completions' && req.method === 'POST') {
        const body = (await req.json()) as { model?: string }
        const model = (body.model || 'unknown').replace(/:online$/, '')
        state.counts.or++
        state.counts.orPerModel[model] = (state.counts.orPerModel[model] || 0) + 1
        const r = modeResponse(state.or[model] || 'fail-429-upstream', `OR ${model} ANSWER.`, 'openrouter', model)
        return respond(r.status, r.body)
      }
      if (path === '/or/api/v1/models') {
        return json(200, { data: OR_MODELS.map((id) => ({ id })) })
      }
      return json(404, {})
    }

    // ---- Mock Firebase ----
    if (path.startsWith('/fb/')) {
      const clean = path.replace(/^\/fb\//, '').replace(/\.json$/, '')
      if (req.method === 'GET') return json(200, readNode(state.db, clean))
      if (req.method === 'PUT') {
        const text = await req.text()
        state.puts.push({ path: clean, body: text })
        if (text === 'null' || text === '') deleteNode(state.db, clean)
        else writeNode(state.db, clean, JSON.parse(text))
        return json(200, null)
      }
      if (req.method === 'PATCH') {
        const text = await req.text()
        state.puts.push({ path: clean, body: text })
        const existing = readNode(state.db, clean)
        const merged =
          existing && typeof existing === 'object'
            ? { ...(existing as object), ...JSON.parse(text) }
            : JSON.parse(text)
        writeNode(state.db, clean, merged)
        return json(200, null)
      }
      return json(405, { err: 'method' })
    }

    return json(404, { err: `no route ${path}` })
  },
})

/** 'ok-second-try' resolves against the per-model attempt counter. */
function effectiveMode(globalMode: Mode, key: string): Mode {
  if (globalMode !== 'ok-second-try') return globalMode
  state.attempts[key] = (state.attempts[key] || 0) + 1
  return state.attempts[key] > 1 ? 'ok' : 'fail-429-plain'
}

function modeResponse(mode: Mode, answerText: string, provider: 'gemini' | 'groq' | 'openrouter', model: string) {
  switch (mode) {
    case 'ok':
      return provider === 'gemini'
        ? { status: 200, body: { candidates: [{ content: { parts: [{ text: answerText }] } }] } }
        : { status: 200, body: { choices: [{ message: { content: answerText } }] } }
    case 'fail-429-rpm':
      return {
        status: 429,
        body: {
          error: {
            code: 429,
            message: `Quota exceeded for quota metric "GenerateRequestsPerMinute" in model ${model}`,
            status: 'RESOURCE_EXHAUSTED',
            details: [{ quotaMetric: 'GenerateRequestsPerMinute', retryDelay: '26s' }],
          },
        },
      }
    case 'fail-429-daily':
      return {
        status: 429,
        body: {
          error: {
            code: 429,
            message: `Quota exceeded for quota metric "GenerateRequestsPerDay" in model ${model}`,
            status: 'RESOURCE_EXHAUSTED',
            details: [{ quotaMetric: 'GenerateRequestsPerDay', retryDelay: '43200s' }],
          },
        },
      }
    case 'fail-429-plain':
      return { status: 429, body: { error: { message: 'rate limited' } } }
    case 'fail-429-upstream':
      return {
        status: 429,
        body: {
          error: {
            message: 'Provider returned error',
            code: 429,
            metadata: { raw: `${model} is temporarily rate-limited due to insufficient capacity` },
          },
        },
      }
    case 'fail-429-account':
      return { status: 429, body: { error: { message: 'Rate limit exceeded: free-models-per-day is reached' } } }
    default:
      return { status: 500, body: { error: { message: 'bad mode' } } }
  }
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
function json(status: number, body: unknown): Response {
  return new Response(body === null ? 'null' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function readNode(db: Record<string, unknown>, path: string): unknown {
  if (!path) return db
  let cur: unknown = db
  for (const p of path.split('/')) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p]
    } else {
      return null
    }
  }
  return cur
}
function writeNode(db: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('/')
  let cur = db
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {}
    cur = cur[p] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}
function deleteNode(db: Record<string, unknown>, path: string): void {
  const parts = path.split('/')
  let cur: unknown = db
  for (let i = 0; i < parts.length - 1; i++) {
    cur = (cur as Record<string, unknown>)[parts[i]]
    if (!cur || typeof cur !== 'object') return
  }
  delete (cur as Record<string, unknown>)[parts[parts.length - 1]]
}

// ── Assertions ────────────────────────────────────────────────────────────
let failures = 0
function assert(cond: unknown, label: string): void {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}`)
  if (!cond) failures++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── Scenarios ─────────────────────────────────────────────────────────────
async function main() {
  const ai = await import('../src/lib/ai-providers')

  if (scenario === 'or-rotate') {
    state.gemini = 'fail-429-rpm'
    state.groq = 'fail-429-rpm'
    state.or = {
      'google/gemma-4-26b-a4b-it:free': 'fail-429-upstream',
      'meta-llama/llama-3.3-70b-instruct:free': 'ok',
      'deepseek/deepseek-chat-v3-0324:free': 'ok',
    }
    const answer = await ai.callAI({ systemPrompt: 's', userPrompt: 'u' })
    assert(answer === 'OR meta-llama/llama-3.3-70b-instruct:free ANSWER.', `rotation wins: ${answer}`)
    assert(state.counts.or === 2, `exactly 2 OpenRouter requests (gemma-4 429 + llama ok), got ${state.counts.or}`)
    assert(
      state.counts.orPerModel['google/gemma-4-26b-a4b-it:free'] === 1,
      'gemma-4 (throttled Google host) tried exactly once',
    )
    assert(ai.aiQuotaPressure() === true, 'quota pressure flagged after the 429s')
    assert(ai.getLastDiagnostics().some((d) => d.includes('upstream')), 'diag shows the upstream classification')
  } else if (scenario === 'or-account') {
    state.gemini = 'fail-429-rpm'
    state.groq = 'fail-429-rpm'
    state.or = {
      'google/gemma-4-26b-a4b-it:free': 'fail-429-account',
      'meta-llama/llama-3.3-70b-instruct:free': 'ok',
    }
    const a1 = await ai.callAI({ systemPrompt: 's', userPrompt: 'u' })
    assert(a1 === null, 'account-cap 429 → no answer from any provider')
    assert(state.counts.or === 1, `only ONE OpenRouter request (no pointless rotation), got ${state.counts.or}`)
    const a2 = await ai.callAI({ systemPrompt: 's', userPrompt: 'u' })
    assert(a2 === null, 'second call also fails (everything cooling)')
    assert(state.counts.or === 1, `openrouter stays cooled on 2nd call, still ${state.counts.or} requests`)
  } else if (scenario === 'gemini-daily') {
    state.gemini = 'fail-429-daily'
    state.groq = 'fail-429-plain'
    state.or = { 'google/gemma-4-26b-a4b-it:free': 'fail-429-upstream' }
    const a1 = await ai.callAI({ systemPrompt: 's', userPrompt: 'u' })
    assert(a1 === null, 'daily-capped everything → null')
    assert(state.counts.gemini === 2, `volley fired both gemini aliases (${state.counts.gemini})`)
    const a2 = await ai.callAI({ systemPrompt: 's', userPrompt: 'u' })
    assert(a2 === null, 'still null while day-capped')
    assert(
      state.counts.gemini === 2,
      `NO gemini re-probe on the 2nd call (55min cooldown, no rescue) — got ${state.counts.gemini}`,
    )
    assert(ai.getLastDiagnostics().some((d) => d.includes('gemini=[NONE]')), '2nd volley diag shows gemini=[NONE]')
    assert(state.counts.groq === 1, `groq org cooldown respected (only the first volley fired), got ${state.counts.groq}`)
  } else if (scenario === 'wait-retry') {
    // 3s rate-limit cooldowns (env) + models that succeed on their SECOND
    // request: the initial volley 429s everything; wait-and-retry sleeps out
    // the 3s window and the re-fired gemini model answers for real.
    state.gemini = 'ok-second-try'
    state.groq = 'fail-429-plain'
    state.or = { 'google/gemma-4-26b-a4b-it:free': 'fail-429-upstream' }
    const t0 = Date.now()
    const answer = await ai.callAI({ systemPrompt: 's', userPrompt: 'u' })
    const dur = Date.now() - t0
    assert(/^GEMINI .* ANSWER\.$/.test(String(answer)), `wait-and-retry produced a REAL answer (${answer})`)
    assert(dur > 2500, `call actually waited out the ~3s cooldown (${dur}ms)`)
    assert(
      state.counts.gemini === 3,
      `one re-fire after the sleep (2 volley + 1 wait shot = 3 gemini requests), got ${state.counts.gemini}`,
    )
    assert(ai.getLastDiagnostics().some((d) => d.includes('wait-and-retry')), 'diag records the wait-and-retry sleep')
    assert(ai.getLastProvider().includes('waited out cooldown'), `lastProvider labels the path (${ai.getLastProvider()})`)
  } else if (scenario === 'summary-backoff') {
    const { getOrCreateGeneration } = await import('../src/lib/summary-generate')
    const body = {
      topicId: 'test-s61',
      title: 'Test story title',
      articles: [
        { title: 'A', description: 'x'.repeat(120), sourceName: 'Src', leaning: 'center' },
        { title: 'B', description: 'y'.repeat(120), sourceName: 'Src2', leaning: 'left' },
      ],
    }

    // 1. Fresh failure marker + BACKGROUND → LLM skipped entirely.
    writeNode(state.db, 'summaryBackoff/test-s61', { failedAt: Date.now() - 2000 })
    const r1 = await getOrCreateGeneration(body, { background: true })
    assert(r1?.fallback === true, 'background + fresh marker → extractive fallback served')
    assert(state.counts.gemini + state.counts.groq + state.counts.or === 0, 'no AI request fired (backoff honored)')

    // 2. Fresh marker + INTERACTIVE → also skipped (60s window).
    const r2 = await getOrCreateGeneration(body)
    assert(r2?.fallback === true, 'interactive + fresh marker → fallback')
    assert(state.counts.gemini + state.counts.groq + state.counts.or === 0, 'still no AI request')

    // 3. Marker 2 minutes old + interactive → window lapsed → LLM fired and
    //    FAILED → fallback served AND a fresh marker written (doom-loop breaker).
    writeNode(state.db, 'summaryBackoff/test-s61', { failedAt: Date.now() - 120_000 })
    state.gemini = 'fail-429-plain'
    state.groq = 'fail-429-plain'
    state.or = { 'google/gemma-4-26b-a4b-it:free': 'fail-429-upstream' }
    const r3 = await getOrCreateGeneration(body)
    assert(r3?.fallback === true, 'LLM failed → extractive fallback')
    assert(state.counts.gemini > 0, 'LLM was actually attempted after the window lapsed')
    await sleep(400) // the marker write is fire-and-forget
    const marker = readNode(state.db, 'summaryBackoff/test-s61') as { failedAt: number } | null
    assert(!!marker && Date.now() - marker.failedAt < 5000, 'failure wrote a FRESH backoff marker')
    assert(readNode(state.db, 'summaries/test-s61') === null, 'fallback NOT persisted to summaries/<id>')

    // 4. Success path: marker lapsed, gemini answers → summaries/<id> written
    //    and the marker CLEARED. (1s cooldown env + a short sleep so the 429
    //    cooldowns from step 3 have lapsed by the time this fires.)
    writeNode(state.db, 'summaryBackoff/test-s61', { failedAt: Date.now() - 120_000 })
    await sleep(1300)
    state.gemini = 'ok'
    const r4 = await getOrCreateGeneration(body)
    assert(r4?.fallback === false, 'LLM success → real summary')
    await sleep(400)
    assert(readNode(state.db, 'summaries/test-s61') != null, 'success persisted to summaries/<id>')
    assert(readNode(state.db, 'summaryBackoff/test-s61') === null, 'success CLEARED the backoff marker')
    const r4text = String(r4?.summary)
    assert(
      r4text.startsWith('GEMINI gemini-flash'),
      `summary text from the model (${r4text.slice(0, 40)})`,
    )
  } else {
    console.log('unknown scenario — use or-rotate | or-account | gemini-daily | wait-retry | summary-backoff')
    server.stop(true)
    process.exit(2)
  }

  console.log(failures === 0 ? `\n${scenario}: ALL PASS` : `\n${scenario}: ${failures} FAILURE(S)`)
  server.stop(true)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('test crash:', err)
  server.stop(true)
  process.exit(1)
})
