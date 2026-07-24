/**
 * News aggregation core: fetch RSS feeds, parse, dedup, cluster into topics.
 *
 * Extracted from /api/news/route.ts so both /api/news (cache-first read)
 * and /api/refresh (force RSS fetch + write cache) can share the same logic.
 */

import {
  NEWS_SOURCES,
  feedsForCategory,
  type Category,
  type Leaning,
  type NewsSource,
} from '@/lib/news-sources'
import { callAI } from '@/lib/ai-providers'
import { firebaseRead, firebasePatch } from '@/lib/firebase-server'

// ---------- Types ----------
export interface FeedArticle {
  id: string
  title: string
  link: string
  description: string
  pubDate: string | null
  iso: number
  imageUrl: string | null
  sourceId: string
  sourceName: string
  sourceHomepage: string
  leaning: Leaning
  country: string
  category: string
}

export interface TopicArticle {
  topicId: string
  title: string
  summary: string
  imageUrl: string | null
  coverage: number
  leanLeft: number
  leanCenter: number
  leanRight: number
  firstSeen: number
  latestSeen: number
  articles: FeedArticle[]
  /** How many articles in this topic are from the visitor's local sources. */
  localCoverage?: number
}

export interface CategoryCachePayload {
  updatedAt: number
  sourceCount: number
  articleCount: number
  topics: TopicArticle[]
}

// ---------- Per-feed cache (in-process) ----------
// Caches the raw RSS fetch per URL for a few minutes. Shared across
// categories because many feeds (e.g. BBC top) are reused.
interface FeedCacheEntry {
  ts: number
  articles: FeedArticle[]
}
const FEED_CACHE = new Map<string, FeedCacheEntry>()
const FEED_TTL_MS = 5 * 60 * 1000

// ---------- Stopwords ----------
const STOPWORDS = new Set([
  'a','an','the','and','or','but','if','then','else','for','of','to','in','on','at','by','with','from','as','is','are','was','were','be','been','being','this','that','these','those','it','its','they','them','their','there','here','we','us','our','you','your','he','she','his','her','my','me','not','no','yes','do','does','did','done','have','has','had','will','would','can','could','should','may','might','must','shall','about','after','before','between','during','through','over','under','up','down','out','off','again','more','most','some','such','only','own','same','so','than','too','very','just','also','new','one','two','three','said','says','say','saying','news','report','reports','reported','amid','amidst','while','because','since','until','without','within','against','above','below','into','onto','upon','who','what','when','where','why','how','which','whom','whose','whether','either','neither','both','each','other','another','via','am','pm','gmt','utc',
])

function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function titleKeywords(t: string): Set<string> {
  const words = normalizeTitle(t).split(' ').filter(Boolean)
  const out = new Set<string>()
  for (const w of words) {
    if (w.length < 3) continue
    if (STOPWORDS.has(w)) continue
    if (/^\d+$/.test(w)) continue
    out.add(w)
  }
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

// ---------- Content-based country relevance ----------
// Used by the "My Country" tab to filter stories by TOPIC content, not just
// by source. A story from BBC about Trump is NOT UK news — it's US politics
// that a UK outlet happens to cover. A story about Starmer, the NHS, or
// Premier League IS UK news regardless of which outlet covers it.
//
// Maps ISO country codes → keyword lists. A topic is "about country X" if
// its title OR summary contains at least one keyword from X's list.
const COUNTRY_KEYWORDS: Record<string, string[]> = {
  GB: [
    // Government & politics
    'uk ', 'uk,', 'uk.', 'uk\'s', 'britain', 'british', 'england', 'english',
    'scotland', 'scottish', 'wales', 'welsh', 'northern ireland', 'london',
    'westminster', 'parliament', 'downing street', 'whitehall', 'mps', 'mp ',
    'starmer', 'sunak', 'farage', 'corbyn', 'may ', 'johnson', 'truss',
    'labour party', 'conservative party', 'tories', 'tory ', 'snp', 'lib dem',
    'reform uk', 'greens', 'no 10', 'number 10',
    // Institutions
    'nhs', 'met police', 'scotland yard', 'bank of england', 'ofcom', 'ofsted',
    'bbc', 'royal mail', 'british army', 'raf', 'royal navy', 'mi5', 'mi6',
    // Royals
    'king charles', 'queen camilla', 'prince william', 'princess kate',
    'prince harry', 'meghan', 'royal family', 'buckingham palace',
    'kensington palace', 'windsor',
    // Geography
    'manchester', 'birmingham', 'leeds', 'liverpool', 'bristol', 'sheffield',
    'newcastle', 'nottingham', 'southampton', 'portsmouth', 'bournemouth',
    'reading', 'oxford', 'cambridge', 'brighton', 'cardiff', 'edinburgh',
    'glasgow', 'belfast', 'derry', 'aberdeen', 'dundee', 'york', 'bath',
    'exeter', 'plymouth', 'swansea', 'coventry', 'leicester', 'bradford',
    'stirling', 'inverness', 'norwich', 'ipswich',
    // Events / culture
    'premier league', 'champions league', 'fa cup', 'wimbledon', 'the open',
    'grand national', 'epsom derby', 'glastonbury', 'proms', 'bafta',
    'budget', 'chancellor', 'autumn statement', 'spring statement',
    'brexit', 'eurostar', 'hs2', 'crossrail', 'elizabeth line',
    'big ben', 'tower of london', 'stonehenge', 'lake district',
    'channel tunnel', 'isle of wight', 'jersey', 'guernsey', 'shetland',
    // More UK-specific
    'commonwealth games', 'ashes', 'river city', 'eastenders', 'coronation street',
    'strictly come dancing', 'match of the day', 'test match special',
    'city of london', 'square mile', 'thames', 'big ben',
    'burnham', 'sarwar', 'healey', 'miatta fahnbulleh', 'royal commission',
    'british isles', 'united kingdom',
    // UK politicians (current)
    'rachel reeves', 'angela rayner', 'david lammy', 'yvette cooper',
    'wes streeting', 'ed davey', 'penny mordaunt', 'kemi badenoch',
    'sadiq khan', 'andy burnham', 'anas sarwar', 'john swinney',
    'humza yousaf', 'mark drakeford', 'vaughan gething',
    // UK-specific terms
    'council tax', 'business rates', 'vat cut', 'income tax',
    'house of commons', 'house of lords', 'select committee',
    'green belt', 'national trust', 'english heritage',
    'luker wilde', 'frank whittle', 'raf', 'dambusters',
    'cobham', 'farnborough', 'goodwood', 'silverstone',
  ],
  US: [
    'us ', 'us,', 'us.', 'us\'s', 'america', 'american', 'united states',
    'washington', 'white house', 'capitol', 'congress', 'senate', 'house of representatives',
    'supreme court', 'scotus', 'pentagon', 'cia', 'fbi', 'doj',
    'trump', 'biden', 'harris', 'obama', 'clinton', 'bush',
    'republican', 'democrat', 'gop', 'dnc', 'rnc',
    'new york', 'los angeles', 'chicago', 'houston', 'phoenix', 'philadelphia',
    'san antonio', 'san diego', 'dallas', 'san francisco', 'seattle', 'boston',
    'denver', 'atlanta', 'miami', 'detroit', 'minneapolis', 'phoenix',
    'tampa', 'austin', 'portland', 'las vegas', 'nashville', 'memphis',
    'new orleans', 'cleveland', 'pittsburgh', 'cincinnati', 'baltimore',
    'milwaukee', 'kansas city', 'omaha', 'salt lake city', 'honolulu',
    'anchorage', 'des moines',
    'nfl', 'nba', 'mlb', 'nhl', 'super bowl', 'world series', 'march madness',
    'federal reserve', 'wall street', 'dow jones', 'nasdaq', 's&p 500',
    'pentagon', 'state department', 'department of', 'us treasury',
    '9/11', 'january 6', 'jan 6', 'capitol riot',
  ],
  CA: [
    'canada', 'canadian', 'ottawa', 'toronto', 'vancouver', 'montreal',
    'calgary', 'edmonton', 'winnipeg', 'halifax', 'quebec city', 'hamilton',
    'parliament hill', 'trudeau', 'carney', 'liberal party of canada',
    'conservative party of canada', 'ndp', 'bloc quebecois',
    'raptors', 'maple leafs', 'canucks', 'blue jays', 'expos',
    'rcmp', 'bank of canada',
  ],
  AU: [
    'australia', 'australian', 'aussie', 'canberra', 'sydney', 'melbourne',
    'brisbane', 'perth', 'adelaide', 'gold coast', 'newcastle', 'canberra',
    'hobart', 'darwin', 'parliament house', 'albanese', 'dutton',
    'liberal party of australia', 'labor party', 'coalition',
    'afl', 'nrl', 'aussie rules', 'wallabies', 'kangaroos',
    'reserve bank of australia', 'centrelink', ' medicare',
    'great barrier reef', 'uluru', 'outback',
  ],
}

/**
 * Detect whether a topic is "about" a given country based on its title
 * and summary content. Returns true if at least one country-specific
 * keyword is found.
 *
 * This is the KEY fix for the "My Country" tab — previously it showed
 * any story from UK sources (BBC, Guardian) including Trump news. Now
 * it only shows stories whose CONTENT is actually about the UK.
 *
 * Some keywords are matched as whole words (using word boundaries) to
 * avoid false positives — e.g. "tory" must not match inside "history",
 * "factory", "victory", etc.
 */
function isTopicAboutCountry(
  topic: TopicArticle,
  countryCode: string,
): boolean {
  const keywords = COUNTRY_KEYWORDS[countryCode.toUpperCase()]
  if (!keywords) return true // unknown country — don't filter (show everything)
  const text = ` ${topic.title} ${topic.summary} `.toLowerCase()

  // Keywords that need word-boundary matching (short words that are
  // substrings of common words — "tory" → "history", "may" → "mayor", etc.)
  const wordBoundaryKeywords = new Set([
    'tory', 'tories', 'mp ', 'mps', 'may ', 'labour', 'raf', 'nhs',
    'us ', 'us,', 'us.', 'uk ', 'uk,', 'uk.', 'mp',
  ])

  for (const kw of keywords) {
    if (wordBoundaryKeywords.has(kw)) {
      // Word-boundary match: the keyword must be surrounded by non-letter
      // characters (space, punctuation, start/end of text).
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // \b doesn't work well with trailing space, so use a custom pattern:
      // match the keyword followed by a non-letter or end of string
      const re = new RegExp(`(?:^|[^a-z])${escaped.replace(/ $/, '')}(?:[^a-z]|$)`, 'i')
      if (re.test(text)) return true
    } else {
      if (text.includes(kw)) return true
    }
  }
  return false
}

// ---------- AI-based country filtering + ranking ----------
// Used by the "My Country" tab as the PRIMARY filter. The AI is much smarter
// than keyword matching — it understands context (e.g. "Burnham" is a UK
// politician, not just a city) and can rank stories by importance + recency.
//
// DEFAULT-DENY model (important!):
//   New topics from the RSS feed are HIDDEN from "My Country" until the AI
//   explicitly approves them. This prevents the bug where a freshly-fetched
//   non-UK story (e.g. Trump from BBC) briefly appears at the top until the
//   AI removes it.
//
//   Flow:
//     1. Load the set of AI-approved topicIds from Firebase
//        (ai-country-approved/<countryCode>/<topicId> = timestamp)
//     2. Topics already in the approved set → return immediately (fast path)
//     3. Topics NOT in the approved set → send to AI for vetting
//     4. AI responds with approved topicIds + ranking
//     5. Write newly-approved topicIds to Firebase (persist across instances)
//     6. Return ONLY AI-approved topics in AI-ranked order
//     7. If AI fails → return ONLY previously-approved topics (NOT keyword
//        fallback — keyword fallback would let non-UK stories through)

// In-process cache (per-instance, fast). Backed by Firebase for persistence.
interface AICacheEntry {
  ts: number
  approvedTopicIds: Set<string> // topicIds the AI approved
  rankedTopicIds: string[] // topicIds in AI-ranked order
}
const AI_FILTER_CACHE = new Map<string, AICacheEntry>()
const AI_FILTER_CACHE_TTL_MS = 8 * 60 * 1000 // 8 min (matches news cache TTL)

// Firebase path for AI-approved topicIds per country.
// ai-country-approved/<CC>/<topicId> = timestamp
const AI_APPROVED_PATH = (cc: string) => `ai-country-approved/${cc.toUpperCase()}`

/**
 * Load the set of AI-approved topicIds for a country from Firebase.
 * Returns a Set of topicId strings.
 */
async function loadApprovedTopicIds(countryCode: string): Promise<Set<string>> {
  try {
    const data = await firebaseRead<Record<string, number>>(AI_APPROVED_PATH(countryCode))
    if (!data) return new Set()
    return new Set(Object.keys(data))
  } catch {
    return new Set()
  }
}

/**
 * Persist newly-approved topicIds to Firebase so they survive across
 * serverless instances. We only need to write the NEW ones (not already
 * in Firebase) to keep writes small.
 */
async function persistApprovedTopicIds(
  countryCode: string,
  topicIds: string[],
): Promise<void> {
  if (topicIds.length === 0) return
  const patch: Record<string, number> = {}
  const now = Date.now()
  for (const id of topicIds) {
    patch[id] = now
  }
  try {
    await firebasePatch(AI_APPROVED_PATH(countryCode), patch)
  } catch {
    // silent — best-effort
  }
}

/**
 * Use the AI fallback chain to filter + rank topics by country relevance.
 *
 * DEFAULT-DENY: Topics not yet approved by the AI are HIDDEN. They only
 * appear after the AI explicitly vets them. This prevents non-UK stories
 * from briefly appearing at the top of "My Country" when new RSS articles
 * arrive.
 *
 * Flow:
 *   1. Load AI-approved topicIds from Firebase (persistent)
 *   2. Split topics into ALREADY-APPROVED (cached) and NEEDS-VETTING (new)
 *   3. Send ALL topics to the AI for vetting + ranking (so the AI sees the
 *      full picture and can rank newly-approved ones against existing ones)
 *   4. Write newly-approved topicIds to Firebase
 *   5. Return ONLY AI-approved topics in AI-ranked order
 *   6. If AI fails → return ONLY previously-approved topics (no keyword
 *      fallback — that would let non-UK stories through)
 */
async function aiFilterAndRankCountryTopics(
  topics: TopicArticle[],
  countryCode: string,
): Promise<TopicArticle[]> {
  if (topics.length === 0) return topics

  const countryName = COUNTRY_DISPLAY_NAMES[countryCode.toUpperCase()] || countryCode
  const cc = countryCode.toUpperCase()

  // 1. Load previously-approved topicIds from Firebase (persistent).
  const previouslyApproved = await loadApprovedTopicIds(countryCode)

  // 2. Check in-process cache. If recent, we can return immediately for
  //    topics that were approved. But we still need to vet any NEW topics
  //    that arrived since the last AI call.
  const cached = AI_FILTER_CACHE.get(cc)
  const cacheFresh = cached && Date.now() - cached.ts < AI_FILTER_CACHE_TTL_MS

  // Identify NEW topics: not in Firebase-approved set AND not in cache.
  // These need AI vetting before they can be shown.
  const newTopics = topics.filter(
    (t) => !previouslyApproved.has(t.topicId) && (!cacheFresh || !cached!.approvedTopicIds.has(t.topicId)),
  )

  // If there are no new topics AND we have a fresh cache, use the cached
  // ranking (fast path — no AI call needed).
  if (newTopics.length === 0 && cacheFresh && cached) {
    const topicMap = new Map(topics.map((t) => [t.topicId, t]))
    const ranked = cached.rankedTopicIds
      .map((id) => topicMap.get(id))
      .filter((t): t is TopicArticle => t !== undefined)
    if (ranked.length > 0) {
      console.log(`[ai-filter] Cache hit for ${cc} (${ranked.length} topics, 0 new)`)
      return ranked
    }
  }

  // 3. Send ALL topics to the AI for vetting + ranking.
  //    The AI sees the full list and decides which are ABOUT the country.
  //    Previously-approved topics are likely to be re-approved; new topics
  //    get vetted for the first time.
  //    Send up to 40 stories (was 30) to ensure enough UK content gets through.
  const now = Date.now()
  const aiTopics = topics.slice(0, 40)
  const storyList = aiTopics.map((t, i) => {
    const ageH = Math.round((now - t.latestSeen) / (60 * 60 * 1000))
    const summary = (t.summary || '').slice(0, 120)
    return `${i + 1}. [${ageH}h old, ${t.coverage} sources] ${t.title}${summary ? ` — ${summary}` : ''}`
  }).join('\n')

  const systemPrompt = `You are a ${countryName} news editor for NeutralWire, a neutral news aggregator. Your job is to decide which stories should appear in the "${countryName} News" section.

INCLUSION RULES (be GENEROUS — aim for 15-25 stories, not just 5-10):
- INCLUDE any story that is ABOUT ${countryName}: ${countryName} politics, events, people, places, institutions, culture, sport, business, or weather.
- INCLUDE stories about ${countryName} politicians, cities, laws, companies, or cultural events — even if foreign outlets covered them.
- INCLUDE stories that SIGNIFICANTLY AFFECT ${countryName}: major trade deals, wars involving ${countryName} allies, climate agreements, international treaties ${countryName} is part of, global economic shifts that impact ${countryName}.
- INCLUDE stories about ${countryName} people abroad (e.g. a ${countryName} citizen involved in a major international event).
- INCLUDE ${countryName} sport, entertainment, and lifestyle stories.
- INCLUDE ${countryName} court cases, crime, and policing stories.

EXCLUSION RULES (be strict ONLY about these):
- EXCLUDE pure foreign politics that don't affect ${countryName} (e.g. Trump's daily statements, US poll numbers, US committee hearings, foreign election campaigns).
- EXCLUDE foreign domestic news with no ${countryName} angle (e.g. a US state law change, a Japanese local election).
- EXCLUDE generic world news with no ${countryName} connection (e.g. a Middle East ceasefire update that doesn't mention ${countryName}).

KEY DISTINCTION:
- BBC covering Trump's latest tweet → EXCLUDE (foreign politics, no UK angle)
- BBC covering a UK politician's response to Trump → INCLUDE (UK angle)
- BBC covering a Middle East war where UK troops are involved → INCLUDE (UK angle)
- BBC covering a Middle East war with no UK involvement → EXCLUDE (no UK angle)

RANKING (IMPORTANCE > RECENCY):
- Rank included stories by IMPORTANCE first (broadest coverage + biggest impact).
- COVERAGE is the #1 ranking signal: a story covered by 13 sources ALWAYS ranks
  above a story covered by 2 sources, regardless of age.
- Recency is a TIE-BREAKER only: among stories with similar coverage, newer wins.
- A 12-hour-old story with 13 sources ranks ABOVE a 30-minute-old story with 2 sources.
- This keeps the day's biggest stories at the top all day, not just the latest.
- Major breaking news (wars, resignations, historic events) gets a boost even
  with fewer sources.

OUTPUT FORMAT:
- Return ONLY a comma-separated list of story numbers (1-${aiTopics.length}) in ranked order.
- Include ALL stories that match the inclusion rules above — don't be stingy.
- Most important (highest coverage + biggest impact) first.
- Example: 3,1,7,5,12,2,8,15
- No explanation, no other text, JUST the numbers.`

  const userPrompt = `Country: ${countryName}
Stories:
${storyList}

Which story numbers (1-${aiTopics.length}) should appear in the "${countryName} News" section? Be generous — include all stories that are about ${countryName} or significantly affect it. Rank by IMPORTANCE first (broadest coverage + biggest impact), then recency as tie-breaker. Return them as a comma-separated list. ONLY the numbers.`

  try {
    const aiResponse = await callAI({ systemPrompt, userPrompt })

    if (!aiResponse) {
      // AI FAILED — return ONLY previously-approved topics (default-deny).
      // Do NOT fall back to keyword filtering — that would let non-UK
      // stories through. Instead, return the cached/known-good list.
      console.warn(`[ai-filter] AI returned no response for ${cc}, returning ${previouslyApproved.size} previously-approved topics only`)
      const approvedSet = previouslyApproved
      const topicMap = new Map(topics.map((t) => [t.topicId, t]))
      // Return previously-approved topics in coverage order (best we can do
      // without the AI's ranking)
      const result = topics
        .filter((t) => approvedSet.has(t.topicId))
        .sort((a, b) => b.coverage - a.coverage)
      if (result.length > 0) return result
      // If we have NO previously-approved topics AND the AI failed, return
      // empty (don't show anything unvetted). This is better than showing
      // non-UK stories.
      console.warn(`[ai-filter] No previously-approved topics for ${cc}, returning empty list (default-deny)`)
      return []
    }

    // Parse the comma-separated list of numbers
    const numbers = aiResponse
      .replace(/[^0-9,\s]/g, ' ')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => parseInt(s, 10))
      .filter((n) => !isNaN(n) && n >= 1 && n <= aiTopics.length)

    if (numbers.length === 0) {
      // AI returned nothing parseable — return previously-approved only.
      console.warn(`[ai-filter] AI returned no valid numbers for ${cc}, returning ${previouslyApproved.size} previously-approved topics`)
      const approvedSet = previouslyApproved
      return topics
        .filter((t) => approvedSet.has(t.topicId))
        .sort((a, b) => b.coverage - a.coverage)
    }

    // Map numbers back to topics (1-based → 0-based index)
    const rankedTopics: TopicArticle[] = []
    const newlyApproved: string[] = []
    for (const n of numbers) {
      const topic = aiTopics[n - 1]
      if (topic && !rankedTopics.find((t) => t.topicId === topic.topicId)) {
        rankedTopics.push(topic)
        // Track which ones are newly approved (not in Firebase yet)
        if (!previouslyApproved.has(topic.topicId)) {
          newlyApproved.push(topic.topicId)
        }
      }
    }

    if (rankedTopics.length === 0) {
      // AI approved nothing — return previously-approved only.
      console.warn(`[ai-filter] AI approved no topics for ${cc}, returning ${previouslyApproved.size} previously-approved`)
      const approvedSet = previouslyApproved
      return topics
        .filter((t) => approvedSet.has(t.topicId))
        .sort((a, b) => b.coverage - a.coverage)
    }

    console.log(`[ai-filter] AI approved ${rankedTopics.length}/${topics.length} topics for ${cc} (${newlyApproved.length} new)`)

    // 4. Persist newly-approved topicIds to Firebase (default-deny persistence)
    if (newlyApproved.length > 0) {
      await persistApprovedTopicIds(countryCode, newlyApproved)
    }

    // 5. Update in-process cache
    const allApproved = new Set([...previouslyApproved, ...rankedTopics.map((t) => t.topicId)])
    AI_FILTER_CACHE.set(cc, {
      ts: Date.now(),
      approvedTopicIds: allApproved,
      rankedTopicIds: rankedTopics.map((t) => t.topicId),
    })

    return rankedTopics
  } catch (err) {
    // AI threw — return previously-approved only (default-deny).
    console.warn(`[ai-filter] AI failed for ${cc}, returning ${previouslyApproved.size} previously-approved:`, err)
    const approvedSet = previouslyApproved
    return topics
      .filter((t) => approvedSet.has(t.topicId))
      .sort((a, b) => b.coverage - a.coverage)
  }
}

// ── Sports AI filter (separate cache key from country filters) ──
// Reuses the same default-deny + Firebase persistence pattern as the
// country filter, but with a sports-specific prompt.
const AI_SPORTS_CACHE_KEY = '__sports__'

/**
 * Use the AI fallback chain to filter + rank SPORTS topics.
 *
 * Sports RSS feeds sometimes include non-sports articles (business stories
 * about a team's finances, celebrity gossip about an athlete). The AI
 * filters those out and ranks the genuine sports stories by importance.
 *
 * Same default-deny model as the country filter — new topics are HIDDEN
 * until the AI explicitly approves them.
 */
async function aiFilterAndRankSportsTopics(
  topics: TopicArticle[],
): Promise<TopicArticle[]> {
  if (topics.length === 0) return topics

  const cc = AI_SPORTS_CACHE_KEY
  const previouslyApproved = await loadApprovedTopicIds(cc)

  const cached = AI_FILTER_CACHE.get(cc)
  const cacheFresh = cached && Date.now() - cached.ts < AI_FILTER_CACHE_TTL_MS

  const newTopics = topics.filter(
    (t) => !previouslyApproved.has(t.topicId) && (!cacheFresh || !cached!.approvedTopicIds.has(t.topicId)),
  )

  if (newTopics.length === 0 && cacheFresh && cached) {
    const topicMap = new Map(topics.map((t) => [t.topicId, t]))
    const ranked = cached.rankedTopicIds
      .map((id) => topicMap.get(id))
      .filter((t): t is TopicArticle => t !== undefined)
    if (ranked.length > 0) {
      console.log(`[ai-filter] Sports cache hit (${ranked.length} topics, 0 new)`)
      return ranked
    }
  }

  const now = Date.now()
  const aiTopics = topics.slice(0, 40)
  const storyList = aiTopics.map((t, i) => {
    const ageH = Math.round((now - t.latestSeen) / (60 * 60 * 1000))
    const summary = (t.summary || '').slice(0, 120)
    return `${i + 1}. [${ageH}h old, ${t.coverage} sources] ${t.title}${summary ? ` — ${summary}` : ''}`
  }).join('\n')

  const systemPrompt = `You are a sports news editor for NeutralWire. Your job is to decide which stories are genuinely about SPORTS and should appear in the "Sports" section.

INCLUSION RULES:
- INCLUDE stories about any sport: football, cricket, rugby, tennis, F1, golf, boxing, UFC, athletics, basketball, baseball, NFL, NHL, Olympics, cycling, swimming, etc.
- INCLUDE match results, transfers, injuries, team news, player interviews, coaching changes, league standings, tournaments.
- INCLUDE sports business news ONLY if it's primarily about the sport (e.g. "Premier League agrees new TV deal" = INCLUDE; "Manchester United stock price drops" = EXCLUDE if it's pure finance).

EXCLUSION RULES:
- EXCLUDE pure business/finance stories about sports teams (stock prices, sponsorship deals with no sporting angle).
- EXCLUDE celebrity gossip about athletes that isn't about their sport.
- EXCLUDE political stories that mention sports tangentially.
- EXCLUDE non-sports content that slipped into the sports RSS feed.

RANKING:
- Rank by IMPORTANCE (major matches, transfers, breaking news = highest) and RECENCY (newer = higher).
- A Champions League final ranks above a minor league result.

OUTPUT FORMAT:
- Return ONLY a comma-separated list of story numbers (1-${aiTopics.length}) in ranked order.
- Only include stories that are genuinely about SPORTS.
- Most important/newest first.
- Example: 3,1,7,5,12,2,8
- No explanation, no other text, JUST the numbers.`

  const userPrompt = `Stories:
${storyList}

Which story numbers (1-${aiTopics.length}) are genuinely about SPORTS? Return them as a comma-separated list in ranked order (most important/newest first). ONLY the numbers.`

  try {
    const aiResponse = await callAI({ systemPrompt, userPrompt })

    if (!aiResponse) {
      console.warn(`[ai-filter] AI returned no response for sports, returning ${previouslyApproved.size} previously-approved`)
      return topics
        .filter((t) => previouslyApproved.has(t.topicId))
        .sort((a, b) => b.coverage - a.coverage)
    }

    const numbers = aiResponse
      .replace(/[^0-9,\s]/g, ' ')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => parseInt(s, 10))
      .filter((n) => !isNaN(n) && n >= 1 && n <= aiTopics.length)

    if (numbers.length === 0) {
      return topics
        .filter((t) => previouslyApproved.has(t.topicId))
        .sort((a, b) => b.coverage - a.coverage)
    }

    const rankedTopics: TopicArticle[] = []
    const newlyApproved: string[] = []
    for (const n of numbers) {
      const topic = aiTopics[n - 1]
      if (topic && !rankedTopics.find((t) => t.topicId === topic.topicId)) {
        rankedTopics.push(topic)
        if (!previouslyApproved.has(topic.topicId)) {
          newlyApproved.push(topic.topicId)
        }
      }
    }

    if (rankedTopics.length === 0) {
      return topics
        .filter((t) => previouslyApproved.has(t.topicId))
        .sort((a, b) => b.coverage - a.coverage)
    }

    console.log(`[ai-filter] Sports: AI approved ${rankedTopics.length}/${topics.length} (${newlyApproved.length} new)`)

    if (newlyApproved.length > 0) {
      await persistApprovedTopicIds(cc, newlyApproved)
    }

    const allApproved = new Set([...previouslyApproved, ...rankedTopics.map((t) => t.topicId)])
    AI_FILTER_CACHE.set(cc, {
      ts: Date.now(),
      approvedTopicIds: allApproved,
      rankedTopicIds: rankedTopics.map((t) => t.topicId),
    })

    return rankedTopics
  } catch (err) {
    console.warn(`[ai-filter] Sports AI failed, returning ${previouslyApproved.size} previously-approved:`, err)
    return topics
      .filter((t) => previouslyApproved.has(t.topicId))
      .sort((a, b) => b.coverage - a.coverage)
  }
}

// Display names for the AI prompt
const COUNTRY_DISPLAY_NAMES: Record<string, string> = {
  GB: 'United Kingdom',
  UK: 'United Kingdom',
  US: 'United States',
  CA: 'Canada',
  AU: 'Australia',
  IE: 'Ireland',
  NZ: 'New Zealand',
  IN: 'India',
  DE: 'Germany',
  FR: 'France',
  ES: 'Spain',
  IT: 'Italy',
  NL: 'Netherlands',
  JP: 'Japan',
  KR: 'South Korea',
  CN: 'China',
  BR: 'Brazil',
  MX: 'Mexico',
  RU: 'Russia',
  UA: 'Ukraine',
  IL: 'Israel',
  AE: 'United Arab Emirates',
  SA: 'Saudi Arabia',
  TR: 'Turkey',
  ZA: 'South Africa',
  NG: 'Nigeria',
  EG: 'Egypt',
}

// ---------- RSS Parsing ----------
function parseFeed(xml: string, source: NewsSource, feedCategory: string): FeedArticle[] {
  const articles: FeedArticle[] = []
  const itemRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/g
  let m: RegExpExecArray | null

  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1]

    const title = extractTag(block, 'title') || ''
    const link =
      extractTag(block, 'link') ||
      extractAttr(block, 'link', 'href') ||
      ''
    const description =
      extractTag(block, 'description') ||
      extractTag(block, 'summary') ||
      extractTag(block, 'content') ||
      ''
    const pubDate =
      extractTag(block, 'pubDate') ||
      extractTag(block, 'published') ||
      extractTag(block, 'updated') ||
      extractTag(block, 'dc:date') ||
      null

    const imageUrl: string | null =
      extractAttr(block, 'media:content', 'url') ||
      extractAttr(block, 'media:thumbnail', 'url') ||
      extractAttr(block, 'enclosure', 'url') ||
      extractTag(block, 'image') ||
      extractImageFromHtml(description) ||
      null

    if (!title || !link) continue
    const cleanTitle = stripCdata(title).trim()
    const cleanLink = stripCdata(link).trim()
    if (!cleanTitle || !cleanLink) continue
    if (cleanTitle.length < 8) continue

    // Skip non-English articles.
    const decodedTitle = decodeEntities(cleanTitle)
    if (!isEnglish(decodedTitle)) continue

    // Make the title concise — strip source prefixes, remove live/live updates
    // tags, remove "BREAKING:", and shorten common patterns.
    const conciseTitle = makeConciseTitle(decodedTitle)

    const iso = parseDateToMs(pubDate)

    articles.push({
      id: hashId(cleanLink + '|' + source.id),
      title: conciseTitle,
      link: cleanLink,
      description: cleanDescription(description),
      pubDate,
      iso,
      imageUrl,
      sourceId: source.id,
      sourceName: source.name,
      sourceHomepage: source.homepage,
      leaning: source.leaning,
      country: source.country,
      category: feedCategory,
    })
  }

  return articles
}

function extractTag(block: string, tag: string): string | null {
  const re = new RegExp(
    `<${escapeReg(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeReg(tag)}>`,
    'i',
  )
  const m = block.match(re)
  return m ? m[1] : null
}

function extractAttr(block: string, tag: string, attr: string): string | null {
  const re = new RegExp(
    `<${escapeReg(tag)}\\b[^>]*\\b${escapeReg(attr)}\\s*=\\s*["']([^"']+)["'][^>]*`,
    'i',
  )
  const m = block.match(re)
  return m ? m[1] : null
}

function extractImageFromHtml(html: string): string | null {
  if (!html) return null
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i)
  return m ? m[1] : null
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripCdata(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;!\[CDATA\[([\s\S]*?)\]\]&gt;/g, '$1')
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

function parseDateToMs(s: string | null): number {
  if (!s) return Date.now()
  const t = Date.parse(s)
  if (Number.isNaN(t)) return Date.now()
  return t
}

/**
 * Thoroughly clean an RSS description field:
 *  1. Strip CDATA wrappers.
 *  2. Decode HTML entities (so &lt;p&gt; becomes <p>).
 *  3. Strip HTML tags (so <p> becomes nothing).
 *  4. Decode entities again (in case stripping revealed new entities).
 *  5. Collapse whitespace.
 *
 * This prevents encoded HTML like "&lt;p&gt;Hello&lt;/p&gt;" from showing
 * up as literal text in the card description.
 */

/**
 * Make a news title concise and clean.
 *
 * Strips:
 * - Source prefixes (e.g. "BBC News - ", "The Guardian - ")
 * - "BREAKING:", "LIVE:", "UPDATE:", "EXCLUSIVE:" tags
 * - "– live", "- live updates", "– video" suffixes
 * - Trailing " | Source Name"
 * - Extra whitespace
 *
 * Does NOT use AI (too slow for RSS parsing). This is a fast
 * regex-based cleaner that handles the most common patterns.
 */
function makeConciseTitle(title: string): string {
  let t = title.trim()

  // Remove leading tags: BREAKING, LIVE, UPDATE, EXCLUSIVE, DEVELOPING, ANALYSIS
  t = t.replace(/^(BREAKING|LIVE|UPDATE|UPDATED|EXCLUSIVE|DEVELOPING|ANALYSIS|JUST IN|REPORT)[\s:|-]+/i, '')

  // Remove source prefixes: "BBC News - ", "The Guardian - ", "Reuters: "
  t = t.replace(/^(BBC News|The Guardian|Reuters|AP|AFP|CNN|Fox News|NBC News|CBS News|ABC News|NPR|CNBC|New York Times|Washington Post|Financial Times|The Economist|Al Jazeera|France 24|Deutsche Welle|Bloomberg)[\s:|-]+/i, '')

  // Remove trailing live/update tags
  t = t.replace(/\s*[–-]\s*(live|live updates|live blog|video|analysis|opinion|report|explainer|podcast|poll|quiz|cartoon)\s*$/i, '')

  // Remove trailing " | Source Name" or " - Source Name"
  t = t.replace(/\s*[|\-]\s*[A-Z][\w\s]+$/, '')

  // Remove " | ..." patterns (e.g. "Story | BBC")
  t = t.replace(/\s*\|\s*[^|]+$/, '')

  // Collapse multiple spaces
  t = t.replace(/\s+/g, ' ').trim()

  // Remove trailing punctuation that looks messy
  t = t.replace(/[,;:\s]+$/, '')

  return t
}

function cleanDescription(raw: string): string {
  let s = stripCdata(raw)
  s = decodeEntities(s)
  s = stripHtml(s)
  s = decodeEntities(s)
  s = s.replace(/\s+/g, ' ').trim()
  return s.slice(0, 400)
}

// ---------- AI title shortening ----------
// Titles >15 words are sent to the AI to be shortened to a concise headline.
// Cached per-topicId in Firebase (title-rewrites/<topicId>) so we don't
// re-call the AI on every refresh.

// In-process cache (per-instance, fast).
const TITLE_REWRITE_CACHE = new Map<string, string>()
const TITLE_REWRITE_CACHE_TS = new Map<string, number>()
const TITLE_REWRITE_CACHE_TTL_MS = 30 * 60 * 1000 // 30 min

/**
 * Count words in a string.
 */
function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length
}

/**
 * Check if a title needs shortening (>15 words).
 */
function titleNeedsShortening(title: string): boolean {
  return wordCount(title) > 15
}

/**
 * Shorten long titles using the AI fallback chain.
 *
 * For each topic with >15 words, calls callAI with a prompt asking for a
 * concise 6-12 word headline that preserves the key facts.
 *
 * Result is cached in Firebase (title-rewrites/<topicId>) and in-process
 * so subsequent loads are instant.
 *
 * Operates IN PLACE on the topics array — modifies topic.title.
 * Runs in parallel for speed (batches of 5 to avoid rate limits).
 */
async function shortenLongTitles(topics: TopicArticle[]): Promise<void> {
  // Find topics that need shortening
  const toShorten = topics.filter((t) => titleNeedsShortening(t.title))
  if (toShorten.length === 0) return

  console.log(`[title-rewrite] ${toShorten.length} topics have >15 word titles, shortening...`)

  // Load existing rewrites from Firebase (one read for all)
  const existingRewrites = await firebaseRead<Record<string, string>>('title-rewrites')
  const rewriteMap = new Map<string, string>()
  if (existingRewrites) {
    for (const [id, title] of Object.entries(existingRewrites)) {
      rewriteMap.set(id, title)
    }
  }

  const newlyRewritten: Array<{ topicId: string; title: string }> = []

  // Process in batches of 5 to avoid hammering the AI providers
  const batchSize = 5
  for (let i = 0; i < toShorten.length; i += batchSize) {
    const batch = toShorten.slice(i, i + batchSize)
    await Promise.allSettled(
      batch.map(async (topic) => {
        // Check in-process cache first
        const cachedTs = TITLE_REWRITE_CACHE_TS.get(topic.topicId)
        const cachedTitle = TITLE_REWRITE_CACHE.get(topic.topicId)
        if (cachedTitle && cachedTs && Date.now() - cachedTs < TITLE_REWRITE_CACHE_TTL_MS) {
          topic.title = cachedTitle
          return
        }

        // Check Firebase cache
        const fbCached = rewriteMap.get(topic.topicId)
        if (fbCached) {
          topic.title = fbCached
          TITLE_REWRITE_CACHE.set(topic.topicId, fbCached)
          TITLE_REWRITE_CACHE_TS.set(topic.topicId, Date.now())
          return
        }

        // Call AI to shorten
        try {
          const shortened = await callAI({
            systemPrompt: `You are a news headline editor. Your job is to shorten long news headlines into concise, punchy headlines that preserve ALL the key facts.

Rules:
- Keep it 6-12 words.
- Preserve the most important facts (who, what, where, when if critical).
- Remove filler words ("the", "a", "says", "reports", "according to").
- Do NOT add information that isn't in the original.
- Do NOT add quotes around the result.
- Do NOT add "Headline:" or any prefix.
- Output ONLY the shortened headline, nothing else.`,
            userPrompt: `Original headline (${wordCount(topic.title)} words):
${topic.title}

Shorten to 6-12 words:`,
            maxTokens: 60,
          })

          if (shortened && wordCount(shortened) <= 15 && shortened.length < topic.title.length) {
            topic.title = shortened.trim().replace(/^["']|["']$/g, '')
            TITLE_REWRITE_CACHE.set(topic.topicId, topic.title)
            TITLE_REWRITE_CACHE_TS.set(topic.topicId, Date.now())
            newlyRewritten.push({ topicId: topic.topicId, title: topic.title })
          }
        } catch {
          // silent — keep original title
        }
      }),
    )
  }

  // Persist newly rewritten titles to Firebase (one patch for all)
  if (newlyRewritten.length > 0) {
    const patch: Record<string, string> = {}
    for (const { topicId, title } of newlyRewritten) {
      patch[topicId] = title
    }
    try {
      await firebasePatch('title-rewrites', patch)
      console.log(`[title-rewrite] Rewrote ${newlyRewritten.length} titles + persisted to Firebase`)
    } catch {
      // silent — best-effort
    }
  }
}

/**
 * Lightweight English-language detector for article titles.
 *
 * Returns true if the title appears to be in English. Uses two checks:
 * 1. Character-based: rejects titles with accented chars common in French
 *    (é, è, ê, à, ç, ù), German (ä, ö, ü, ß), Spanish (ñ, ¡, ¿), etc.
 *    These chars are rare in English news headlines.
 * 2. Word-based: rejects titles containing common non-English function words
 *    (le, la, les, des, du, et, dans, pour, avec, que, une — French;
 *     der, die, das, und, nicht, ist, von, mit — German; el, la, los, las,
 *     y, que, en, un, una, del — Spanish).
 *
 * This is a heuristic — it may occasionally let through a non-English title
 * or reject a rare English title with loan words, but it's good enough to
 * filter out the bulk of Le Monde (French) and occasional DW (German) articles.
 */
function isEnglish(title: string): boolean {
  if (!title) return true

  const lower = title.toLowerCase()

  // Check for non-English accented characters.
  // English headlines rarely contain these.
  const accentChars = /[éèêëàâçùûüôöîïäßñ¿¡à]/
  if (accentChars.test(lower)) {
    // Allow if it's just a name (e.g. "Café"), but reject if there are
    // 2+ accented chars (likely a non-English sentence).
    const accentCount = (lower.match(/[éèêëàâçùûüôöîïäßñ¿¡]/g) || []).length
    if (accentCount >= 2) return false
  }

  // Check for common non-English function words.
  // Split into words and check each — must match whole words, not substrings.
  const words = lower.split(/[^a-zà-ÿ]+/).filter(Boolean)
  const frenchWords = new Set([
    'le', 'la', 'les', 'des', 'du', 'de', 'et', 'dans', 'pour', 'avec',
    'que', 'une', 'sur', 'pas', 'plus', 'sous', 'ces', 'ses', 'mes',
    'nous', 'vous', 'ils', 'elles', 'est', 'sont', 'fait', 'après',
    'contre', 'entre', 'comme', 'autre', 'sans',
  ])
  const germanWords = new Set([
    'der', 'die', 'das', 'und', 'nicht', 'ist', 'von', 'mit', 'auf',
    'für', 'ein', 'eine', 'einen', 'dem', 'den', 'des', 'im', 'zum',
    'zur', 'auch', 'sich', 'bei', 'durch', 'über', 'aus', 'vor',
  ])
  const spanishWords = new Set([
    'el', 'los', 'las', 'y', 'en', 'un', 'una', 'del', 'al', 'lo',
    'que', 'con', 'por', 'para', 'su', 'se', 'no', 'más', 'pero',
    'como', 'todo', 'esto', 'ese', 'aquí', 'allá',
  ])

  let nonEnglishWordCount = 0
  for (const word of words) {
    if (frenchWords.has(word) || germanWords.has(word) || spanishWords.has(word)) {
      nonEnglishWordCount++
      if (nonEnglishWordCount >= 2) return false
    }
  }

  return true
}

function hashId(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return 'a' + (h >>> 0).toString(36)
}

// ---------- Feed Fetcher ----------
async function fetchFeed(
  url: string,
  source: NewsSource,
  feedCategory: string,
  signal: AbortSignal,
): Promise<FeedArticle[]> {
  const cached = FEED_CACHE.get(url)
  if (cached && Date.now() - cached.ts < FEED_TTL_MS) {
    return cached.articles
  }
  try {
    const res = await fetch(url, {
      signal,
      headers: {
        'User-Agent': 'GroundNewsFree/1.0 (news aggregator; contact@example.com)',
        Accept: 'application/rss+xml, application/xml, application/atom+xml, text/xml, */*',
      },
      cache: 'no-store',
    })
    if (!res.ok) return cached?.articles ?? []
    const xml = await res.text()
    const articles = parseFeed(xml, source, feedCategory)
    FEED_CACHE.set(url, { ts: Date.now(), articles })
    return articles
  } catch {
    return cached?.articles ?? []
  }
}

// ---------- OG Image Fallback ----------
/**
 * Fetch an article's HTML page and extract the og:image (or twitter:image)
 * meta tag. Used as a fallback when no image was found in the RSS feed.
 *
 * Times out after 5s. Returns null on any failure.
 */
const OG_IMAGE_CACHE = new Map<string, { ts: number; url: string | null }>()
const OG_IMAGE_TTL_MS = 30 * 60 * 1000 // 30 min

async function fetchOgImage(articleUrl: string): Promise<string | null> {
  if (!articleUrl) return null

  const cached = OG_IMAGE_CACHE.get(articleUrl)
  if (cached && Date.now() - cached.ts < OG_IMAGE_TTL_MS) {
    return cached.url
  }

  try {
    const res = await fetch(articleUrl, {
      signal: AbortSignal.timeout(5000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible: NeutralWireBot/1.0)',
        Accept: 'text/html, application/xhtml+xml',
      },
      redirect: 'follow',
      cache: 'no-store',
    })
    if (!res.ok) {
      OG_IMAGE_CACHE.set(articleUrl, { ts: Date.now(), url: null })
      return null
    }
    const html = await res.text()
    // Extract og:image or twitter:image meta tag.
    const ogMatch = html.match(
      /<meta\s+(?:property|name)=["']og:image["']\s+content=["']([^"']+)["']/i,
    )
    if (ogMatch?.[1]) {
      const url = ogMatch[1]
      OG_IMAGE_CACHE.set(articleUrl, { ts: Date.now(), url })
      return url
    }
    const twMatch = html.match(
      /<meta\s+(?:property|name)=["']twitter:image["']\s+content=["']([^"']+)["']/i,
    )
    if (twMatch?.[1]) {
      const url = twMatch[1]
      OG_IMAGE_CACHE.set(articleUrl, { ts: Date.now(), url })
      return url
    }
    // Also try og:image:url and og:image:secure_url
    const ogAltMatch = html.match(
      /<meta\s+(?:property|name)=["']og:image:(?:secure_)?url["']\s+content=["']([^"']+)["']/i,
    )
    if (ogAltMatch?.[1]) {
      const url = ogAltMatch[1]
      OG_IMAGE_CACHE.set(articleUrl, { ts: Date.now(), url })
      return url
    }
    OG_IMAGE_CACHE.set(articleUrl, { ts: Date.now(), url: null })
    return null
  } catch {
    OG_IMAGE_CACHE.set(articleUrl, { ts: Date.now(), url: null })
    return null
  }
}

/**
 * Check if an image URL is actually fetchable by downloading it.
 * Many news CDNs block HEAD requests or external access, so we do a
 * full GET and check the content-type. Returns the validated URL or null.
 *
 * Caches the result so we don't re-fetch the same image on every aggregation.
 */
const VALIDATED_CACHE = new Map<string, { ts: number; ok: boolean }>()
const VALIDATED_TTL_MS = 30 * 60 * 1000

async function validateImageUrl(url: string): Promise<boolean> {
  const cached = VALIDATED_CACHE.get(url)
  if (cached && Date.now() - cached.ts < VALIDATED_TTL_MS) {
    return cached.ok
  }

  try {
    const parsedUrl = new URL(url)
    const referer = `${parsedUrl.protocol}//${parsedUrl.host}/`

    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        Referer: referer,
      },
      redirect: 'follow',
      cache: 'no-store',
    })
    if (!res.ok) {
      VALIDATED_CACHE.set(url, { ts: Date.now(), ok: false })
      return false
    }
    const ct = res.headers.get('content-type') || ''
    // Read a small chunk to confirm it's actually image data.
    const buf = await res.arrayBuffer()
    const ok = (ct.startsWith('image/') || buf.byteLength > 1000) && buf.byteLength < 10 * 1024 * 1024
    VALIDATED_CACHE.set(url, { ts: Date.now(), ok })
    return ok
  } catch {
    VALIDATED_CACHE.set(url, { ts: Date.now(), ok: false })
    return false
  }
}

/**
 * For a topic, find the best HIGHEST-QUALITY image URL that works.
 *
 * Strategy:
 * 1. Always fetch OG images from article pages first — these are typically
 *    full-resolution (1200px+), much better than RSS thumbnails (240px).
 * 2. Fall back to existing article imageUrls (RSS-provided, may be small).
 * 3. Validate each candidate with a GET request.
 * 4. Prefer candidates with larger file sizes (proxy for higher resolution).
 *
 * Tries up to `maxAttempts` articles for OG images.
 */
async function findImageForTopic(
  topic: TopicArticle,
  maxAttempts = 5,
): Promise<string | null> {
  // Collect OG image candidates from article pages (high quality).
  const ogCandidates: string[] = []
  // Priority sources — ordered to PREFER sources whose images DON'T have
  // large watermarks/logos. The Guardian's images have a huge "Guardian"
  // logo in the corner that makes the site look like it's run by The
  // Guardian, so we deprioritise it. BBC, NYT, France 24, and Al Jazeera
  // tend to have cleaner images.
  const prioritySources = [
    'bbc', 'nytimes', 'france24', 'aljazeera', 'cnbc', 'ft', 'npr',
    'reuters-algolia', 'dw', 'japantimes',
  ]
  // Sources whose images have prominent watermarks — used last.
  const watermarkSources = ['theguardian', 'lemonde']
  const sorted = [...topic.articles].sort((a, b) => {
    const score = (id: string) => {
      if (prioritySources.includes(id)) return 0
      if (watermarkSources.includes(id)) return 2
      return 1
    }
    return score(a.sourceId) - score(b.sourceId)
  })

  // Fetch OG images from up to maxAttempts articles in parallel.
  const ogResults = await Promise.all(
    sorted.slice(0, maxAttempts).map(async (a) => {
      try {
        return await fetchOgImage(a.link)
      } catch {
        return null
      }
    }),
  )
  for (const url of ogResults) {
    if (url) ogCandidates.push(url)
  }

  // Validate OG candidates first (these are full-resolution).
  for (const url of ogCandidates) {
    if (await validateImageUrl(url)) return url
  }

  // Fall back to RSS-provided image URLs (may be lower quality).
  const rssCandidates: string[] = []
  if (topic.imageUrl) rssCandidates.push(topic.imageUrl)
  for (const a of topic.articles) {
    if (a.imageUrl) rssCandidates.push(a.imageUrl)
  }
  for (const url of rssCandidates) {
    if (await validateImageUrl(url)) return url
  }

  return null
}

// ---------- Topic Clustering ----------
/**
 * Cluster articles into topics based on title similarity.
 *
 * Two articles are clustered together if EITHER:
 *  - Jaccard similarity of their significant keywords >= 0.22 (lowered from 0.34
 *    to catch same-event stories worded differently), OR
 *  - They share 3+ significant keywords (catches cases where both titles are
 *    long and wordy, so Jaccard ratio is low even though they share key terms).
 *
 * Also: articles within 48h of each other (was 72h) to avoid clustering
 * unrelated stories that happen to share common words.
 *
 * `localSourceIds` is used to count how many articles per topic come from
 * the visitor's local sources — used by the Relevant tab to boost local news.
 */
function clusterTopics(
  articles: FeedArticle[],
  localSourceIds: Set<string> = new Set(),
): TopicArticle[] {
  const kwSets = articles.map((a) => titleKeywords(a.title))
  // Pre-compute as arrays for the "shared keyword count" check.
  const kwArrays = kwSets.map((s) => Array.from(s))

  const order = articles
    .map((_, i) => i)
    .sort((a, b) => articles[b].iso - articles[a].iso)

  const assigned = new Array(articles.length).fill(false)
  const topics: TopicArticle[] = []

  const JACCARD_THRESHOLD = 0.22
  const SHARED_KW_THRESHOLD = 3
  const TIME_WINDOW_MS = 48 * 60 * 60 * 1000

  for (const i of order) {
    if (assigned[i]) continue
    const clusterIdx: number[] = [i]
    assigned[i] = true

    for (const j of order) {
      if (assigned[j]) continue
      if (Math.abs(articles[i].iso - articles[j].iso) > TIME_WINDOW_MS) continue

      const sim = jaccard(kwSets[i], kwSets[j])
      if (sim >= JACCARD_THRESHOLD) {
        clusterIdx.push(j)
        assigned[j] = true
        continue
      }

      // Also cluster if they share enough significant keywords.
      // This catches same-event stories with different wording where
      // Jaccard is low (because the union is large) but they clearly
      // share the key entities.
      let shared = 0
      const setI = kwSets[i]
      for (const w of kwArrays[j]) {
        if (setI.has(w)) {
          shared++
          if (shared >= SHARED_KW_THRESHOLD) break
        }
      }
      if (shared >= SHARED_KW_THRESHOLD) {
        clusterIdx.push(j)
        assigned[j] = true
      }
    }

    let bestTitle = articles[clusterIdx[0]].title
    let bestSummary = articles[clusterIdx[0]].description
    let bestImage = articles[clusterIdx[0]].imageUrl
    let bestKwSize = kwSets[clusterIdx[0]].size
    let firstSeen = articles[clusterIdx[0]].iso
    let latestSeen = articles[clusterIdx[0]].iso

    let leanLeft = 0
    let leanCenter = 0
    let leanRight = 0
    let localCoverage = 0
    const seenSourceIds = new Set<string>()
    const seenLocalSourceIds = new Set<string>()

    const clusterArticles: FeedArticle[] = []
    for (const idx of clusterIdx) {
      const a = articles[idx]
      const isLocal = localSourceIds.has(a.sourceId)
      if (seenSourceIds.has(a.sourceId)) {
        if (a.leaning === 'left') leanLeft++
        else if (a.leaning === 'center') leanCenter++
        else leanRight++
        // Don't double-count local coverage for duplicate articles
        // from the same source — only count unique local sources.
        continue
      }
      seenSourceIds.add(a.sourceId)
      clusterArticles.push(a)
      if (a.leaning === 'left') leanLeft++
      else if (a.leaning === 'center') leanCenter++
      else leanRight++
      if (isLocal && !seenLocalSourceIds.has(a.sourceId)) {
        seenLocalSourceIds.add(a.sourceId)
        localCoverage++
      }

      if (kwSets[idx].size > bestKwSize) {
        bestKwSize = kwSets[idx].size
        bestTitle = a.title
        bestSummary = a.description
      }
      if (!bestImage && a.imageUrl) bestImage = a.imageUrl
      if (a.iso < firstSeen) firstSeen = a.iso
      if (a.iso > latestSeen) latestSeen = a.iso
    }

    const coverage = clusterArticles.length
    topics.push({
      topicId: hashId(bestTitle + '|' + firstSeen),
      title: bestTitle,
      summary: bestSummary,
      imageUrl: bestImage,
      coverage,
      leanLeft,
      leanCenter,
      leanRight,
      firstSeen,
      latestSeen,
      articles: clusterArticles.sort((a, b) => b.iso - a.iso),
      localCoverage,
    })
  }

  return topics
}

// ---------- Public: aggregate a category ----------
/**
 * Fetch all feeds for a category, dedup, cluster, return topics.
 * This is the slow path (10-20s) and is only used when:
 *   - Firebase cache is empty/missing, OR
 *   - User explicitly clicks Refresh, OR
 *   - Background refresh decides the cache is stale
 *
 * For virtual categories (`relevant`, `mycountry`), pass `countrySourceIds`
 * — the list of source IDs relevant to the visitor's country.
 */
export async function aggregateCategory(
  category: Category,
  options: {
    limit?: number
    minCoverage?: number
    countrySourceIds?: string[]
    countryCode?: string
  } = {},
): Promise<{ topics: TopicArticle[]; articleCount: number; sourceCount: number }> {
  const limit = options.limit ?? 24
  const minCoverage = options.minCoverage ?? 1

  const feeds = feedsForCategory(category, {
    countrySourceIds: options.countrySourceIds,
  })
  const ac = new AbortController()
  const timeout = setTimeout(() => ac.abort(), 18000)

  try {
    const results = await Promise.all(
      feeds.map((f) => fetchFeed(f.url, f.source, f.feedCategory, ac.signal)),
    )
    clearTimeout(timeout)

    const all: FeedArticle[] = []
    for (const r of results) all.push(...r)

    const seen = new Set<string>()
    const dedup: FeedArticle[] = []
    for (const a of all) {
      const key = a.sourceId + '|' + a.link
      if (seen.has(key)) continue
      seen.add(key)
      dedup.push(a)
    }

    const cutoff = Date.now() - 48 * 60 * 60 * 1000
    const fresh = dedup.filter((a) => a.iso >= cutoff)

    const localSet = new Set(options.countrySourceIds ?? [])
    const countryCode = options.countryCode || ''
    const isRelevantMode = category === 'relevant' && localSet.size > 0
    const isMyCountryMode = category === 'mycountry' && localSet.size > 0
    const isSportsMode = category === 'sports'

    const topics = clusterTopics(fresh, (isRelevantMode || isMyCountryMode) ? localSet : new Set())

    // For `mycountry` mode: use the AI fallback chain to filter + rank
    // topics by country relevance.
    //
    // The AI is much smarter than keyword matching — it understands context
    // (e.g. "Burnham" is a UK politician, not just a city name) and can
    // rank stories by importance + recency.
    //
    // Flow:
    //   1. Send all topic titles + summaries + age to the AI
    //   2. AI returns a comma-separated list of story numbers that are
    //      ABOUT the visitor's country, in ranked order
    //   3. We map those numbers back to topics and return them
    //   4. If AI fails, fall back to keyword filtering (isTopicAboutCountry)
    //
    // The AI result is cached per-country for 8 minutes to avoid calling
    // the AI on every page load.
    //
    // For `sports` mode: same AI filter, but asks "is this about sports?"
    // to eliminate non-sports outliers that slip through the RSS feeds
    // (e.g. a "sports" feed might include business articles about a team's
    // finances — the AI filters those out).
    let relevantTopics: TopicArticle[]
    if (isMyCountryMode && countryCode) {
      relevantTopics = await aiFilterAndRankCountryTopics(topics, countryCode)
    } else if (isSportsMode) {
      relevantTopics = await aiFilterAndRankSportsTopics(topics)
    } else {
      relevantTopics = topics
    }

    // Sort: for `relevant` category, give LOCAL news much higher priority
    // while keeping the absolute top stories based on coverage.
    //
    // The relevance score is:
    //   coverage * 10 + localCoverage * 5 + (hasLocal ? 30 : 0)
    //
    // - coverage * 10: a 12-source story (120) still beats an 11-source
    //   story (110) at the base level, so the biggest international story
    //   stays at #1.
    // - localCoverage * 5: each local source adds 5 points, so a 3-source
    //   UK story with 8 local sources scores 30 + 40 = 70, beating a
    //   5-source international story (50).
    // - hasLocal bonus (+30): any story with at least 1 local source gets
    //   a flat +30 boost, pushing UK-relevant stories above comparable
    //   international ones.
    //
    // Net effect: the major 10+ source story stays #1, but UK-focused
    // stories (even with just 2-3 sources) jump above mid-tier
    // international stories.
    // For `mycountry` mode, the AI has ALREADY ranked the topics by
    // importance + recency. We should NOT re-sort — just filter by
    // minCoverage and slice to limit. The AI's order is the final order.
    //
    // For `relevant` mode, we still use the local-boost sort (the AI
    // filter is only for `mycountry` and `sports`).
    //
    // For other categories, sort by coverage desc then recency desc.
    let filtered: TopicArticle[]
    if (isMyCountryMode || isSportsMode) {
      // AI already ranked — just filter + slice, preserve AI order
      filtered = relevantTopics
        .filter((t) => t.coverage >= minCoverage)
        .slice(0, limit)
    } else {
      filtered = relevantTopics
        .filter((t) => t.coverage >= minCoverage)
        .sort((a, b) => {
          if (isRelevantMode) {
            const la = a.localCoverage ?? 0
            const lb = b.localCoverage ?? 0
            const scoreA = a.coverage * 10 + la * 5 + (la > 0 ? 30 : 0)
            const scoreB = b.coverage * 10 + lb * 5 + (lb > 0 ? 30 : 0)
            if (scoreB !== scoreA) return scoreB - scoreA
            return b.latestSeen - a.latestSeen
          }
          if (b.coverage !== a.coverage) return b.coverage - a.coverage
          return b.latestSeen - a.latestSeen
        })
        .slice(0, limit)
    }

    // Image validation + fallback: for the top N topics, validate that the
    // existing imageUrl actually works (many CDNs return 401/403). If it
    // doesn't, or if there's no image, try to find a working one from the
    // article images or OG images.
    //
    // This runs in parallel for the top 10 topics to keep it fast.
    //
    // ── AI title shortening ──
    // Also runs before image validation: any topic with a title >15 words
    // is sent to the AI to be shortened to a concise 6-12 word headline.
    // Cached in Firebase (title-rewrites/<topicId>) so it only runs once
    // per topic. Runs in parallel for speed.
    await shortenLongTitles(filtered)

    const topicsForImageCheck = filtered.slice(0, 10)
    await Promise.all(
      topicsForImageCheck.map(async (topic) => {
        const img = await findImageForTopic(topic, 3)
        if (img) topic.imageUrl = img
        else topic.imageUrl = null // ensure broken URLs are cleared
      }),
    )

    return {
      topics: filtered,
      articleCount: fresh.length,
      sourceCount: NEWS_SOURCES.length,
    }
  } catch (err) {
    clearTimeout(timeout)
    throw err
  }
}
