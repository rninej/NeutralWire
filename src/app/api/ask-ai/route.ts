import { NextRequest, NextResponse } from 'next/server'
import { callAI, callAICompound, getLastProvider } from '@/lib/ai-providers'
import { firebaseWrite } from '@/lib/firebase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 10

interface AskAiRequest {
  question: string
  topicTitle: string
  topicSummary: string
  topicArticles: Array<{ title: string; source: string; leaning: string }>
}

/**
 * Ask AI about a news story.
 *
 * Provider chain (first that works wins):
 * 1. Groq — llama-3.3-70b-versatile
 * 2. Groq — openai/gpt-oss-120b
 * 3. Gemini
 * 4. OpenRouter — google/gemma-4-26b-a4b-it:free
 *
 * If the model outputs ({/compound}), it re-routes to:
 * 1. Groq — compound-beta
 * 2. OpenRouter — with web search
 */
export async function POST(req: NextRequest) {
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
- If the question requires information NOT in the story context below AND you do not know the answer from your training data, start your response with exactly: ({/compound})
- Only use ({/compound}) when you genuinely cannot answer without web search.

Story context:
Title: ${body.topicTitle}
Summary: ${body.topicSummary}

Articles covering this story:
${articleContext}`

    // ── Call AI (tries all providers in order) ──
    let answer = await callAI({ systemPrompt, userPrompt: body.question })
    let modelUsed = getLastProvider()

    // Check if the model requested compound (web search) — check both
    // ({/compound}) and {/compound} formats
    if (answer && (answer.startsWith('({/compound})') || answer.startsWith('{/compound}'))) {
      answer = answer.replace(/^\(?(\{\/compound\})\)?\s*/g, '')
      answer = answer.replace(/^\{\/compound\}\s*/g, '')

      // Try compound providers
      const compoundAnswer = await callAICompound({ systemPrompt, userPrompt: body.question })
      if (compoundAnswer) {
        answer = stripSources(compoundAnswer)
        modelUsed = getLastProvider() + ' (web search)'
      } else {
        answer = stripSources(answer) || 'Sorry, I could not find that information.'
      }
    } else if (answer) {
      answer = stripSources(answer)
    }

    if (!answer) {
      return NextResponse.json(
        { error: 'AI could not generate a response. Please try again.' },
        { status: 502 },
      )
    }

    // Store Q&A in Firebase
    const qaId = `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    await firebaseWrite(`ask-ai/${qaId}`, {
      question: body.question,
      answer,
      topicTitle: body.topicTitle,
      timestamp: Date.now(),
    })

    return NextResponse.json({ answer, qaId, model: modelUsed })
  } catch (err) {
    console.error('[ask-ai] error:', err)
    return NextResponse.json(
      { error: 'Failed to process question', detail: String(err).slice(0, 200) },
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
