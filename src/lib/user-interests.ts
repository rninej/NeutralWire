/**
 * User interests + engagement tracking (client-side utilities).
 *
 * Interests are stored both in localStorage (instant read) and Firebase
 * (shared across devices / used by the cron notification system).
 *
 * Engagement stats per sector are stored as percentages in Firebase at:
 *   devices/<deviceId>/engagement/<sector> = { score: 0..100, lastUpdate, clicks }
 *
 * Sectors align with the onboarding picker:
 *   politics, world, technology, business, science, health, sports, entertainment
 *
 * Scoring rule (per user request):
 *   +10% per relevant click (max 100%)
 *   "not over-specialized" — capped per-sector at 100% and the rest of the
 *   catalog still gets shown; we just *boost* matching topics in the feed.
 */

// ── Sectors ──
export const SECTORS = [
  { id: 'politics', label: 'Politics', emoji: '🏛️' },
  { id: 'world', label: 'World News', emoji: '🌍' },
  { id: 'technology', label: 'Technology', emoji: '💻' },
  { id: 'business', label: 'Business', emoji: '📈' },
  { id: 'science', label: 'Science', emoji: '🔬' },
  { id: 'health', label: 'Health', emoji: '🏥' },
  { id: 'sports', label: 'Sports', emoji: '⚽' },
  { id: 'entertainment', label: 'Entertainment', emoji: '🎬' },
] as const

export type SectorId = (typeof SECTORS)[number]['id']

const INTERESTS_KEY = 'neutralwire:interests'
const ENGAGEMENT_KEY = 'neutralwire:engagement'

// ── Interests (selected during onboarding) ──

export function getInterests(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(INTERESTS_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

export function setInterestsLocal(sectors: string[]): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(INTERESTS_KEY, JSON.stringify(sectors))
}

/**
 * Save interests to Firebase so the per-user notification cron can read them.
 * Calls /api/engagement which writes to devices/<deviceId>/interests.
 */
export async function syncInterestsWithFirebase(
  deviceId: string,
  sectors: string[],
): Promise<void> {
  if (!deviceId || typeof window === 'undefined') return
  try {
    await fetch('/api/engagement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'interests', deviceId, sectors }),
    }).catch(() => {})
  } catch {
    // silent
  }
}

// ── Engagement (per-sector scores 0..100) ──

export interface EngagementStats {
  [sector: string]: {
    score: number // 0..100
    clicks: number
    lastUpdate: number
  }
}

export function getEngagement(): EngagementStats {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(ENGAGEMENT_KEY)
    return raw ? (JSON.parse(raw) as EngagementStats) : {}
  } catch {
    return {}
  }
}

function saveEngagement(stats: EngagementStats): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(ENGAGEMENT_KEY, JSON.stringify(stats))
}

/**
 * Increment engagement for a sector by 10% (capped at 100).
 * Also persists to Firebase via /api/engagement (fire-and-forget).
 *
 * Reasons:
 *   - 'click'    → user opened a topic detail (default +10)
 *   - 'ai'       → user asked AI about a story (+10)
 *   - 'share'    → user shared a story (+15, stronger signal)
 *   - 'time'     → user spent time reading (called periodically, +2)
 */
export async function bumpEngagement(
  deviceId: string,
  sector: string,
  amount: number = 10,
  reason: 'click' | 'ai' | 'share' | 'time' = 'click',
): Promise<void> {
  const stats = getEngagement()
  const current = stats[sector] || { score: 0, clicks: 0, lastUpdate: 0 }
  current.score = Math.min(100, current.score + amount)
  current.clicks += 1
  current.lastUpdate = Date.now()
  stats[sector] = current
  saveEngagement(stats)

  // Sync to Firebase (best-effort, fire-and-forget)
  if (deviceId) {
    try {
      await fetch('/api/engagement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'engagement',
          deviceId,
          sector,
          amount,
          reason,
          total: current,
        }),
      }).catch(() => {})
    } catch {
      // silent
    }
  }
}

/**
 * Detect sectors for a topic and bump all of them.
 * Use this when a user opens a topic — it bumps every sector the topic
 * touches, so a "Trump signs AI executive order" story bumps both
 * 'politics' and 'technology'.
 */
export async function bumpEngagementForTopic(
  deviceId: string,
  title: string,
  summary: string = '',
  reason: 'click' | 'ai' | 'share' | 'time' = 'click',
): Promise<void> {
  const sectors = detectSectors(title, summary)
  for (const sector of sectors) {
    await bumpEngagement(deviceId, sector, reason === 'share' ? 15 : reason === 'time' ? 2 : 10, reason)
  }
}

// ── Keyword → Sector mapping ──
// Used to detect which sector a news topic belongs to (for both feed
// personalization and engagement tracking on click).

const SECTOR_KEYWORDS: Record<string, string[]> = {
  politics: [
    'trump', 'biden', 'starmer', 'parliament', 'congress', 'senate', 'election',
    'vote', 'voting', 'labour', 'conservative', 'tories', 'democrat', 'republican',
    'gop', 'mps', 'westminster', 'policy', 'government', 'minister',
    'prime minister', 'president', 'campaign', 'poll', 'lawmaker', 'legislation',
    'bill ', 'reform', 'cabinet', 'downing street', 'white house', 'scotus',
    'supreme court', 'court ruling', 'impeach', 'lawsuit', 'doj', 'attorney',
    'no 10', 'number 10', 'farage', 'reform uk', 'snp', 'lib dem',
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

/**
 * Detect which sectors a topic title/summary belongs to.
 * Returns an array of sector IDs (a topic may belong to multiple).
 */
export function detectSectors(title: string, summary: string = ''): string[] {
  const text = `${title} ${summary}`.toLowerCase()
  const matched = new Set<string>()
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    for (const kw of keywords) {
      // Word-boundary-ish match (avoids matching "fed " inside "fedora")
      if (text.includes(kw)) {
        matched.add(sector)
        break
      }
    }
  }
  // Default to 'world' if no match — keeps stories visible
  if (matched.size === 0) matched.add('world')
  return Array.from(matched)
}

/**
 * Compute a personalization boost score for a topic based on user interests
 * and engagement stats. Higher = more relevant to this user.
 *
 * Used by the news page to reorder the "Relevant" tab.
 *
 * Formula:
 *   base = topic.coverage (so high-coverage stories still rank well)
 *   + 3.0 × (interest match count)         → user picked this sector
 *   + 0.05 × (engagement score sum 0..100) → user clicks this sector often
 *   capped so a single topic can't get more than +8 boost
 */
export function personalizationBoost(
  topic: { title: string; summary: string; coverage: number },
  interests: string[],
  engagement: EngagementStats,
): number {
  const sectors = detectSectors(topic.title, topic.summary)
  let boost = topic.coverage

  let interestMatch = 0
  let engScore = 0
  for (const sector of sectors) {
    if (interests.includes(sector)) interestMatch += 1
    engScore += engagement[sector]?.score || 0
  }

  boost += Math.min(8, interestMatch * 3.0 + engScore * 0.05)
  return boost
}
