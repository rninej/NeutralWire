import { NextRequest, NextResponse } from 'next/server'
import { callAI, callAICompound, getLastProvider } from '@/lib/ai-providers'
import { firebaseWrite } from '@/lib/firebase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
// Vercel Hobby max is 10s. Keep at 10 to match Hobby; the AI chain is
// optimized to fit within this budget (parallel calls, 4s per provider).
export const maxDuration = 10

interface AskAiRequest {
  question: string
  topicTitle: string
  topicSummary: string
  topicArticles: Array<{ title: string; source: string; leaning: string }>
  debug?: boolean
}

/**
 * Ask AI about a news story.
 *
 * Provider chain (all in parallel, first that works wins):
 * 1. Gemini (multiple models, NO google search by default)
 * 2. Groq (llama-3.3-70b, gpt-oss-120b)
 * 3. OpenRouter (gemma free)
 *
 * If the model outputs ({/compound}), it re-routes to compound (web search):
 * 1. Gemini (WITH google search)
 * 2. Groq compound-beta
 * 3. OpenRouter with web plugin
 *
 * Total budget: ~9s to fit within Vercel Hobby's 10s maxDuration.
 */
export async function POST(req: NextRequest) {
  // Hard deadline: 9s (leaves 1s for response serialization)
  const deadline = Date.now() + 9000

  try {
    const body = (await req.json()) as AskAiRequest

    if (!body.question || !body.topicTitle) {
      return NextResponse.json({ error: 'Missing question or topic' }, { status: 400 })
    }

    const articleContext = body.topicArticles
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

Articles covering this story:
${articleContext}`

    // ── Call AI (parallel, NO search) ──
    let answer = await callAI({ systemPrompt, userPrompt: body.question })
    let modelUsed = getLastProvider()

    // Check if the model requested compound (web search)
    if (answer && (answer.startsWith('({/compound})') || answer.startsWith('{/compound}'))) {
      // Strip the indicator
      answer = answer.replace(/^\(?(\{\/compound\})\)?\s*/g, '')
      answer = answer.replace(/^\{\/compound\}\s*/g, '')

      // Only attempt compound if we still have time before the deadline
      if (Date.now() < deadline - 1000) {
        const compoundAnswer = await callAICompound({
          systemPrompt: systemPrompt.replace(
            'You do NOT have web search in this mode.',
            'You HAVE web search available. Use it to find current information.'
          ),
          userPrompt: body.question,
        })
        if (compoundAnswer) {
          answer = stripSources(compoundAnswer)
          modelUsed = getLastProvider() + ' (web search)'
        } else {
          // Compound failed — give a helpful message instead of empty
          answer =
            "I couldn't find reliable information on that. Try rephrasing your question, or check back in a few minutes — the news catalog updates regularly."
        }
      } else {
        // Out of time — return a helpful message
        answer =
          'That question needs a web search but I ran out of time. Please try again in a moment.'
      }
    } else if (answer) {
      answer = stripSources(answer)
    }

    if (!answer) {
      return NextResponse.json(
        {
          error:
            "I couldn't reach any AI provider right now. Please try again in a moment.",
        },
        { status: 502 },
      )
    }

    // Store Q&A in Firebase (fire-and-forget, don't block response)
    const qaId = `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    void firebaseWrite(`ask-ai/${qaId}`, {
      question: body.question,
      answer,
      topicTitle: body.topicTitle,
      timestamp: Date.now(),
    })

    return NextResponse.json({ answer, qaId, model: modelUsed })
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
