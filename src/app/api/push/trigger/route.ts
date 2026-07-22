import { NextRequest, NextResponse } from 'next/server'
import { callAI } from '@/lib/ai-providers'
import { sendPushifyNotification } from '@/lib/pushify'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import type { TopicArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
// Vercel Hobby max is 10s, Pro is 60s. Set to 10 to match Hobby.
export const maxDuration = 10

/**
 * Pick the best story for a UK audience using AI.
 *
 * Sends the list of candidate stories to the z-ai LLM with a prompt
 * asking it to pick the ONE story most likely to get a click from a
 * UK-based news reader. Falls back to keyword scoring if AI fails.
 */
async function pickBestStoryWithAI(
  stories: TopicArticle[],
  slot: string,
  clickHistory: Record<string, { clicks: number; dismisses: number }>,
): Promise<TopicArticle> {
  // Filter to stories with images only
  const withImages = stories.filter((s) => s.imageUrl)
  const candidates = (withImages.length > 0 ? withImages : stories).slice(0, 15)

  if (candidates.length === 0) return stories[0]
  if (candidates.length === 1) return candidates[0]

  try {
    // Build a compact list of stories for the AI to evaluate
    const storyList = candidates
      .map((s, i) => {
        const local = s.localCoverage || 0
        return `${i + 1}. [${s.coverage} sources, ${local} UK] ${s.title}`
      })
      .join('\n')

    // Include click history so AI knows what the user has clicked/dismissed before
    const clickedKeywords = Object.entries(clickHistory)
      .filter(([, stats]) => (stats.clicks || 0) > 0)
      .map(([kw, stats]) => `${kw}(${stats.clicks} clicks)`)
      .slice(0, 10)
      .join(', ')
    const dismissedKeywords = Object.entries(clickHistory)
      .filter(([, stats]) => (stats.dismisses || 0) > 0)
      .map(([kw, stats]) => `${kw}(${stats.dismisses} dismisses)`)
      .slice(0, 10)
      .join(', ')

    const systemPrompt = `You are a news editor for a UK-based neutral news app called NeutralWire. Your job is to pick the ONE story from a list that will get the highest click-through rate from UK readers.

Rules for picking:
- UK-relevant stories (UK politics, UK events, UK economy, Premier League, royal family) ALWAYS beat US-only political process stories
- Major world events (wars, disasters, breakthroughs) beat domestic political minutiae
- Tech, science, and business stories are great for variety — don't ignore them
- Avoid: Trump daily minutiae, US poll numbers, US committee hearings, gaffes, spokesperson quotes
- Prefer: things that affect people's lives, shocking events, historic firsts, practical news
- If the user has clicked on similar topics before, boost those
- If the user has dismissed similar topics, avoid those

Respond with ONLY the number (1-${candidates.length}) of the best story. No explanation, no other text.`

    const userPrompt = `Slot: ${slot} (morning/lunch/evening notification for UK readers)

Stories:
${storyList}

${clickedKeywords ? `User previously clicked on: ${clickedKeywords}` : 'No click history yet.'}
${dismissedKeywords ? `User previously dismissed: ${dismissedKeywords}` : ''}

Which story number (1-${candidates.length}) will get the most clicks from UK readers? Reply with ONLY the number.`

    // Use multi-provider AI chain (Groq → Gemini → OpenRouter)
    const aiResponse = await callAI({ systemPrompt, userPrompt })

    if (aiResponse) {
      // Extract the number from the response
      const match = aiResponse.match(/(\d+)/)
      if (match) {
        const idx = parseInt(match[1], 10) - 1
        if (idx >= 0 && idx < candidates.length) {
          console.log(`[trigger] AI picked story #${idx + 1}: ${candidates[idx].title.slice(0, 60)}`)
          return candidates[idx]
        }
      }
    }

    // AI failed or unparseable — fall through to keyword scoring
    console.warn('[trigger] AI failed, using keyword fallback')
    return pickBestStoryWithKeywords(candidates, clickHistory)
  } catch (err) {
    console.warn('[trigger] AI selection failed, using keyword fallback:', err)
    return pickBestStoryWithKeywords(candidates, clickHistory)
  }
}

/**
 * Keyword-based fallback story selection (used if AI fails).
 */
function pickBestStoryWithKeywords(
  stories: TopicArticle[],
  clickHistory: Record<string, { clicks: number; dismisses: number }>,
): TopicArticle {
  const interestingKeywords = [
    'war', 'attack', 'crash', 'explosion', 'fire', 'earthquake', 'storm',
    'flood', 'emergency', 'crisis', 'breakthrough', 'launch', 'discovery',
    'election', 'vote', 'protest', 'strike', 'deal', 'summit', 'treaty',
    'ban', 'arrest', 'charge', 'court', 'ruling', 'verdict', 'resign',
    'death', 'dies', 'killed', 'injured', 'rescue', 'survive', 'escape',
    'historic', 'unprecedented', 'record', 'first', 'largest', 'biggest',
    'secret', 'leaked', 'exposed', 'reveal', 'confirm', 'deny',
  ]

  const ukKeywords = [
    'uk', 'britain', 'british', 'england', 'london', 'scotland',
    'wales', 'parliament', 'westminster', 'starmer', 'nhs', 'brexit',
    'premier league', 'prince', 'king charles', 'royal',
  ]

  const boringKeywords = [
    'trump says', 'trump claims', 'trump attacks', 'trump threatens',
    'trump praises', 'trump blasts', 'gop rep', 'senator says',
    'poll numbers', 'approval rating', 'teleprompter', 'gaffe',
  ]

  let best = stories[0]
  let bestScore = -1

  for (const story of stories) {
    let score = story.coverage * 10
    if (story.imageUrl) score += 20
    const titleLower = story.title.toLowerCase()

    for (const kw of interestingKeywords) {
      if (titleLower.includes(kw)) { score += 25; break }
    }
    for (const kw of ukKeywords) {
      if (titleLower.includes(kw)) { score += 15; break }
    }
    for (const kw of boringKeywords) {
      if (titleLower.includes(kw)) { score -= 30; break }
    }

    if (score > bestScore) {
      bestScore = score
      best = story
    }
  }
  return best
}

/**
 * Trigger endpoint for sending a SPECIFIC notification slot.
 *
 * Called by cron-job.org at morning/lunch/evening times.
 * Uses the click prediction system to pick the best story for each slot.
 *
 * Usage:
 *   GET /api/push/trigger?slot=morning&secret=<SECRET>
 */
export async function GET(req: NextRequest) {
  try {
    const slot = req.nextUrl.searchParams.get('slot') as
      | 'morning'
      | 'lunch'
      | 'evening'
      | null
    const secret = req.nextUrl.searchParams.get('secret') || ''
    const expectedSecret = process.env.TRIGGER_SECRET || 'neutralwire-trigger'

  if (secret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!slot || !['morning', 'lunch', 'evening'].includes(slot)) {
    return NextResponse.json(
      { error: 'Missing or invalid slot. Use ?slot=morning|lunch|evening' },
      { status: 400 },
    )
  }

  const todayKey = new Date().toISOString().slice(0, 10)
  const origin = req.nextUrl.origin

  // Fetch stories from multiple categories (reduced to 3 for speed).
  let allStories: TopicArticle[] = []
  const categories = ['relevant', 'world', 'technology']

  try {
    const results = await Promise.allSettled(
      categories.map(async (cat) => {
        const newsRes = await fetch(
          `${origin}/api/news?category=${cat}&country=GB&limit=5&minCoverage=1`,
          { cache: 'no-store' },
        )
        if (newsRes.ok) {
          const newsData = await newsRes.json()
          return newsData.topics || []
        }
        return []
      }),
    )
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allStories.push(...result.value)
      }
    }
  } catch {
    // continue without
  }

  // Deduplicate by topicId (same story may appear in multiple categories)
  const seen = new Set<string>()
  const topStories = allStories.filter((s) => {
    if (seen.has(s.topicId)) return false
    seen.add(s.topicId)
    return true
  })

  if (topStories.length === 0) {
    return NextResponse.json({ sent: 0, error: 'No stories available' })
  }

  // ── AI-powered story selection ──
  // Load click history from Firebase (used by AI for personalisation).
  const clickHistory = await firebaseRead<Record<string, { clicks: number; opens: number; dismisses: number }>>(
    'notification-stats',
  ) || {}

  // Load stories already sent today (to avoid duplicates).
  const sentToday = await firebaseRead<string[]>(`sent-today/${todayKey}`) || []

  // Filter out stories already sent today.
  const unsentStories = topStories.filter((s) => !sentToday.includes(s.topicId))
  const candidates = unsentStories.length > 0 ? unsentStories : topStories

    // Use AI to pick the best story for UK engagement.
    const bestStory = await pickBestStoryWithAI(candidates, slot, clickHistory)

  // ── Image selection (simplified for speed) ──
  // Use the story's imageUrl directly — no proxy validation (too slow).
  // The /api/img proxy in the push payload handles validation at delivery time.
  const imageUrl = bestStory.imageUrl
    ? `${origin}/api/img?url=${encodeURIComponent(bestStory.imageUrl)}`
    : `${origin}/icon-512.png`

  const slotTitles: Record<string, string> = {
    morning: 'Morning Briefing',
    lunch: 'Lunch Briefing',
    evening: 'Evening Briefing',
  }

  // Build FULL URL for the notification click target.
  const clickUrl = `${origin}/?topic=${bestStory.topicId}`

  // ── Archive the FULL topic in Firebase so shared links work forever ──
  // This stores the complete topic (title, summary, all articles, bias,
  // image, etc.) under archive/<topicId>. When someone opens a shared
  // link weeks later, /api/topic/[id] checks the archive first.
  await firebaseWrite(`archive/${bestStory.topicId}`, {
    ...bestStory,
    archivedAt: Date.now(),
  })

  // Title = slot name (e.g. "Morning Briefing")
  // Description = headline, limited to ~100 chars (mobile notifications
  // cut off after ~100 chars with "..." — we truncate cleanly at a word
  // boundary so it doesn't look broken)
  const fullTitle = bestStory.title
  let description = fullTitle
  if (fullTitle.length > 100) {
    // Truncate at the last word boundary before 100 chars
    const truncated = fullTitle.slice(0, 100)
    const lastSpace = truncated.lastIndexOf(' ')
    description = truncated.slice(0, lastSpace > 60 ? lastSpace : 100)
  }
  const result = await sendPushifyNotification({
    title: slotTitles[slot],
    description: description,
    url: clickUrl,
    image: imageUrl,
    notifId: `notif_${todayKey}_${slot}`,
    origin,
  })

  // Record that we sent this story today (to avoid duplicates).
  const newSentToday = [...sentToday, bestStory.topicId]
  await firebaseWrite(`sent-today/${todayKey}`, newSentToday)

  // Store the notification in Firebase for click tracking.
  const notifId = `notif_${todayKey}_${slot}`
  await firebaseWrite(`notifications/${notifId}`, {
    slot,
    topicId: bestStory.topicId,
    title: bestStory.title.slice(0, 80),
    sentAt: Date.now(),
    clicked: false,
    dismissed: false,
  })

  return NextResponse.json({
    slot,
    success: result.success,
    sent: result.sent,
    error: result.error,
    story: bestStory.title.slice(0, 60),
    clickUrl,
    time: new Date().toISOString(),
  })
  } catch (err) {
    // Catch ANY error and return a proper JSON response (prevents 500
    // with empty body that cron-job.org reports as "Failed").
    console.error('[trigger] FATAL:', err)
    return NextResponse.json({
      error: 'Internal error',
      detail: err instanceof Error ? err.message : String(err),
      time: new Date().toISOString(),
    }, { status: 500 })
  }
}
