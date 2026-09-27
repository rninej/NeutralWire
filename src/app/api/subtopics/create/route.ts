import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import { callAI } from '@/lib/ai-providers'
import { getRequesterTier } from '@/lib/subscriptions'
import { searchCatalog } from '@/lib/subtopic-catalog'
import { refreshCustomTopic, subscribeCustomTopic } from '@/lib/custom-topics'

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
 *   3. VALIDATION against GDELT: query the keywords, check the news is
 *      there in a good quantity and actually matches the topic (title
 *      keyword scoring). Too few or irrelevant → explain, don't create.
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

    // ── 2. AI: label + keywords ──
    const aiRaw = await callAI({
      systemPrompt:
        'You convert a user\'s news-subtopic idea into search keywords for the GDELT news API. Reply with ONLY compact JSON: {"label":"Clean Display Name","keywords":["kw1","kw2",...]} — label is Title Case (max 4 words), keywords are 4-8 lowercase English search phrases (single words or 2-word phrases) that would appear in news headlines about the topic. Use broad + specific mixes (e.g. for "F1": ["formula 1","f1","grand prix","motorsport"]). No other text.',
      userPrompt: `Subtopic idea: "${name}"`,
      maxTokens: 200,
    })
    if (!aiRaw) {
      return NextResponse.json(
        { error: 'The AI service is busy right now — try again in a moment.' },
        { status: 503 },
      )
    }
    let label = name
    let keywords: string[] = [name.toLowerCase()]
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
      }
    } catch {
      // fall back to the raw name
    }

    // ── 3. Validate against GDELT (quantity + relevance) ──
    const validation = await validateTopicViaGdelt(keywords)
    if (!validation.ok) {
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
      validation: { articles: validation.matched },
      topics,
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Subtopic creation failed', detail: String(err) },
      { status: 500 },
    )
  }
}

/**
 * GDELT validation: quantity (enough raw articles) + relevance (enough
 * titles actually matching the keywords). This is the "checks if the news
 * are accurate and relevant and are in a good quantity" step.
 */
async function validateTopicViaGdelt(
  keywords: string[],
): Promise<{ ok: boolean; reason?: string; matched?: number }> {
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
    if (!res.ok) return { ok: false, reason: 'The news search service did not respond — try again shortly.' }
    const ct = res.headers.get('content-type') || ''
    if (!ct.includes('json')) return { ok: false, reason: 'The news search service rejected this topic\'s query.' }
    const data = (await res.json()) as { articles?: Array<{ title?: string }> }
    const articles = data.articles || []
    if (articles.length < 8) {
      return {
        ok: false,
        reason: `Only ${articles.length} news stories mentioned this in the last day — a topic needs a healthy flow of news. Try something broader.`,
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
        ok: false,
        reason: 'The news that mentions this topic rarely headlines it directly — the feed would look off-topic. Try a more newsy phrasing.',
      }
    }
    return { ok: true, matched }
  } catch {
    return { ok: false, reason: 'Could not reach the news validation service — try again shortly.' }
  }
}
