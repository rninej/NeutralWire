import { NextRequest, NextResponse } from 'next/server'
import { callAI } from '@/lib/ai-providers'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import { findTopicAnywhere } from '@/lib/topic-lookup'
import type { TopicArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
// AI generation can take 5-10s. Cache hits are <100ms. 15s ceiling
// prevents runaway AI calls from burning Fluid Compute CPU.
export const maxDuration = 15

// In-process cache for summaries (fastest, but per-instance).
const SUMMARY_CACHE = new Map<string, { ts: number; summary: string }>()
const SUMMARY_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours

// Firebase path for persisted summaries.
// Stored as: summaries/<topicId> = { summary, generatedAt, title, sourceCount }
// These persist across server restarts and are shared across all instances.
const FIREBASE_ROOT = 'summaries'

// Guard against concurrent summary generation for the same topicId.
// If two users open the same topic simultaneously, only one LLM call runs;
// the other waits and reuses the result.
// The promise resolves to { summary, fallback } — `fallback: true` means
// the LLM failed and an extractive (template) summary was produced. Those
// are served as a TEMPORARY answer but NEVER persisted, so the next visitor
// retries the LLM instead of being stuck with the template forever.
const IN_FLIGHT = new Map<string, Promise<GenerateResult | null>>()

interface GenerateResult {
  summary: string
  fallback: boolean
}

interface SummaryRequest {
  topicId: string
  title: string
  topicSummary?: string
  articles: Array<{
    title: string
    description: string
    sourceName: string
    leaning: string
  }>
}

interface StoredSummary {
  summary: string
  generatedAt: number
  title: string
  sourceCount: number
}

/**
 * Edge-cache a FOUND summary response (Fluid CPU).
 *
 * A stored summary is immutable content keyed by topicId — every visitor
 * asking for the same topic gets the same bytes. The 5-min s-maxage +
 * stale-while-revalidate means repeat opens (back button, second device,
 * cold service worker) are served from the Vercel CDN without running
 * the function or reading Firebase. The SW already caches this client-
 * side; this covers the cross-device / cold-SW case. 404s are never
 * cached (default) so a topic that gets summarized later is found on
 * the next request — behaviour unchanged.
 */
function withEdgeCache(res: NextResponse): NextResponse {
  res.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
  return res
}

/** True when a stored summary is the EXTRACTIVE (template) fallback that
 *  the old code persisted when every AI provider failed. These read like
 *  "This story is being covered by N sources across the political spectrum,
 *  indicating significant public interest" — technically valid but exactly
 *  the "ruined neutral summary" users complained about. They must be
 *  regenerated with the LLM, not served forever from Firebase. */
function isTemplateSummary(summary: string): boolean {
  return (
    summary.includes('indicating significant public interest') ||
    summary.includes('The breadth of coverage suggests') ||
    summary.includes('Source details are no longer available for this archived story')
  )
}

/**
 * Fetch a topic from Firebase (archive + cache categories) for summary
 * generation. Used when the client sends a summary request with no
 * articles (e.g. topic loaded from a slim=1 feed).
 *
 * Checks in order:
 *   1. archive/<topicId> (permanent storage — always exists for notified topics)
 *   2. newsCache/<category>/topics (live cache — checks most common categories)
 *
 * Returns the topic with articles, or null if not found.
 */
async function fetchTopicForSummary(topicId: string): Promise<TopicArticle | null> {
  // ONE shared lookup: archive first, then EVERY live newsCache key
  // (dynamically listed). The old hardcoded category list missed most
  // country caches — that was the /api/summary 404 bug.
  return findTopicAnywhere(topicId)
}

/**
 * GET /api/summary?topicId=xxx
 *
 * Returns a cached summary from memory or Firebase. Does NOT generate
 * new summaries — that's POST's job.
 *
 * This GET endpoint exists so the Service Worker can cache it with SWR
 * (the SW only caches GET requests, not POST). When the user is OFFLINE
 * and opens a topic they've viewed before, the SW serves the cached GET
 * response instantly — the neutral summary works offline.
 *
 * If the summary doesn't exist yet, returns 404 (client falls back to
 * POST which generates it).
 */
export async function GET(req: NextRequest) {
  const topicId = req.nextUrl.searchParams.get('topicId')
  if (!topicId) {
    return NextResponse.json(
      { error: 'Missing topicId query param' },
      { status: 400 },
    )
  }

  // 1. Check in-process cache (instant).
  const procCached = SUMMARY_CACHE.get(topicId)
  if (procCached && Date.now() - procCached.ts < SUMMARY_TTL_MS) {
    return withEdgeCache(
      NextResponse.json({
        topicId,
        summary: procCached.summary,
        cached: true,
        source: 'memory',
      }),
    )
  }

  // 2. Check Firebase. Template (extractive) summaries are treated as
  // missing so the client POSTs and regenerates a real LLM summary.
  const fbCached = await firebaseRead<StoredSummary>(`${FIREBASE_ROOT}/${topicId}`)
  if (fbCached?.summary && !isTemplateSummary(fbCached.summary)) {
    SUMMARY_CACHE.set(topicId, { ts: Date.now(), summary: fbCached.summary })
    return withEdgeCache(
      NextResponse.json({
        topicId,
        summary: fbCached.summary,
        cached: true,
        source: 'firebase',
      }),
    )
  }

  // Not found — client should POST to generate.
  return NextResponse.json(
    { error: 'Summary not yet generated', topicId },
    { status: 404 },
  )
}

/**
 * POST /api/summary
 *
 * Generates a neutral, in-depth summary of a news topic.
 *
 * Caching layers (fastest to slowest):
 *   1. In-process Map (2h TTL) — instant, per-server-instance
 *   2. Firebase Realtime Database — ~200ms, shared across ALL instances
 *   3. Generate fresh (LLM or extractive fallback)
 *
 * Once generated, a summary is persisted to Firebase so every subsequent
 * visitor (on any server) gets it instantly without re-running the LLM.
 * This saves API costs and makes the detail page load fast for everyone.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as SummaryRequest
    if (!body.topicId || !body.title) {
      return NextResponse.json(
        { error: 'Missing required fields: topicId, title' },
        { status: 400 },
      )
    }

    // ── If no articles AND no topicSummary, look up the topic from Firebase ──
    // This happens when the topic was loaded from a slim=1 feed (articles
    // stripped for size). The client sends topicId + title but no article
    // content. Instead of returning 400, we fetch the full topic from
    // Firebase (archive first, then cache categories) and use its articles.
    if (!body.articles?.length && !body.topicSummary) {
      console.log(`[api/summary] No articles + no topicSummary for ${body.topicId} — fetching from Firebase...`)
      const fetchedTopic = await fetchTopicForSummary(body.topicId)
      if (fetchedTopic) {
        body.articles = (fetchedTopic.articles || []).slice(0, 12).map((a) => ({
          title: a.title,
          description: a.description,
          sourceName: a.sourceName,
          leaning: a.leaning,
        }))
        body.topicSummary = fetchedTopic.summary || ''
        console.log(`[api/summary] Found topic in Firebase: ${body.articles.length} articles, topicSummary: ${body.topicSummary ? 'yes' : 'no'}`)
      }
      // If still no articles + no topicSummary after Firebase lookup,
      // we can't generate anything — return 422 (not 400) so the client
      // knows this is a content issue, not a bad request.
      if (!body.articles?.length && !body.topicSummary) {
        return NextResponse.json(
          { error: 'Topic not found in Firebase — no content available', topicId: body.topicId },
          { status: 422 },
        )
      }
    }

    // 1. Check in-process cache (instant).
    const procCached = SUMMARY_CACHE.get(body.topicId)
    if (procCached && Date.now() - procCached.ts < SUMMARY_TTL_MS) {
      return NextResponse.json({
        topicId: body.topicId,
        summary: procCached.summary,
        cached: true,
        source: 'memory',
      })
    }

    // 2. Check Firebase (shared across instances, ~200ms). Template
    // (extractive) summaries stored by the old code are cache MISSES —
    // regenerate with the LLM below.
    const fbCached = await firebaseRead<StoredSummary>(
      `${FIREBASE_ROOT}/${body.topicId}`,
    )
    if (fbCached?.summary && !isTemplateSummary(fbCached.summary)) {
      // Populate the in-process cache too so next time it's instant.
      SUMMARY_CACHE.set(body.topicId, { ts: Date.now(), summary: fbCached.summary })
      return NextResponse.json({
        topicId: body.topicId,
        summary: fbCached.summary,
        cached: true,
        source: 'firebase',
      })
    }

    // 3. Generate fresh. Deduplicate concurrent requests for the same topic.
    let generatePromise = IN_FLIGHT.get(body.topicId)
    if (!generatePromise) {
      generatePromise = (async (): Promise<GenerateResult | null> => {
        // Try the LLM first. If it fails, use the extractive fallback.
        let llmSummary: string | null = null
        try {
          llmSummary = await generateLlmSummary(body)
        } catch (err) {
          console.warn(
            '[api/summary] LLM failed, using fallback:',
            err instanceof Error ? err.message : err,
          )
        }

        const isFallback = !llmSummary
        const summary = llmSummary || generateExtractiveSummary(body)

        // If the summary is empty (no articles + no topicSummary), don't
        // persist it. Return null so the client knows to show the error.
        if (!summary || summary.trim().length === 0) {
          return null
        }

        // Persist to Firebase so other instances/users get it instantly —
        // but ONLY real LLM summaries. The extractive template used to be
        // persisted too, which meant one provider outage permanently
        // "ruined" the summary for every future visitor of that topic
        // (the exact bug users reported). Templates stay ephemeral: the
        // response is served now, and the next visitor retries the LLM.
        if (!isFallback) {
          const stored: StoredSummary = {
            summary,
            generatedAt: Date.now(),
            title: body.title,
            sourceCount: Array.isArray(body.articles) ? body.articles.length : 0,
          }
          await firebaseWrite(`${FIREBASE_ROOT}/${body.topicId}`, stored)
          // Also populate in-process cache (LLM results only).
          SUMMARY_CACHE.set(body.topicId, { ts: Date.now(), summary })
        } else {
          console.warn(
            `[api/summary] serving extractive fallback for ${body.topicId} (not persisted — will retry LLM for the next visitor)`,
          )
        }

        return { summary, fallback: isFallback }
      })()
      IN_FLIGHT.set(body.topicId, generatePromise)
    }

    try {
      const result = (await generatePromise) as GenerateResult | null
      // If summary generation returned null (no articles + no topicSummary),
      // return a 422 so the client knows to hide the summary section
      // instead of showing "Could not generate summary".
      if (!result) {
        return NextResponse.json(
          { error: 'No content available to generate summary', topicId: body.topicId },
          { status: 422 },
        )
      }
      return NextResponse.json({
        topicId: body.topicId,
        summary: result.summary,
        cached: false,
        source: result.fallback ? 'extractive-fallback' : 'generated',
        fallback: result.fallback,
      })
    } finally {
      IN_FLIGHT.delete(body.topicId)
    }
  } catch (err) {
    console.error('[api/summary] error:', err)
    return NextResponse.json(
      { error: 'Failed to generate summary', detail: String(err) },
      { status: 500 },
    )
  }
}

/**
 * Generate a summary using the AI fallback chain (Gemini → Groq → OpenRouter).
 *
 * This replaces the z-ai SDK which doesn't work on Vercel. The callAI chain
 * races all providers in parallel and returns the first valid answer.
 *
 * max_tokens is set to 800 to allow a full 250-350 word summary.
 * If the summary is truncated (doesn't end with punctuation), we attempt
 * a continuation call to complete it.
 */
async function generateLlmSummary(body: SummaryRequest): Promise<string | null> {
  const articlesList = Array.isArray(body.articles) ? body.articles : []

  // Build article context — if we have articles, use them; otherwise fall
  // back to the topic's own summary field (which is always present, even
  // for archived topics without the full articles array).
  let articleContext: string
  if (articlesList.length > 0) {
    articleContext = articlesList
      .slice(0, 12)
      .map(
        (a, i) =>
          `[${i + 1}] (${a.leaning}) ${a.sourceName}: ${a.title}\n${a.description || ''}`,
      )
      .join('\n\n')
  } else if (body.topicSummary) {
    // No articles — use the topic's summary as the sole context.
    // This happens when the topic was loaded from the archive without
    // the full articles array.
    articleContext = `Topic summary: ${body.topicSummary}`
  } else {
    return null
  }

  const systemPrompt = `You are NeutralWire, a sharp, engaging news analyst. You write summaries that people actually WANT to read — not dry encyclopedia entries.

Rules:
- Write in clear, conversational English — like a smart friend explaining the news over coffee.
- Start with a HOOK: open with the most surprising, shocking, or important fact. Do NOT start with "On Tuesday, the..." or background. Start with the punch.
- Be concise but thorough. No filler. Every sentence should teach the reader something new.
- Be neutral — present facts from all sides without favouring any perspective.
- If outlets disagree, say so plainly ("Left-leaning outlets frame this as X, while right-leaning outlets emphasize Y").
- Structure with BOLD subheadings:

**The Big Picture**
[2-3 sentences — the hook + core facts, written to grab attention]

**Why It Matters**
[2-3 sentences — context and implications for ordinary people]

**How Different Outlets Are Covering It**
[2-3 sentences — left vs center vs right framing]

**What Happens Next**
[2-3 sentences — what to watch for in coming days]

- Subheadings on their own line, surrounded by ** asterisks.
- Each subheading followed by a blank line, then the paragraph.
- Aim for 250-350 words. Shorter is better if it's punchy.`

  const userPrompt = `Story title: ${body.title}

${articlesList.length > 0 ? `Coverage from ${articlesList.length} sources across the political spectrum:` : 'Context:'}

${articleContext}

Write a neutral, in-depth summary of this story following the rules above.`

  const summary = await callAI({
    systemPrompt,
    userPrompt,
    maxTokens: 800,
  })

  if (!summary) return null

  // If the summary seems truncated (doesn't end with proper punctuation),
  // try to complete it by asking the model to continue.
  if (!/[.!?]$/.test(summary.trim())) {
    try {
      const continuation = await callAI({
        systemPrompt,
        userPrompt: `Continue and complete this summary. Do not repeat what you already wrote.\n\nSo far:\n${summary}\n\nContinue:`,
        maxTokens: 300,
      })
      if (continuation) {
        return summary + ' ' + continuation
      }
    } catch {
      // If continuation fails, return what we have
    }
  }

  return summary
}

/**
 * Generate an extractive summary from the article data without any LLM.
 *
 * This is the fallback used when ALL AI providers fail. It's not as good
 * as the LLM summary but it's clean and readable.
 *
 * Strategy:
 * 1. Pick the longest description and truncate it cleanly at a word boundary
 * 2. Use article TITLES (not descriptions) for the left/right perspectives
 *    — titles are shorter, properly capitalized, and more headline-like
 * 3. Assemble into a 3-paragraph summary with clear structure
 */
function generateExtractiveSummary(body: SummaryRequest): string {
  const { title } = body
  const articles = Array.isArray(body.articles) ? body.articles : []

  // If we have NO articles AND no topicSummary, we can't generate anything
  // meaningful. Return null to signal the caller to show the error.
  if (articles.length === 0 && !body.topicSummary) {
    return ''
  }

  // If we have no articles but DO have a topicSummary, use it as the
  // core facts. This happens for archived topics without the full
  // articles array.
  if (articles.length === 0 && body.topicSummary) {
    const sections: string[] = []
    sections.push(`**The Big Picture**\n\n${truncateClean(body.topicSummary, 300)}`)
    sections.push(`**Why It Matters**\n\nThis story was covered by NeutralWire. The summary above provides the key facts.`)
    sections.push(`**How Different Outlets Are Covering It**\n\nSource details are no longer available for this archived story.`)
    sections.push(`**What Happens Next**\n\nFor the latest developments, check the original sources linked below.`)
    return sections.join('\n\n')
  }

  // Sort articles by description length (longest first) to find the most informative.
  const sorted = [...articles].sort(
    (a, b) => (b.description?.length || 0) - (a.description?.length || 0),
  )

  // Paragraph 1: Core facts — use the longest description, truncated cleanly.
  // If ALL descriptions are empty, fall back to the topicSummary, then to
  // the first article's title. This prevents the summary from being just
  // the topic title repeated.
  const coreArticle = sorted[0]
  const coreText = coreArticle?.description || body.topicSummary || coreArticle?.title || title
  const coreFacts = truncateClean(coreText, 300)

  // Paragraph 2: Additional context from center-leaning sources.
  const centerArticles = articles.filter((a) => a.leaning === 'center')
  const contextArticle = centerArticles
    .sort((a, b) => (b.description?.length || 0) - (a.description?.length || 0))[0]
  const context = contextArticle && contextArticle.description
    ? truncateClean(contextArticle.description, 300)
    : ''

  // Paragraph 3: Perspectives from left and right — use TITLES not descriptions.
  // Titles are shorter, properly capitalized, and read like headlines.
  const leftArticle = articles
    .filter((a) => a.leaning === 'left')
    .sort((a, b) => (b.description?.length || 0) - (a.description?.length || 0))[0]
  const rightArticle = articles
    .filter((a) => a.leaning === 'right')
    .sort((a, b) => (b.description?.length || 0) - (a.description?.length || 0))[0]

  const perspectives: string[] = []
  if (leftArticle) {
    perspectives.push(
      `Left-leaning outlets like ${leftArticle.sourceName} headline this as: "${leftArticle.title}"`,
    )
  }
  if (rightArticle) {
    perspectives.push(
      `Right-leaning outlets like ${rightArticle.sourceName} headline this as: "${rightArticle.title}"`,
    )
  }

  // Assemble the summary with the same 4-section format as the AI summary:
  // **The Big Picture**, **Why It Matters**, **How Different Outlets Are Covering It**, **What Happens Next**
  const leftCount = articles.filter((a) => a.leaning === 'left').length
  const centerCount = articles.filter((a) => a.leaning === 'center').length
  const rightCount = articles.filter((a) => a.leaning === 'right').length

  const sections: string[] = []

  // Section 1: The Big Picture
  sections.push(`**The Big Picture**\n\n${coreFacts}`)

  // Section 2: Why It Matters (additional context)
  if (context && context !== coreFacts) {
    sections.push(`**Why It Matters**\n\n${context}`)
  } else {
    sections.push(`**Why It Matters**\n\nThis story is being covered by ${articles.length} sources across the political spectrum, indicating significant public interest.`)
  }

  // Section 3: How Different Outlets Are Covering It
  if (perspectives.length > 0) {
    sections.push(`**How Different Outlets Are Covering It**\n\n${perspectives.join(' ')}`)
  } else {
    sections.push(`**How Different Outlets Are Covering It**\n\n${leftCount} left-leaning, ${centerCount} center, and ${rightCount} right-leaning outlets are covering this story.`)
  }

  // Section 4: What Happens Next
  sections.push(`**What Happens Next**\n\nThis story is being covered by ${articles.length} sources across the political spectrum: ${leftCount} left-leaning, ${centerCount} center, and ${rightCount} right-leaning outlets. The breadth of coverage suggests this is a significant developing story.`)

  return sections.join('\n\n')
}

/**
 * Truncate text to maxLen characters at a word boundary.
 * Adds "..." if truncated. Cleans up whitespace.
 */
function truncateClean(s: string, maxLen: number): string {
  const cleaned = s.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLen) return cleaned
  // Find the last space before maxLen
  const truncated = cleaned.slice(0, maxLen)
  const lastSpace = truncated.lastIndexOf(' ')
  if (lastSpace > maxLen * 0.7) {
    // Truncate at the word boundary if it's not too far back
    return truncated.slice(0, lastSpace).replace(/[,;:]$/, '') + '…'
  }
  // Otherwise just cut at maxLen (the word is too long)
  return truncated + '…'
}
