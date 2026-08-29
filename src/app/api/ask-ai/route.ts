import { NextRequest, NextResponse } from 'next/server'
import { callAI, callAICompound, getLastProvider, getLastDiagnostics } from '@/lib/ai-providers'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
// Generous ceiling: parallel provider race + possible web-search compound
// retry + training-data fallback can legitimately take 8-12s. The client
// aborts at 17s (above this) so the server's own JSON error wins.
export const maxDuration = 15

interface AskAiRequest {
  question: string
  topicTitle: string
  topicSummary: string
  topicArticles: Array<{ title: string; source: string; leaning: string }>
  debug?: boolean
}

/**
 * Simple hash for cache keys (not crypto-secure, just for dedup).
 */
function hash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return 'qa_' + (h >>> 0).toString(36)
}

/**
 * Ask AI about a news story.
 *
 * Caching: common questions (like "Explain to a beginner") are cached
 * per-topicTitle in Firebase. When a user clicks a quick-action chip,
 * the server checks Firebase first — if the same question was already
 * answered for the same topic, it returns the cached answer instantly
 * (no AI call needed). This saves costs since many users ask the same
 * questions.
 */
export async function POST(req: NextRequest) {
  const deadline = Date.now() + 12500

  try {
    const body = (await req.json()) as AskAiRequest

    if (!body.question || !body.topicTitle) {
      return NextResponse.json({ error: 'Missing question or topic' }, { status: 400 })
    }

    // ── Check Firebase cache first ──
    // Cache key is a hash of question + topicTitle. This means the same
    // question for the same topic always returns the same cached answer.
    // KNOWN-BAD GUARD: failure fallback messages used to be cached too —
    // everyone asking that question afterwards got the error forever.
    // Now those are recognised and treated as cache misses.
    const cacheKey = hash(body.question.toLowerCase().trim() + '|' + body.topicTitle.toLowerCase().trim())
    try {
      const cached = await firebaseRead<{ answer: string; model?: string }>(`ask-ai-cache/${cacheKey}`)
      if (cached?.answer && !isKnownFailureAnswer(cached.answer)) {
        return NextResponse.json({
          answer: cached.answer,
          qaId: cacheKey,
          model: cached.model || 'cached',
          cached: true,
        })
      }
    } catch {
      // cache miss — continue to AI
    }

    const articleContext = (body.topicArticles || [])
      .slice(0, 8)
      .map((a) => `- ${a.title} (${a.source}, ${a.leaning})`)
      .join('\n')

    const systemPrompt = `You are R9GPT, an AI assistant built by Arnav Jain for NeutralWire, a neutral news platform. You help users understand and discuss news stories.

Rules:
- You are a news and current affairs assistant. Answer ANY question remotely related to the news story, current events, politics, history, people mentioned, or anything connected.
- ONLY refuse: coding/programming, math homework, cooking recipes, dating advice, or completely unrelated personal questions. For those say: "I'm a news assistant — ask me about this story or current events!"
- Be conversational, helpful, not robotic. Give opinions when asked (note they're analysis, not fact).
- Be concise — 2-4 sentences unless more detail is needed.
- Do NOT include source citations, URLs, or references in your answer. Just answer directly.
- If asked who made you or your name is, say: "I'm R9GPT, made by Arnav Jain for NeutralWire." Don't volunteer this unless asked.

IMPORTANT - WEB SEARCH INDICATOR:
- You do NOT have web search in this mode. Answer from your training data.
- If the question requires information NOT in the story context below AND you do not know the answer from your training data, start your response with exactly: ({/compound})
- Only use ({/compound}) when you genuinely cannot answer without web search. The system will then route you to a web-search-enabled model.

Story context:
Title: ${body.topicTitle}
Summary: ${body.topicSummary}
${articleContext ? `\nArticles covering this story:\n${articleContext}` : ''}`

    // ── Call AI (parallel, NO search) ──
    let answer = await callAI({ systemPrompt, userPrompt: body.question })
    let modelUsed = getLastProvider()
    let isFallback = false

    // Check if the model requested compound (web search). The marker is
    // specified as ({/compound}) but models emit variants: {/compound},
    // ( {/compound} ), leading whitespace, markdown bold around it…
    const markerRe = /^\s*\(?\s*\{\s*\/\s*compound\s*\}\s*\)?\s*/i
    if (answer && markerRe.test(answer)) {
      // Strip the indicator
      answer = answer.replace(markerRe, '')
      answer = answer.replace(/^\{\/compound\}\s*/g, '')

      // The model emitted the marker AND a real answer (over-cautious
      // marker use). The answer is good — use it directly instead of
      // burning another full provider volley we may not have quota for.
      if (answer.trim().length > 40) {
        answer = stripSources(answer)
      } else if (Date.now() < deadline - 1000) {
        // Marker only (or marker + refusal) — route to web search.
        const compoundAnswer = await callAICompound({
          systemPrompt: systemPrompt.replace(
            'You do NOT have web search in this mode.',
            'You HAVE web search available. Use it to find current information.'
          ),
          userPrompt: body.question,
        })
        if (compoundAnswer) {
          answer = stripSources(compoundAnswer)
          modelUsed = getLastProvider()
        } else {
          // All web-search providers failed. Models are sometimes
          // over-cautious with the ({/compound}) marker (they emit it for
          // questions they CAN answer, like "what is the IMF"). ONE rescue
          // volley with the marker explicitly forbidden converts most of
          // these into a real training-data answer instead of a refusal.
          let rescue: string | null = null
          if (Date.now() < deadline - 1500) {
            rescue = await callAI({
              systemPrompt: systemPrompt.replace(
                'If the question requires information NOT in the story context below AND you do not know the answer from your training data, start your response with exactly: ({/compound})',
                'Answer from your training data even if it may be slightly outdated — a dated answer is better than none. Do NOT use the ({/compound}) marker under any circumstances.',
              ),
              userPrompt: body.question,
            })
            if (rescue) rescue = stripSources(rescue)
          }
          if (rescue && rescue.length > 10) {
            answer = rescue
            modelUsed = getLastProvider() + ' (training data)'
          } else {
            answer =
              "I couldn't verify that with a live web search right now. Try rephrasing, or ask again in a few minutes."
            isFallback = true
          }
          console.warn('[ask-ai] compound path failed:', getLastDiagnostics())
        }
      } else {
        // Out of time — return a helpful message (also not cached)
        answer =
          'That question needs a web search but I ran out of time. Please try again in a moment.'
        isFallback = true
      }
    } else if (answer) {
      answer = stripSources(answer)
    }

    if (!answer) {
      return NextResponse.json(
        {
          error:
            "I couldn't reach any AI provider right now. Please try again in a moment.",
          // Provider-level failure reasons (which model, which HTTP status)
          // — makes the 502 self-diagnosing instead of a blind guess.
          diag: getLastDiagnostics(),
        },
        { status: 502 },
      )
    }

    // Store Q&A in Firebase cache (using the hash key so repeated questions
    // for the same topic return the cached answer — saves AI costs).
    // FAILURE ANSWERS ARE NEVER CACHED — a transient provider outage must
    // not poison the answer for every future user asking this question.
    if (!isFallback) {
      void firebaseWrite(`ask-ai-cache/${cacheKey}`, {
        answer,
        question: body.question,
        topicTitle: body.topicTitle,
        model: modelUsed,
        timestamp: Date.now(),
      })
    }

    return NextResponse.json({ answer, qaId: cacheKey, model: modelUsed })
  } catch (err) {
    console.error('[ask-ai] error:', err)
    return NextResponse.json(
      {
        error:
          'The AI service is taking too long to respond. Please try again — your question has been noted.',
        detail: String(err).slice(0, 200),
      },
      { status: 500 },
    )
  }
}

/** Answers that must never be served from (or written to) the cache —
 *  they're failure fallbacks, not real answers. Previously a cached
 *  "I couldn't find reliable information…" was served to every user who
 *  asked the same question, forever. */
const KNOWN_FAILURE_ANSWERS = [
  "I couldn't find reliable information on that. Try rephrasing your question, or check back in a few minutes — the news catalog updates regularly.",
  "I couldn't verify that with a live web search right now. Try rephrasing, or ask again in a few minutes.",
  'That question needs a web search but I ran out of time. Please try again in a moment.',
]

function isKnownFailureAnswer(answer: string): boolean {
  const a = answer.trim()
  return KNOWN_FAILURE_ANSWERS.some((f) => a === f)
}

function stripSources(answer: string): string {
  let s = answer
  // Strip ({/compound}) indicator in any format the model might output
  s = s.replace(/^\(?(\{\/compound\})\)?\s*/g, '')
  s = s.replace(/^\{\/compound\}\s*/g, '')
  s = s.replace(/\[\d+\]/g, '')
  s = s.replace(/\[Source:[^\]]*\]/gi, '')
  s = s.replace(/\(Source:[^)]*\)/gi, '')
  s = s.replace(/\s*https?:\/\/\S+$/g, '')
  s = s.replace(/\s*Sources?:.*$/is, '')
  s = s.replace(/^According to [^,]+,\s*/i, '')
  s = s.replace(/\s+/g, ' ').trim()
  return s
}
