/**
 * Probe: how many live "top" stories have a stored neutral summary
 * (summaries/<topicId>) vs only topic.summary — informs the /story page fix.
 * Read-only REST reads against the production RTDB (public read rules).
 */
const DB_URL =
  'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${DB_URL}/${path}.json`)
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

interface StoredSummary {
  summary: string
  generatedAt: number
  title?: string
  sourceCount?: number
}

async function main() {
  const rooms = ['top', 'relevant', 'world', 'politics', 'relevant__GB']
  for (const room of rooms) {
    const payload = await get<{ topics?: Array<{ topicId?: string; title?: string; summary?: string }> }>(
      `newsCache/${room}`,
    )
    const topics = payload?.topics || []
    console.log(`\n=== newsCache/${room} — ${topics.length} topics ===`)
    let withTopicSummary = 0
    let withStored = 0
    const missing: string[] = []
    for (const t of topics.slice(0, 12)) {
      if (!t?.topicId) continue
      const hasTopicSummary = Boolean(t.summary && t.summary.length > 30)
      const stored = await get<StoredSummary>(`summaries/${t.topicId}`)
      const hasStored = Boolean(stored?.summary && stored.summary.length > 30)
      if (hasTopicSummary) withTopicSummary++
      if (hasStored) withStored++
      if (!hasStored) missing.push(t.topicId)
      const preview = (stored?.summary || t.summary || '')
        .replace(/\*\*/g, '')
        .replace(/\s+/g, ' ')
        .slice(0, 90)
      console.log(
        `${hasStored ? '[STORED]   ' : hasTopicSummary ? '[topic.sm] ' : '[NONE]    '}${t.topicId} | ${preview}`,
      )
    }
    console.log(
      `→ of first ${Math.min(12, topics.length)}: topic.summary=${withTopicSummary}, stored neutral summary=${withStored}`,
    )
    if (missing.length) console.log(`→ missing stored: ${missing.join(', ')}`)
  }
}

main()
