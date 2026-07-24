import { NextRequest, NextResponse } from 'next/server'
import { callAI } from '@/lib/ai-providers'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

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
const IN_FLIGHT = new Map<string, Promise<string>>()

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

interface StoredSummary {
  summary: string
  generatedAt: number
  title: string
  sourceCount: number
}

/**
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
    if (!body.topicId || !body.title || !body.articles?.length) {
      return NextResponse.json(
        { error: 'Missing required fields: topicId, title, articles' },
        { status: 400 },
      )
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

    // 2. Check Firebase (shared across instances, ~200ms).
    const fbCached = await firebaseRead<StoredSummary>(
      `${FIREBASE_ROOT}/${body.topicId}`,
    )
    if (fbCached?.summary) {
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
      generatePromise = (async () => {
        // Try the LLM first. If it fails, use the extractive fallback.
        let summary: string | null = null
        try {
          summary = await generateLlmSummary(body)
        } catch (err) {
          console.warn(
            '[api/summary] LLM failed, using fallback:',
            err instanceof Error ? err.message : err,
          )
        }
        if (!summary) {
          summary = generateExtractiveSummary(body)
        }

        // Persist to Firebase so other instances/users get it instantly.
        const stored: StoredSummary = {
          summary,
          generatedAt: Date.now(),
          title: body.title,
          sourceCount: body.articles.length,
        }
        await firebaseWrite(`${FIREBASE_ROOT}/${body.topicId}`, stored)

        // Also populate in-process cache.
        SUMMARY_CACHE.set(body.topicId, { ts: Date.now(), summary })

        return summary
      })()
      IN_FLIGHT.set(body.topicId, generatePromise)
    }

    try {
      const summary = await generatePromise
      return NextResponse.json({
        topicId: body.topicId,
        summary,
        cached: false,
        source: 'generated',
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
  const articleContext = body.articles
    .slice(0, 12)
    .map(
      (a, i) =>
        `[${i + 1}] (${a.leaning}) ${a.sourceName}: ${a.title}\n${a.description || ''}`,
    )
    .join('\n\n')

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

Coverage from ${body.articles.length} sources across the political spectrum:

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
  const { title, articles } = body

  // Sort articles by description length (longest first) to find the most informative.
  const sorted = [...articles].sort(
    (a, b) => (b.description?.length || 0) - (a.description?.length || 0),
  )

  // Paragraph 1: Core facts — use the longest description, truncated cleanly.
  const coreArticle = sorted[0]
  const coreFacts = truncateClean(
    coreArticle?.description || coreArticle?.title || title,
    300,
  )

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
