/**
 * Groq API wrapper for AI-powered story selection.
 *
 * Uses Groq's free llama-3.3-70b-versatile model.
 * Falls back to keyword scoring if AI fails.
 */

const GROQ_API_KEY = process.env.GROQ_API_KEY || ''
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'llama-3.3-70b-versatile'

/**
 * Ask the AI to pick the best story number from a list.
 * Returns the index (0-based) or -1 if failed.
 */
export async function aiPickBestStory(
  systemPrompt: string,
  userPrompt: string,
  candidateCount: number,
): Promise<number> {
  if (!GROQ_API_KEY) return -1

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 10,
        temperature: 0.3,
      }),
      cache: 'no-store',
    })

    if (!res.ok) {
      console.warn('[groq] API error:', res.status)
      return -1
    }

    const data = await res.json()
    const response = data.choices?.[0]?.message?.content?.trim() || ''

    const match = response.match(/(\d+)/)
    if (match) {
      const idx = parseInt(match[1], 10) - 1
      if (idx >= 0 && idx < candidateCount) {
        console.log('[groq] AI picked story #' + (idx + 1))
        return idx
      }
    }

    console.warn('[groq] unparseable response:', response.slice(0, 100))
    return -1
  } catch (err) {
    console.warn('[groq] error:', err)
    return -1
  }
}
