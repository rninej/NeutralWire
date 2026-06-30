import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

// In-process cache for summaries (keyed by topicId).
// Summaries don't change once generated, so we cache forever in-process
// and for 2 hours in Firebase.
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
 * Generates a neutral, in-depth summary of a news topic using the LLM.
 *
 * The summary is written from a neutral standpoint, synthesising facts
 * from all the articles covering the story regardless of their source's
 * political leaning.
 *
 * Caches the result so repeated views of the same topic don't re-run
 * the LLM.
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

    // Build the prompt from the article data.
    const articleContext = body.articles
      .slice(0, 12) // Limit to 12 articles to keep prompt size reasonable
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

    const summary = completion.choices[0]?.message?.content?.trim()

    if (!summary) {
      return NextResponse.json(
        { error: 'LLM returned empty summary' },
        { status: 500 },
      )
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
