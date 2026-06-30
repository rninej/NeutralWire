import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

// In-process cache for summaries (keyed by topicId).
const SUMMARY_CACHE = new Map<string, { ts: number; summary: string }>()
const SUMMARY_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours

interface SummaryRequest {
  topicId: string
  title: string
  articles: Array<{
    title: string
    description: string
    sourceName: string
    leaning: string
  }>
}

/**
 * Generates a neutral, in-depth summary of a news topic.
 *
 * Primary: uses the z-ai LLM SDK (available in the Z.ai sandbox).
 * Fallback: if the SDK is unavailable (e.g. on Vercel/space-z.ai where
 *   the internal API isn't reachable), generates an extractive summary
 *   from the article descriptions — no external API needed.
 *
 * Both paths are cached for 2 hours per topic.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as SummaryRequest
    if (!body.topicId || !body.title || !body.articles?.length) {
      return NextResponse.json(
        { error: 'Missing required fields: topicId, title, articles' },
        { status: 400 },
      )
    }

    // Check in-process cache.
    const cached = SUMMARY_CACHE.get(body.topicId)
    if (cached && Date.now() - cached.ts < SUMMARY_TTL_MS) {
      return NextResponse.json({
        topicId: body.topicId,
        summary: cached.summary,
        cached: true,
      })
    }

    // Try the LLM first. If it fails (config not found, API unreachable,
    // etc.), fall back to the extractive summary.
    let summary: string | null = null
    try {
      summary = await generateLlmSummary(body)
    } catch (err) {
      console.warn('[api/summary] LLM failed, using fallback:', err instanceof Error ? err.message : err)
    }

    if (!summary) {
      summary = generateExtractiveSummary(body)
    }

    // Cache the result.
    SUMMARY_CACHE.set(body.topicId, { ts: Date.now(), summary })

    return NextResponse.json({
      topicId: body.topicId,
      summary,
      cached: false,
    })
  } catch (err) {
    console.error('[api/summary] error:', err)
    return NextResponse.json(
      { error: 'Failed to generate summary', detail: String(err) },
      { status: 500 },
    )
  }
}

/**
 * Try to generate a summary using the z-ai LLM SDK.
 * Throws if the SDK config is missing or the API is unreachable.
 */
async function generateLlmSummary(body: SummaryRequest): Promise<string | null> {
  const articleContext = body.articles
    .slice(0, 12)
    .map(
      (a, i) =>
        `[${i + 1}] (${a.leaning}) ${a.sourceName}: ${a.title}\n${a.description || ''}`,
    )
    .join('\n\n')

  const systemPrompt = `You are NeutralWire, a neutral news analyst. Your job is to write an in-depth, balanced summary of a news story based on coverage from multiple outlets across the political spectrum (left, center, and right).

Rules:
- Write in clear, neutral, journalistic English.
- Synthesise the facts from ALL provided articles into a coherent narrative.
- Do NOT favour any political perspective. Present what happened, when, where, and why it matters.
- If outlets disagree on facts, note the disagreement neutrally.
- Structure the summary in 3-4 paragraphs:
  1. What happened (the core facts)
  2. Context and background
  3. Reactions and differing perspectives (noting which sources lean which way)
  4. What happens next / why it matters
- Do NOT include any meta-commentary, headers, or labels like "Summary:" — just the prose.
- Aim for 250-400 words total.`

  const userPrompt = `Story title: ${body.title}

Coverage from ${body.articles.length} sources across the political spectrum:

${articleContext}

Write a neutral, in-depth summary of this story following the rules above.`

  const zai = await ZAI.create()
  const completion = await zai.chat.completions.create({
    messages: [
      { role: 'assistant', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    thinking: { type: 'disabled' },
  })

  return completion.choices[0]?.message?.content?.trim() || null
}

/**
 * Generate an extractive summary from the article data without any LLM.
 *
 * This is the fallback used when the z-ai SDK is unavailable (e.g. on
 * Vercel or space-z.ai where the internal API isn't reachable).
 *
 * Strategy:
 * 1. Pick the longest, most informative description as the "core facts".
 * 2. Group articles by leaning and pick one representative quote per group.
 * 3. Assemble into a 3-paragraph summary.
 */
function generateExtractiveSummary(body: SummaryRequest): string {
  const { title, articles } = body

  // Sort articles by description length (longest first) to find the most informative.
  const sorted = [...articles].sort(
    (a, b) => (b.description?.length || 0) - (a.description?.length || 0),
  )

  // Paragraph 1: Core facts — use the longest description.
  const coreArticle = sorted[0]
  const coreFacts = cleanText(coreArticle?.description || coreArticle?.title || title)

  // Paragraph 2: Additional context from center-leaning sources.
  const centerArticles = articles.filter((a) => a.leaning === 'center')
  const contextArticle = centerArticles
    .sort((a, b) => (b.description?.length || 0) - (a.description?.length || 0))[0]
  const context = contextArticle && contextArticle.description
    ? cleanText(contextArticle.description)
    : ''

  // Paragraph 3: Perspectives from left and right.
  const leftArticle = articles
    .filter((a) => a.leaning === 'left')
    .sort((a, b) => (b.description?.length || 0) - (a.description?.length || 0))[0]
  const rightArticle = articles
    .filter((a) => a.leaning === 'right')
    .sort((a, b) => (b.description?.length || 0) - (a.description?.length || 0))[0]

  const perspectives: string[] = []
  if (leftArticle?.description) {
    perspectives.push(
      `Left-leaning outlets like ${leftArticle.sourceName} ${cleanText(leftArticle.description).toLowerCase()}`,
    )
  }
  if (rightArticle?.description) {
    perspectives.push(
      `Right-leaning outlets like ${rightArticle.sourceName} ${cleanText(rightArticle.description).toLowerCase()}`,
    )
  }

  // Assemble the summary.
  const paragraphs: string[] = []

  // P1: Core facts
  paragraphs.push(coreFacts)

  // P2: Additional context (if different from core)
  if (context && context !== coreFacts) {
    paragraphs.push(context)
  }

  // P3: Perspectives
  if (perspectives.length > 0) {
    paragraphs.push(perspectives.join(' '))
  }

  // P4: Coverage summary
  const leftCount = articles.filter((a) => a.leaning === 'left').length
  const centerCount = articles.filter((a) => a.leaning === 'center').length
  const rightCount = articles.filter((a) => a.leaning === 'right').length
  paragraphs.push(
    `This story is being covered by ${articles.length} sources across the political spectrum: ${leftCount} left-leaning, ${centerCount} center, and ${rightCount} right-leaning outlets. The breadth of coverage suggests this is a significant developing story.`,
  )

  return paragraphs.filter(Boolean).join('\n\n')
}

function cleanText(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase())
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}
