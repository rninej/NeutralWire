import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import { callAI } from '@/lib/ai-providers'
import { getRequesterTier } from '@/lib/subscriptions'
import { searchCatalog } from '@/lib/subtopic-catalog'
import { refreshCustomTopic, subscribeCustomTopic, fetchGoogleNews } from '@/lib/custom-topics'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 60

/**
 * POST /api/subtopics/create — the AI subtopic factory (Premium).
 *
 * Body: { name: string }
 *
 * Pipeline (the user spec, in order):
 *   0. Premium check — non-premium callers get 402 + needUpgrade.
 *   1. Is it already in the catalog (static or runtime)? → return existing.
 *   2. AI generates: a clean display label + 4-8 GDELT search keywords.
 *      → AI FALLBACK (the "doesn't work" fix): when callAI is unavailable
 *        (no keys on the box, quota dead, provider outage) the route used
 *        to 503 and creation NEVER worked — the AI was a gate, violating
 *        the site-wide "AI is polish, never a gate" philosophy. Now a
 *        deterministic keyword builder (fallbackLabelAndKeywords) produces
 *        a Title-Case label + phrase/bigram/token keywords, and creation
 *        proceeds exactly the same.
 *   3. VALIDATION against the news flow (quantity + relevance). Google
 *      News RSS is the PRIMARY validator — it is the same source the
 *      feed's primary fill stage uses, so "validates" == "will fill".
 *      GDELT is the secondary. A transport failure on BOTH is NOT a
 *      rejection (the first fill reveals the truth live) — only a
 *      definitive "too few stories" or "off-topic" answer blocks creation.
 *   4. Persist to `customSubtopics/<id>`, subscribe the caller, and do a
 *      first (AI-filtered) feed fill so the topic has news immediately.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { name?: string }
    const name = (body.name || '').trim().slice(0, 60)
    if (!name || name.length < 2) {
      return NextResponse.json({ error: 'Give the subtopic a name (2-60 characters).' }, { status: 400 })
    }

    // ── Premium gate ──
    const requester = await getRequesterTier(req)
    if (!requester.allUnlocked && requester.tier === 'free') {
      return NextResponse.json(
        {
          error: 'Custom subtopics are a Premium feature.',
          needUpgrade: true,
          tier: requester.tier,
        },
        { status: 402 },
      )
    }

    // ── 1. Already exists? ──
    const existing = searchCatalog(name, 1)
    if (existing.length > 0) {
      const t = existing[0]
      return NextResponse.json({ ok: true, existing: true, topic: t })
    }
    const slug = name
      .toLowerCase()
      .replace(/[’']/g, '')
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
    const runtimeExisting = await firebaseRead<{ label: string }>(`customSubtopics/${slug}`)
    if (runtimeExisting?.label) {
      return NextResponse.json({
        ok: true,
        existing: true,
        topic: { id: slug, label: runtimeExisting.label },
      })
    }

    // ── 2. AI: label + keywords (with deterministic fallback) ──
    const aiRaw = await callAI({
      systemPrompt:
        'You convert a user\'s news-subtopic idea into search keywords for the GDELT news API. Reply with ONLY compact JSON: {"label":"Clean Display Name","keywords":["kw1","kw2",...]} — label is Title Case (max 4 words), keywords are 4-8 lowercase English search phrases (single words or 2-word phrases) that would appear in news headlines about the topic. Use broad + specific mixes (e.g. for "F1": ["formula 1","f1","grand prix","motorsport"]). No other text.',
      userPrompt: `Subtopic idea: "${name}"`,
      maxTokens: 200,
    })
    let label = name
    let keywords: string[] = [name.toLowerCase()]
    let viaAI = false
    if (aiRaw) {
      try {
        const m = aiRaw.match(/\{[\s\S]*\}/)
        if (m) {
          const parsed = JSON.parse(m[0]) as { label?: string; keywords?: string[] }
          if (parsed.label) label = String(parsed.label).slice(0, 40)
          if (Array.isArray(parsed.keywords) && parsed.keywords.length > 0) {
            keywords = parsed.keywords
              .filter((k) => typeof k === 'string' && k.trim())
              .map((k) => k.trim().toLowerCase())
              .slice(0, 8)
          }
          viaAI = true
        }
      } catch {
        // fall through to the deterministic builder below
      }
    }
    if (!viaAI) {
      // AI FALLBACK — deterministic label + keywords (see header comment).
      const fb = fallbackLabelAndKeywords(name)
      label = fb.label
      keywords = fb.keywords
    }

    // ── 3. Validate against the live news flow ──
    const validation = await validateTopicFlow(keywords)
    if (!validation.ok && validation.reason) {
      return NextResponse.json(
        {
          error: validation.reason,
          hint: 'Try a slightly broader or more common spelling of the topic.',
        },
        { status: 422 },
      )
    }

    // ── 4. Persist + subscribe + first fill ──
    const id = slug || `topic-${Date.now().toString(36)}`
    await firebaseWrite(`customSubtopics/${id}`, {
      id,
      label,
      keywords,
      group: 'AI-Created',
      createdBy: requester.email || requester.accountId || 'premium-user',
      createdAt: Date.now(),
      keywordsVia: viaAI ? 'ai' : 'fallback',
    })
    await subscribeCustomTopic(id)

    // First fill (with AI filter) — best-effort; the cron will keep it fresh.
    let topics = 0
    try {
      const firstFill = await refreshCustomTopic(id, { aiFilter: true })
      topics = firstFill?.topics?.length || 0
    } catch {}

    return NextResponse.json({
      ok: true,
      created: true,
      topic: { id, label, keywords, group: 'AI-Created' },
      validation: { articles: validation.matched, via: validation.via },
      topics,
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Subtopic creation failed', detail: String(err) },
      { status: 500 },
    )
  }
}

// ── The deterministic keyword builder (the AI fallback chain's floor) ──

/** Stopword-ish tokens that never help a news search. */
const KW_STOP = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'for', 'with', 'in', 'on', 'at',
  'to', 'my', 'me', 'news', 'latest', 'updates', 'update', 'about', 'all',
  'best', 'top', 'how', 'why', 'what', 'when', 'who', 'is', 'are',
])

/**
 * Turn a raw user phrase into a usable search set with ZERO AI:
 *   label    — Title Case of the cleaned phrase
 *   keywords — the full phrase, its leading/tailing bigram, then each
 *              significant (≥3 char, non-stopword) token, capped at 8.
 * e.g. "London Underground strikes" → ["london underground strikes",
 * "london underground", "underground strikes", "london", "underground",
 * "strikes"] — a net the Google News / GDELT searches genuinely match.
 */
function fallbackLabelAndKeywords(name: string): { label: string; keywords: string[] } {
  const clean = name.replace(/\s+/g, ' ').trim()
  const label = clean
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .slice(0, 40)
  const lower = clean.toLowerCase()
  const tokens = lower
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !KW_STOP.has(w))
  const kw: string[] = []
  const push = (k: string) => {
    if (k.length >= 3 && !kw.includes(k) && kw.length < 8) kw.push(k)
  }
  push(lower)
  if (tokens.length >= 2) push(tokens.slice(0, 2).join(' '))
  if (tokens.length >= 3) push(tokens.slice(-2).join(' '))
  for (const t of tokens) push(t)
  if (kw.length === 0) push(lower)
  return { label, keywords: kw }
}

// ── Validation (two-source, transport-failure tolerant) ──

interface ValidationResult {
  ok: boolean
  reason?: string
  matched?: number
  via?: 'google-news' | 'gdelt' | 'skipped'
}

/**
 * Does this keyword set have a healthy, on-topic news flow?
 *
 *   1. GOOGLE NEWS RSS (primary) — the same source the feed's primary
 *      fill stage queries, so a pass here means the topic WILL fill.
 *   2. GDELT DOC API (secondary) — the original validator, kept for the
 *      case Google News is briefly unreachable.
 *   3. BOTH unreachable → { ok: true, via: 'skipped' } — a transport
 *      outage must not block creation (the old behaviour: GDELT 429s,
 *      shared-egress throttling etc. made creation randomly impossible).
 *      The first fill reveals the truth live, and the 90s failure
 *      cooldown keeps retry storms off the sources.
 *
 * Only a DEFINITIVE answer (a source answered and the flow is too thin
 * or off-topic) rejects, with an explanation.
 */
async function validateTopicFlow(keywords: string[]): Promise<ValidationResult> {
  // ── 1 · Google News RSS ──
  const g = await fetchGoogleNews(keywords, 7000)
  if (g.ok) {
    const items = g.items
    if (items.length < 5) {
      return {
        ok: false,
        reason: `Only ${items.length} news stories mentioned this recently — a topic needs a healthy flow of news. Try something broader.`,
        matched: items.length,
        via: 'google-news',
      }
    }
    const lower = keywords.map((k) => k.toLowerCase())
    const matched = items.filter((a) => {
      const t = (a.title || '').toLowerCase()
      return lower.some((k) => t.includes(k))
    }).length
    if (matched < 3) {
      return {
        ok: false,
        reason: 'The news that mentions this topic rarely headlines it directly — the feed would look off-topic. Try a more newsy phrasing.',
        matched,
        via: 'google-news',
      }
    }
    return { ok: true, matched: items.length, via: 'google-news' }
  }

  // ── 2 · GDELT (Google News unreachable) ──
  const gdelt = await validateViaGdelt(keywords)
  if (gdelt.answered) return gdelt.result

  // ── 3 · Both unreachable — create anyway ──
  return { ok: true, via: 'skipped' }
}

/** GDELT validation; `answered:false` means transport failure (429 /
 * network / rejected) — the caller decides what that means. */
async function validateViaGdelt(
  keywords: string[],
): Promise<{ answered: boolean; result: ValidationResult }> {
  const kw = keywords.slice(0, 8).map((k) => `"${k.replace(/"/g, '')}"`).join(' OR ')
  const query = `(${kw}) sourcelang:english`
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=100&format=json&sort=DateDesc&timewindow=1d`
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NeutralWireBot/1.0; +https://neutralwire.org)',
        Referer: 'https://neutralwire.org',
        Accept: 'application/json',
      },
      cache: 'no-store',
    })
    if (res.status === 429 || res.status === 503) return { answered: false, result: { ok: true, via: 'skipped' } }
    if (!res.ok) return { answered: false, result: { ok: true, via: 'skipped' } }
    const ct = res.headers.get('content-type') || ''
    if (!ct.includes('json')) return { answered: false, result: { ok: true, via: 'skipped' } }
    const data = (await res.json()) as { articles?: Array<{ title?: string }> }
    const articles = data.articles || []
    if (articles.length < 8) {
      return {
        answered: true,
        result: {
          ok: false,
          reason: `Only ${articles.length} news stories mentioned this in the last day — a topic needs a healthy flow of news. Try something broader.`,
          matched: articles.length,
          via: 'gdelt',
        },
      }
    }
    // Relevance: how many titles actually contain a keyword?
    const lower = keywords.map((k) => k.toLowerCase())
    const matched = articles.filter((a) => {
      const t = (a.title || '').toLowerCase()
      return lower.some((k) => t.includes(k))
    }).length
    if (matched < 5) {
      return {
        answered: true,
        result: {
          ok: false,
          reason: 'The news that mentions this topic rarely headlines it directly — the feed would look off-topic. Try a more newsy phrasing.',
          matched,
          via: 'gdelt',
        },
      }
    }
    return { answered: true, result: { ok: true, matched, via: 'gdelt' } }
  } catch {
    return { answered: false, result: { ok: true, via: 'skipped' } }
  }
}
