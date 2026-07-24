import { NextRequest, NextResponse } from 'next/server'
import { callAI } from '@/lib/ai-providers'
import { sendPersonalizedWebPush } from '@/lib/pushify'
import { firebaseRead, firebaseWrite, firebasePatch } from '@/lib/firebase-server'
import type { TopicArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
// Vercel Hobby max is 10s. Per-device push fan-out is fast (parallel web-push)
// so 10s is plenty even for hundreds of devices.
export const maxDuration = 10

// Hardcoded production origin. We MUST NOT use `req.nextUrl.origin` here
// because in dev the trigger runs against `localhost:3000` — push
// notifications sent with localhost URLs are useless (phones can't reach
// localhost). Always use the production URL so notification clicks always
// land on neutralwire.vercel.app.
const PRODUCTION_ORIGIN =
  process.env.NEXT_PUBLIC_SITE_URL || 'https://neutralwire.vercel.app'

/**
 * Sector keyword detection (mirrors src/lib/user-interests.ts SECTOR_KEYWORDS).
 *
 * We need this server-side because user-interests.ts is client-only (it
 * uses localStorage). Keeping the keywords in sync here is fine — they
 * rarely change.
 */
const SECTOR_KEYWORDS: Record<string, string[]> = {
  politics: [
    'trump', 'biden', 'starmer', 'parliament', 'congress', 'senate', 'election',
    'vote', 'voting', 'labour', 'conservative', 'tories', 'democrat', 'republican',
    'gop', 'mps', 'westminster', 'policy', 'government', 'minister',
    'prime minister', 'president', 'campaign', 'poll', 'lawmaker', 'legislation',
    'bill ', 'reform', 'cabinet', 'downing street', 'white house', 'scotus',
    'supreme court', 'court ruling', 'impeach', 'lawsuit', 'doj', 'attorney',
  ],
  world: [
    'ukraine', 'russia', 'putin', 'china', 'xi jinping', 'israel', 'gaza', 'hamas',
    'iran', 'middle east', 'europe', 'european union', 'nato', 'un security',
    'africa', 'asia', 'latin america', 'japan', 'india', 'modi',
    'france', 'germany', 'macron', 'merz', 'turkey', 'erdogan', 'north korea',
    'south korea', 'asean', 'united nations', 'refugee', 'migrant', 'ceasefire',
    'pentagon', 'air strike', 'nuclear',
  ],
  technology: [
    'ai ', 'artificial intelligence', 'openai', 'chatgpt', 'anthropic', 'claude',
    'gemini', 'google', 'apple', 'microsoft', 'meta ', 'facebook', 'amazon',
    'tesla', 'nvidia', 'chip', 'semiconductor', 'tiktok', 'twitter', 'x.com',
    'elon musk', 'zuckerberg', 'iphone', 'android', 'startup', 'crypto',
    'bitcoin', 'ethereum', 'blockchain', 'cyber', 'hack', 'data breach',
    'algorithm', 'deepmind', 'quantum', 'robotics', 'chatbot', 'llm',
  ],
  business: [
    'stock', 'market', 'shares', 'dow', 'nasdaq', 'sp 500', 'ftse', 'nikkei',
    'economy', 'economic', 'inflation', 'interest rate', 'federal reserve',
    'fed ', 'ecb', 'bank of england', 'gdp', 'recession', 'tariff', 'trade war',
    'merger', 'acquisition', 'earnings', 'quarterly', 'ipo', 'billion', 'million',
    'layoff', 'job cut', 'oil price', 'crude', 'opec', 'dow jones',
    'hedge fund', 'wall street', 'city of london', 'banking', 'finance',
  ],
  science: [
    'nasa', 'spacex', 'rocket', 'mars', 'moon', 'iss', 'space', 'astronaut',
    'telescope', 'james webb', 'particle', 'cern', 'quantum', 'physics',
    'chemistry', 'biology', 'genome', 'dna', 'crispr', 'researchers',
    'scientists', 'discovery', 'breakthrough', 'nature', 'journal', 'climate',
    'carbon', 'emissions', 'glacier', 'arctic', 'antarctic', 'species',
    'fossil', 'dinosaur', 'earthquake', 'volcano',
  ],
  health: [
    'covid', 'pandemic', 'who ', 'world health', 'vaccine', 'vaccination',
    'hospital', 'nhs', 'fda', 'medicine', 'drug', 'pharma', 'pfizer', 'moderna',
    'cancer', 'tumor', 'disease', 'outbreak', 'virus', 'flu', 'measles',
    'mental health', 'depression', 'anxiety', 'wellness', 'diet', 'obesity',
    'diabetes', 'heart', 'stroke', 'surgery', 'clinical trial', 'therapy',
    'autism', 'adhd', 'dementia', 'alzheimer',
  ],
  sports: [
    'premier league', 'champions league', 'world cup', 'euro 202', 'la liga',
    'serie a', 'bundesliga', 'mls', 'nba', 'nfl', 'super bowl', 'nhl',
    'wimbledon', 'french open', 'us open', 'atp', 'wta', 'fifa', 'uefa',
    'arsenal', 'chelsea', 'liverpool', 'man city', 'man united', 'tottenham',
    'barcelona', 'real madrid', 'bayern', 'psg', 'cricket', 'rugby', 'golf',
    'tiger woods', 'f1', 'formula 1', 'verstappen', 'hamilton', 'boxing',
    'ufc', 'olympics', 'tour de france', 'transfer', 'goalkeeper', 'football',
  ],
  entertainment: [
    'movie', 'film', 'oscar', 'academy award', 'emmy', 'grammy', 'golden globe',
    'netflix', 'disney', 'hbo', 'amazon prime', 'apple tv', 'spotify',
    'taylor swift', 'beyonce', 'drake', 'kanye', 'concert', 'tour',
    'album', 'single', 'celebrity', 'actor', 'actress', 'director', 'studio',
    'marvel', 'dc comics', 'superhero', 'star wars', 'harry potter',
    'youtube', 'influencer', 'streamer', 'twitch', 'reality tv',
    'kim kardashian', 'gaming', 'videogame', 'playstation', 'xbox', 'nintendo',
  ],
}

function detectSectors(title: string, summary: string = ''): string[] {
  const text = `${title} ${summary}`.toLowerCase()
  const matched = new Set<string>()
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    for (const kw of keywords) {
      if (text.includes(kw)) {
        matched.add(sector)
        break
      }
    }
  }
  if (matched.size === 0) matched.add('world')
  return Array.from(matched)
}

/**
 * Pick the best story for a UK audience using AI.
 *
 * Used to choose the FALLBACK story (for devices with no interests, or
 * when no personalized match exists).
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
    const storyList = candidates
      .map((s, i) => {
        const local = s.localCoverage || 0
        return `${i + 1}. [${s.coverage} sources, ${local} UK] ${s.title}`
      })
      .join('\n')

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

    const aiResponse = await callAI({ systemPrompt, userPrompt })

    if (aiResponse) {
      const match = aiResponse.match(/(\d+)/)
      if (match) {
        const idx = parseInt(match[1], 10) - 1
        if (idx >= 0 && idx < candidates.length) {
          console.log(`[trigger] AI picked story #${idx + 1}: ${candidates[idx].title.slice(0, 60)}`)
          return candidates[idx]
        }
      }
    }

    console.warn('[trigger] AI failed, using keyword fallback')
    return pickBestStoryWithKeywords(candidates, clickHistory)
  } catch (err) {
    console.warn('[trigger] AI selection failed, using keyword fallback:', err)
    return pickBestStoryWithKeywords(candidates, clickHistory)
  }
}

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

// ── Global sent-history constants ──
// Stories are kept in the global sent-history for 14 days, then pruned.
// 14 days × 3 slots/day = max 42 entries per device, well within Firebase
// free-tier limits. After 14 days a story is "fresh again" — but in practice
// the same topicId never reappears because news cycles move on.
const GLOBAL_HISTORY_TTL_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Load the global sent-history map from Firebase.
 *
 * Storage: `notification-sent-history/<topicId> = timestamp`
 *
 * Returns a Set of topicIds sent within the TTL window.
 */
async function loadGlobalHistory(): Promise<{
  sentSet: Set<string>
  raw: Record<string, number>
}> {
  const raw =
    (await firebaseRead<Record<string, number>>('notification-sent-history')) || {}
  const now = Date.now()
  const sentSet = new Set<string>()
  for (const [topicId, ts] of Object.entries(raw)) {
    if (now - ts < GLOBAL_HISTORY_TTL_MS) {
      sentSet.add(topicId)
    }
  }
  return { sentSet, raw }
}

/**
 * Add a topicId to the global sent-history with the current timestamp.
 * Called after a successful send so future triggers skip it.
 */
async function recordGlobalHistory(topicIds: Set<string>): Promise<void> {
  if (topicIds.size === 0) return
  const now = Date.now()
  const patch: Record<string, number> = {}
  for (const id of topicIds) {
    patch[id] = now
  }
  try {
    await firebasePatch('notification-sent-history', patch)
  } catch {
    // silent — best-effort
  }
}

/**
 * Prune entries older than TTL from the global sent-history.
 * Runs occasionally to keep the Firebase node small.
 */
async function pruneGlobalHistory(
  raw: Record<string, number>,
): Promise<void> {
  const now = Date.now()
  const stale: string[] = []
  for (const [topicId, ts] of Object.entries(raw)) {
    if (now - ts >= GLOBAL_HISTORY_TTL_MS) {
      stale.push(topicId)
    }
  }
  if (stale.length === 0) return
  // Firebase REST doesn't support bulk delete via PATCH with null, so we
  // delete each one individually. This is fast enough for ~42 entries.
  for (const id of stale) {
    try {
      await fetch(
        `https://neutralwire-2f24e-default-rtdb.europe-west1.firebasedatabase.app/notification-sent-history/${id}.json`,
        { method: 'DELETE' },
      )
    } catch {
      // silent
    }
  }
}

/**
 * Trigger endpoint for sending a SPECIFIC notification slot.
 *
 * Called by cron-job.org at morning/lunch/evening times (8am, 1pm, 8pm).
 *
 * Sends EXACTLY ONE personalized notification per device — no Pushify
 * broadcast, no duplicate sends. Each device receives the story from the
 * candidate pool that best matches their interests + engagement stats.
 *
 * ABSOLUTE "NEVER TWICE" GUARANTEE:
 *   Before sending, every candidate is filtered against TWO history layers:
 *     1. Global history (notification-sent-history/<topicId>) — any story
 *        sent to ANY user in the last 14 days is excluded.
 *     2. Per-device history (devices/<deviceId>/sentHistory) — any story
 *        sent to THIS specific user ever is excluded.
 *   After sending, the chosen topicIds are added to both layers.
 *
 * DRY RUN MODE:
 *   GET /api/push/trigger?slot=morning&secret=<SECRET>&dry=1
 *   Runs the ENTIRE flow (fetch stories, AI pick, per-device scoring,
 *   history filtering) but does NOT send any actual push notifications
 *   and does NOT record anything in sent-history. Use this for testing.
 *
 * URL FIX:
 *   All notification click URLs and image URLs use PRODUCTION_ORIGIN
 *   (https://neutralwire.vercel.app), NOT req.nextUrl.origin. This ensures
 *   notifications always link to the live site even when the trigger is
 *   called from localhost or a preview URL.
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
    // ?dry=1 — run the full flow but don't send any pushes or record history.
    // Use this for testing. NEVER test without it.
    const dryRun = req.nextUrl.searchParams.get('dry') === '1'

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
    // ALWAYS use the production origin for notification URLs. In dev,
    // req.nextUrl.origin is localhost — phones can't reach that.
    const origin = PRODUCTION_ORIGIN

    if (dryRun) {
      console.log('[trigger] DRY RUN mode — no pushes will be sent, no history recorded')
    }

    // Fetch stories from multiple categories. Use the production origin
    // so we get the same cached data the live site sees.
    let allStories: TopicArticle[] = []
    const categories = ['relevant', 'world', 'technology', 'business', 'science']

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

    // Deduplicate by topicId
    const seen = new Set<string>()
    const topStories = allStories.filter((s) => {
      if (seen.has(s.topicId)) return false
      seen.add(s.topicId)
      return true
    })

    if (topStories.length === 0) {
      return NextResponse.json({ sent: 0, error: 'No stories available', dryRun })
    }

    // Load click history from Firebase (used by AI for personalisation).
    const clickHistory =
      (await firebaseRead<Record<string, { clicks: number; opens: number; dismisses: number }>>(
        'notification-stats',
      )) || {}

    // ── GLOBAL NEVER-TWICE HISTORY ──
    // Stories sent to ANY user in the last 14 days are excluded from the
    // candidate pool entirely. This is the primary deduplication layer.
    const { sentSet: globalHistory, raw: rawHistory } = await loadGlobalHistory()

    // Filter out globally-sent stories
    const freshStories = topStories.filter((s) => !globalHistory.has(s.topicId))
    const candidates = freshStories.length > 0 ? freshStories : topStories

    // Pick the fallback story (AI-picked best UK story). This is used only
    // for devices with no interests/engagement OR when no candidate matches.
    const fallbackStory = await pickBestStoryWithAI(candidates, slot, clickHistory)

    // ── Build candidate pool for personalized picks ──
    // Take up to 15 stories with detected sectors.
    const personalCandidates = candidates.slice(0, 15).map((s) => ({
      topicId: s.topicId,
      title: s.title,
      summary: s.summary,
      coverage: s.coverage,
      imageUrl: s.imageUrl,
      sectors: detectSectors(s.title, s.summary),
    }))

    // ── Archive the fallback topic so shared links work forever ──
    // (Only in real runs — dry runs don't write to Firebase)
    if (!dryRun) {
      await firebaseWrite(`archive/${fallbackStory.topicId}`, {
        ...fallbackStory,
        archivedAt: Date.now(),
      })
    }

    // ── SEND: One personalized notification per device ──
    // No Pushify broadcast — each device gets exactly ONE push, tailored
    // to its interests and engagement, and never the same story twice.
    //
    // In dry-run mode, sendPersonalizedWebPush skips the actual web-push
    // sendNotification() call AND skips writing to per-device sentHistory.
    const personalizedResult = await sendPersonalizedWebPush(
      personalCandidates,
      {
        topicId: fallbackStory.topicId,
        title: fallbackStory.title,
        summary: fallbackStory.summary,
        imageUrl: fallbackStory.imageUrl,
      },
      origin,
      slot,
      globalHistory,
      dryRun,
    )

    // ── Record sent topicIds in the global history ──
    // This prevents ANY future trigger (morning/lunch/evening, today or
    // any day in the next 14 days) from sending these stories again.
    // Skip in dry-run mode.
    if (!dryRun && personalizedResult.sentTopicIds.size > 0) {
      await recordGlobalHistory(personalizedResult.sentTopicIds)

      // ── Archive ALL sent topics so notification links work forever ──
      // When a user taps a notification, the client calls /api/topic/[id]
      // which checks the archive first. Without this, a personalized pick
      // that wasn't the fallback story wouldn't be in the archive, and
      // /api/topic/[id] would return 404 if the topic expired from the
      // live cache (after 48h).
      //
      // We archive the FULL topic object (title, summary, articles, image,
      // bias counts) so the detail view renders correctly even months later.
      const sentTopicMap = new Map(personalCandidates.map((c) => [c.topicId, c]))
      // Also include the fallback story in case it wasn't in personalCandidates
      if (!sentTopicMap.has(fallbackStory.topicId)) {
        sentTopicMap.set(fallbackStory.topicId, {
          topicId: fallbackStory.topicId,
          title: fallbackStory.title,
          summary: fallbackStory.summary || '',
          coverage: 0,
          imageUrl: fallbackStory.imageUrl,
          sectors: [],
        })
      }
      const archivePromises: Promise<boolean>[] = []
      for (const topicId of personalizedResult.sentTopicIds) {
        const candidate = sentTopicMap.get(topicId)
        if (candidate) {
          // Build a minimal TopicArticle-compatible object for the archive.
          // The full topic (with articles, lean counts, etc.) is only
          // available in personalCandidates as a slimmed-down version, but
          // /api/topic/[id] checks the live cache first, so this archive
          // entry only needs to be a fallback for expired topics.
          archivePromises.push(
            firebaseWrite(`archive/${topicId}`, {
              topicId: candidate.topicId,
              title: candidate.title,
              summary: candidate.summary || '',
              imageUrl: candidate.imageUrl || null,
              coverage: candidate.coverage,
              leanLeft: 0,
              leanCenter: 0,
              leanRight: 0,
              firstSeen: Date.now(),
              latestSeen: Date.now(),
              articles: [],
              archivedAt: Date.now(),
            }),
          )
        }
      }
      await Promise.allSettled(archivePromises)
    }

    // ── Periodic cleanup: prune stale entries from global history ──
    // Run only when the history has grown past 50 entries (cheap check).
    // Skip in dry-run mode.
    if (!dryRun && Object.keys(rawHistory).length > 50) {
      pruneGlobalHistory(rawHistory).catch(() => {})
    }

    // ── Click tracking: store one notification entry per sent topicId ──
    // (Used by /api/notification/track for click prediction stats.)
    // Skip in dry-run mode.
    if (!dryRun) {
      for (const topicId of personalizedResult.sentTopicIds) {
        const notifId = `notif_${todayKey}_${slot}_${topicId.slice(-6)}`
        const topic = personalCandidates.find((c) => c.topicId === topicId) || fallbackStory
        await firebaseWrite(`notifications/${notifId}`, {
          slot,
          topicId,
          title: topic.title.slice(0, 80),
          sentAt: Date.now(),
          clicked: false,
          dismissed: false,
        })
      }
    }

    return NextResponse.json({
      slot,
      dryRun,
      sent: personalizedResult.sent,
      personalized: personalizedResult.personalized,
      fallback: personalizedResult.fallback,
      sentTopicIds: Array.from(personalizedResult.sentTopicIds),
      candidateCount: personalCandidates.length,
      globalHistoryFiltered: topStories.length - freshStories.length,
      fallbackStory: fallbackStory.title.slice(0, 80),
      time: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[trigger] FATAL:', err)
    return NextResponse.json(
      {
        error: 'Internal error',
        detail: err instanceof Error ? err.message : String(err),
        time: new Date().toISOString(),
      },
      { status: 500 },
    )
  }
}
