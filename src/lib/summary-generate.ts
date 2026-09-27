/**
 * summary-generate.ts — the ONE shared neutral-summary pipeline.
 *
 * Extracted (Sep 2026) from /api/summary/route.ts so the SERVER-RENDERED
 * /story/<id> pages and the cron refresh can generate + persist the real
 * LLM neutral summary through the exact same code path the app's
 * "open story" flow uses. Three consumers now share it:
 *
 *   1. POST/GET /api/summary         — the app's on-demand path (unchanged
 *                                       behaviour, just imported from here)
 *   2. /story/[id] getStoryData      — when a story has NO stored summary
 *                                       yet, the page render itself waits
 *                                       (bounded ~8s) for one so the RAW
 *                                       HTML ships complete. This kills the
 *                                       "neutral summary suddenly loads"
 *                                       client-side swap that made Google
 *                                       refuse to index 27 story pages:
 *                                       Googlebot saw a thin wire snippet
 *                                       in the HTML and content appearing
 *                                       only after JS ran — a layout-shift
 *                                       + injected-content pattern.
 *   3. /api/cron/refresh-all after() — pre-generates summaries for the
 *       NEWEST stories right after each 30-min refresh, so by the time
 *       Googlebot arrives via /news-sitemap.xml the summary already
 *       exists and the page render is a pure cache read.
 *
 * Persistence contract (unchanged): ONLY real LLM summaries are written to
 * Firebase summaries/<topicId>. Extractive/template fallbacks stay
 * ephemeral so a provider outage can never permanently "ruin" a story.
 */

import { after } from 'next/server'
import { callAI } from '@/lib/ai-providers'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import type { TopicArticle } from '@/lib/news-aggregator'

// In-process cache for summaries (fastest, but per-instance).
export const SUMMARY_CACHE = new Map<string, { ts: number; summary: string }>()
export const SUMMARY_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours

// Firebase path for persisted summaries.
// Stored as: summaries/<topicId> = { summary, generatedAt, title, sourceCount }
// These persist across server restarts and are shared across all instances.
const FIREBASE_ROOT = 'summaries'

export interface SummaryRequest {
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

export interface StoredSummary {
  summary: string
  generatedAt: number
  title: string
  sourceCount: number
}

export interface GenerateResult {
  summary: string
  fallback: boolean
}

// Guard against concurrent summary generation for the same topicId.
// If two callers ask for the same topic simultaneously, only one LLM
// call runs; the other waits and reuses the result.
const IN_FLIGHT = new Map<string, Promise<GenerateResult | null>>()

/** True when a stored summary is the EXTRACTIVE (template) fallback that
 *  the old code persisted when every AI provider failed. These read like
 *  "This story is being covered by N sources across the political spectrum,
 *  indicating significant public interest" — technically valid but exactly
 *  the "ruined neutral summary" users complained about. They must be
 *  regenerated with the LLM, not served forever from Firebase. */
export function isTemplateSummary(summary: string): boolean {
  return (
    summary.includes('indicating significant public interest') ||
    summary.includes('The breadth of coverage suggests') ||
    summary.includes('Source details are no longer available for this archived story')
  )
}

/**
 * Read the STORED summary for a topic (memory → Firebase), treating
 * template leftovers as absent. Returns { summary, source } or null.
 * Also populates the in-process cache when Firebase has the real thing.
 */
export async function readStoredSummary(
  topicId: string,
): Promise<{ summary: string; source: 'memory' | 'firebase' } | null> {
  // 1. In-process cache (instant).
  const procCached = SUMMARY_CACHE.get(topicId)
  if (procCached && Date.now() - procCached.ts < SUMMARY_TTL_MS) {
    return { summary: procCached.summary, source: 'memory' }
  }

  // 2. Firebase. Template (extractive) summaries are treated as missing
  //    so the caller regenerates a real LLM summary.
  const fbCached = await firebaseRead<StoredSummary>(`${FIREBASE_ROOT}/${topicId}`)
  if (fbCached?.summary && !isTemplateSummary(fbCached.summary)) {
    SUMMARY_CACHE.set(topicId, { ts: Date.now(), summary: fbCached.summary })
    return { summary: fbCached.summary, source: 'firebase' }
  }
  return null
}

/**
 * Get (or start) the ONE in-flight generation for a topic.
 *
 * The returned promise resolves to { summary, fallback } — `fallback: true`
 * means the LLM failed and an extractive (template) summary was produced.
 * Those are served as a TEMPORARY answer but NEVER persisted, so the next
 * caller retries the LLM instead of being stuck with the template forever.
 * Resolves to null when there was no content to generate from.
 */
export function getOrCreateGeneration(body: SummaryRequest): Promise<GenerateResult | null> {
  let generatePromise = IN_FLIGHT.get(body.topicId)
  if (!generatePromise) {
    generatePromise = runGeneration(body).finally(() => {
      IN_FLIGHT.delete(body.topicId)
    })
    IN_FLIGHT.set(body.topicId, generatePromise)
  }
  return generatePromise
}

async function runGeneration(body: SummaryRequest): Promise<GenerateResult | null> {
  // Try the LLM first. If it fails, use the extractive fallback.
  let llmSummary: string | null = null
  try {
    llmSummary = await generateLlmSummary(body)
  } catch (err) {
    console.warn(
      '[summary-generate] LLM failed, using fallback:',
      err instanceof Error ? err.message : err,
    )
  }

  const isFallback = !llmSummary
  const summary = llmSummary || generateExtractiveSummary(body)

  // If the summary is empty (no articles + no topicSummary), don't
  // persist it. Return null so the caller knows to show the error.
  if (!summary || summary.trim().length === 0) {
    return null
  }

  // Persist to Firebase so other instances/users get it instantly —
  // but ONLY real LLM summaries. The extractive template used to be
  // persisted too, which meant one provider outage permanently
  // "ruined" the summary for every future visitor of that topic
  // (the exact bug users reported). Templates stay ephemeral: the
  // response is served now, and the next caller retries the LLM.
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
      `[summary-generate] serving extractive fallback for ${body.topicId} (not persisted — will retry LLM for the next caller)`,
    )
  }

  return { summary, fallback: isFallback }
}

/**
 * ── The story-page entry point ──
 *
 * Bounded wait for a REAL (persisted, non-template) neutral summary.
 * Used by /story/[id]'s getStoryData so the raw HTML ships complete:
 *
 *  - Starts (or joins) the single in-flight generation for the topic.
 *  - Waits at most `timeoutMs` for it. On success with a real LLM
 *    summary → returns it (it is already persisted by runGeneration).
 *  - On timeout: registers the still-running promise with `after()` so
 *    the serverless function stays alive long enough to PERSIST the
 *    result — the next ISR regeneration (≤15 min) then serves it in
 *    the raw HTML. Returns null so this render uses the fallback path.
 *  - On failure / extractive fallback / null result: returns null —
 *    the page keeps the wire-snippet + client-side upgrade behaviour.
 *
 * Never throws: a story page must render even when every AI provider
 * is down.
 */
export async function generateStorySummaryBounded(
  topicId: string,
  title: string,
  articles: SummaryRequest['articles'],
  topicSummary: string,
  timeoutMs = 8000,
): Promise<string | null> {
  const generation = getOrCreateGeneration({
    topicId,
    title,
    articles,
    topicSummary,
  })

  let result: GenerateResult | null = null
  let timedOut = false
  try {
    result = await Promise.race([
      generation.then((r) => r),
      new Promise<null>((resolve) =>
        setTimeout(() => {
          timedOut = true
          resolve(null)
        }, timeoutMs),
      ),
    ])
  } catch {
    // Generation itself failed — nothing to wait for.
    return null
  }

  if (
    result &&
    !result.fallback &&
    result.summary &&
    !isTemplateSummary(result.summary)
  ) {
    return result.summary
  }

  // Timed out while the LLM is STILL running → keep the function alive so
  // it persists; the next ISR regeneration (≤15 min) serves it in the raw
  // HTML. (A real fallback/template result needs no after() — nothing
  // worth persisting is pending.)
  if (timedOut) {
    try {
      after(() =>
        generation.catch(() => {
          // best-effort persistence; nothing to recover
        }),
      )
    } catch {
      // after() outside a render/route context — ignore
    }
  }
  return null
}

/**
 * ── The cron pre-generation entry point ──
 *
 * Given the topics a refresh just wrote, pick the NEWEST ones that have
 * no stored summary yet and generate them (parallel, capped). Called
 * from /api/cron/refresh-all's after() so Googlebot usually finds the
 * summary already persisted when it crawls the story page from the
 * news sitemap — the page render then never needs the LLM at all.
 *
 * Returns how many summaries were (started and) generated.
 */
export async function preGenerateSummaries(
  topics: Array<TopicArticle>,
  opts: { max?: number; freshWindowMs?: number } = {},
): Promise<number> {
  const max = opts.max ?? 4
  const freshWindowMs = opts.freshWindowMs ?? 6 * 60 * 60 * 1000 // 6h
  const now = Date.now()

  // Newest first, fresh only, needs a topicId + title.
  const candidates = topics
    .filter(
      (t) =>
        t?.topicId &&
        t?.title &&
        (t.firstSeen || t.latestSeen || 0) > 0 &&
        now - (t.firstSeen || t.latestSeen) <= freshWindowMs,
    )
    .sort((a, b) => (b.firstSeen || b.latestSeen || 0) - (a.firstSeen || a.latestSeen || 0))

  const picked: TopicArticle[] = []
  for (const t of candidates) {
    if (picked.length >= max) break
    // Skip topics that already have a real stored summary (tiny read,
    // ETag-cached — a hit costs zero bytes on warm instances).
    const stored = await readStoredSummary(t.topicId)
    if (!stored) picked.push(t)
  }
  if (picked.length === 0) return 0

  const results = await Promise.allSettled(
    picked.map((t) =>
      getOrCreateGeneration({
        topicId: t.topicId,
        title: t.title,
        topicSummary: t.summary || '',
        articles: (t.articles || []).slice(0, 12).map((a) => ({
          title: a.title,
          description: a.description || '',
          sourceName: a.sourceName,
          leaning: a.leaning || '',
        })),
      }),
    ),
  )
  return results.filter(
    (r) => r.status === 'fulfilled' && r.value && !r.value.fallback,
  ).length
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
  // meaningful. Return '' to signal the caller to show the error.
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
