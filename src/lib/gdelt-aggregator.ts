/**
 * GDELT-based news aggregator for the "My Country" tab.
 *
 * Uses the GDELT DOC 2.0 API (https://api.gdeltproject.org/api/v2/doc/doc)
 * to fetch articles sourced from a specific country (e.g. UK, US). GDELT
 * monitors 50,000+ news outlets worldwide and indexes articles by source
 * country — filtering by `sourcecountry:UK` returns only articles published
 * by UK-based outlets, which is exactly what "My Country" should show.
 *
 * Why GDELT instead of RSS for My Country:
 *   - RSS feeds are category-specific (politics, sports, etc.) and require
 *     a curated source list per country. The old system had ~11 UK sources
 *     and used an AI filter to pick UK-relevant stories, which was
 *     unreliable and often returned few/horrid results.
 *   - GDELT already indexes ALL UK outlets (thousands of local + national
 *     papers) and tags them by source country. Filtering by sourcecountry
 *     gives a comprehensive, real-time stream of UK news without any AI
 *     filtering needed.
 *
 * Flow:
 *   1. Query GDELT for articles where sourcecountry = the visitor's country
 *      (mapped from ISO code to GDELT country name), sourcelang = english,
 *      sorted by date descending, last 24h.
 *   2. Dedup articles by URL domain+path (GDELT sometimes returns the same
 *      article from multiple syndication partners).
 *   3. Filter out sports articles (keyword scan on title).
 *   4. Filter out obvious non-news (press releases, job ads, etc.).
 *   5. Cluster articles into topics by title similarity (so multiple
 *      outlets covering the same story group together, showing coverage).
 *   6. For each topic: pick the best title (most keywords), best image
 *      (highest-scored URL via scoreImageUrl), upgrade images to high-res.
 *   7. Validate the top N topic images (GET request to confirm they load).
 *   8. Sort by coverage desc + recency, return as TopicArticle[].
 *   9. Titles >140 chars are sent to the AI to be shortened (background,
 *      cached in Firebase — title-rewrites/<topicId>).
 *
 * Rate limiting: GDELT asks for max 1 request per 5 seconds. We cache the
 * result in Firebase (newsCache/mycountry__<CC>) with a 5-min TTL, so even
 * with many users we only hit GDELT once per 5 minutes per country.
 *
 * The Referer header is REQUIRED — without it GDELT returns 429 for
 * server-side requests.
 */

import type { Leaning } from '@/lib/news-sources'
import type { TopicArticle, FeedArticle } from '@/lib/news-aggregator'
import { callAI } from '@/lib/ai-providers'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'

const GDELT_API_URL = 'https://api.gdeltproject.org/api/v2/doc/doc'

// ISO country code → GDELT sourcecountry filter value.
// GDELT uses full country names (not ISO codes) for the sourcecountry filter.
const COUNTRY_TO_GDELT: Record<string, string> = {
  US: 'United States',
  GB: 'United Kingdom',
  UK: 'United Kingdom',
  CA: 'Canada',
  AU: 'Australia',
  IE: 'Ireland',
  NZ: 'New Zealand',
  IN: 'India',
  HK: 'Hong Kong',
  SG: 'Singapore',
  JP: 'Japan',
  KR: 'South Korea',
  CN: 'China',
  TW: 'Taiwan',
  DE: 'Germany',
  FR: 'France',
  ES: 'Spain',
  IT: 'Italy',
  PT: 'Portugal',
  NL: 'Netherlands',
  BE: 'Belgium',
  CH: 'Switzerland',
  AT: 'Austria',
  SE: 'Sweden',
  NO: 'Norway',
  DK: 'Denmark',
  FI: 'Finland',
  PL: 'Poland',
  BR: 'Brazil',
  AR: 'Argentina',
  MX: 'Mexico',
  CL: 'Chile',
  CO: 'Colombia',
  ZA: 'South Africa',
  NG: 'Nigeria',
  KE: 'Kenya',
  EG: 'Egypt',
  IL: 'Israel',
  SA: 'Saudi Arabia',
  AE: 'United Arab Emirates',
  TR: 'Turkey',
  RU: 'Russia',
  UA: 'Ukraine',
  PK: 'Pakistan',
  BD: 'Bangladesh',
  ID: 'Indonesia',
  MY: 'Malaysia',
  PH: 'Philippines',
  TH: 'Thailand',
  VN: 'Vietnam',
}

// Country code → short display name for AI prompts (e.g. "the UK", "the US")
const COUNTRY_DISPLAY: Record<string, string> = {
  US: 'the US', GB: 'the UK', UK: 'the UK', CA: 'Canada', AU: 'Australia',
  IE: 'Ireland', NZ: 'New Zealand', IN: 'India', HK: 'Hong Kong',
  SG: 'Singapore', JP: 'Japan', KR: 'South Korea', CN: 'China',
  TW: 'Taiwan', DE: 'Germany', FR: 'France', ES: 'Spain', IT: 'Italy',
  PT: 'Portugal', NL: 'the Netherlands', BE: 'Belgium', CH: 'Switzerland',
  AT: 'Austria', SE: 'Sweden', NO: 'Norway', DK: 'Denmark', FI: 'Finland',
  PL: 'Poland', BR: 'Brazil', AR: 'Argentina', MX: 'Mexico', CL: 'Chile',
  CO: 'Colombia', ZA: 'South Africa', NG: 'Nigeria', KE: 'Kenya',
  EG: 'Egypt', IL: 'Israel', SA: 'Saudi Arabia', AE: 'the UAE',
  TR: 'Turkey', RU: 'Russia', UA: 'Ukraine', PK: 'Pakistan',
  BD: 'Bangladesh', ID: 'Indonesia', MY: 'Malaysia', PH: 'the Philippines',
  TH: 'Thailand', VN: 'Vietnam',
}

// ── Stable daily AI ranking ──
// The ranking is cached per-country per-day in Firebase at:
//   gdelt-rankings/<countryCode>/<YYYY-MM-DD> = { rankedTopicIds: [...], topicTitles: {...}, ts: ... }
//
// STABILITY: Once a ranking is written for a day, it's the final order until
// the next day. This means the top stories stay in the same position all day
// (like BBC News) — they don't reshuffle on every refresh. New stories that
// arrive during the day are appended at the end (or the ranking is refreshed
// if >30% of topicIds are new).
//
// AI RANKING: The AI acts as a news editor — it sees all topic titles and
// ranks them by national importance (policy, major events, crime, weather
// warnings, infrastructure) rather than raw coverage. This produces a
// BBC-style top-stories list instead of a coverage-sorted feed.

interface CachedRanking {
  rankedTopicIds: string[]
  topicTitles: Record<string, string> // topicId → title (for detecting changes)
  ts: number
}

/**
 * Get today's date key (YYYY-MM-DD) in UTC. The ranking is stable for the
 * UTC day so it's consistent across timezones.
 */
function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Rank GDELT topics using AI, with a stable daily cache.
 *
 * Flow:
 *   1. Check Firebase for today's cached ranking (gdelt-rankings/<cc>/<date>).
 *   2. If cached AND >70% of current topicIds are in the cached ranking →
 *      use the cached order (stable for the day). New topics are appended.
 *   3. If no cache OR too many new topics → call the AI to rank all topics,
 *      write the result to Firebase, return the AI-ranked order.
 *   4. If the AI fails → fall back to coverage-desc + recency-desc sort.
 */
async function rankTopicsStably(
  topics: TopicArticle[],
  countryCode: string,
): Promise<TopicArticle[]> {
  if (topics.length === 0) return topics
  if (topics.length === 1) return topics

  const cc = countryCode.toUpperCase()
  const dateKey = todayKey()
  const cachePath = `gdelt-rankings/${cc}/${dateKey}`

  // 1. Check Firebase for today's cached ranking
  let cached: CachedRanking | null = null
  try {
    cached = await firebaseRead<CachedRanking>(cachePath)
  } catch {
    // silent
  }

  const topicMap = new Map(topics.map((t) => [t.topicId, t]))

  // 2. If cached, check how many current topics are already ranked
  if (cached && cached.rankedTopicIds && cached.rankedTopicIds.length > 0) {
    const rankedSet = new Set(cached.rankedTopicIds)
    const knownCount = topics.filter((t) => rankedSet.has(t.topicId)).length
    const knownRatio = knownCount / topics.length

    if (knownRatio >= 0.7) {
      // ≥70% of topics are already ranked → use cached order, append new ones
      const ordered: TopicArticle[] = []
      const used = new Set<string>()
      for (const id of cached.rankedTopicIds) {
        const topic = topicMap.get(id)
        if (topic) {
          ordered.push(topic)
          used.add(id)
        }
      }
      // Append new topics (not in the cached ranking) at the end, sorted by recency
      const newTopics = topics
        .filter((t) => !used.has(t.topicId))
        .sort((a, b) => b.latestSeen - a.latestSeen)
      ordered.push(...newTopics)

      console.log(`[gdelt-rank] ${cc}/${dateKey}: using cached ranking (${knownCount}/${topics.length} known, ${newTopics.length} new)`)
      return ordered
    }
  }

  // 3. No cache or too many new topics → call the AI to rank
  const countryDisplay = COUNTRY_DISPLAY[cc] || COUNTRY_TO_GDELT[cc] || cc

  // Build the story list for the AI (numbered, with coverage)
  // Limit to top 40 by coverage so the AI prompt isn't too long
  const candidates = [...topics]
    .sort((a, b) => b.coverage - a.coverage)
    .slice(0, 40)
  const storyList = candidates
    .map((t, i) => `${i + 1}. ${t.title}`)
    .join('\n')

  const systemPrompt = `You are the lead news editor for a ${countryDisplay} news app. Your job is to rank today's ${countryDisplay} news stories by NATIONAL IMPORTANCE — the way BBC News or a serious national broadcaster would order their top stories.

RANKING CRITERIA (most important first):
1. National policy, government decisions, major political developments
2. Major incidents: disasters, attacks, accidents, crime stories of national significance
3. Weather warnings, infrastructure failures, transport disruptions affecting many people
4. Health, education, economic news that affects the general public
5. Cultural stories, notable deaths, human-interest stories of broad appeal
6. Local/quirky stories go LAST

DEMOTE:
- Celebrity gossip, entertainment trivia
- Sports (already filtered but if any slip through, rank them last)
- Foreign news with no ${countryDisplay} angle
- Niche industry stories with no general-public relevance

Respond with ONLY a comma-separated list of story numbers (1-${candidates.length}) in ranked order, MOST IMPORTANT FIRST.
Example: 3,1,7,5,12,2,8
No explanation, no other text, JUST the numbers.`

  const userPrompt = `Country: ${countryDisplay}
Today's ${countryDisplay} news stories:

${storyList}

Rank these stories by national importance for ${countryDisplay} readers. Return ONLY the comma-separated list of story numbers, most important first.`

  try {
    const aiResponse = await callAI({ systemPrompt, userPrompt, maxTokens: 200 })

    if (aiResponse) {
      // Parse the comma-separated list of numbers
      const numbers = aiResponse
        .replace(/[^0-9,\s]/g, ' ')
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => parseInt(s, 10))
        .filter((n) => !isNaN(n) && n >= 1 && n <= candidates.length)

      if (numbers.length > 0) {
        // Map numbers back to topics (1-based → 0-based), dedup
        const ranked: TopicArticle[] = []
        const used = new Set<string>()
        for (const n of numbers) {
          const topic = candidates[n - 1]
          if (topic && !used.has(topic.topicId)) {
            ranked.push(topic)
            used.add(topic.topicId)
          }
        }
        // Append any topics the AI didn't rank (sorted by coverage desc)
        const unranked = topics.filter((t) => !used.has(t.topicId))
          .sort((a, b) => b.coverage - a.coverage)
        ranked.push(...unranked)

        // 4. Cache the ranking in Firebase for the day
        const ranking: CachedRanking = {
          rankedTopicIds: ranked.map((t) => t.topicId),
          topicTitles: Object.fromEntries(topics.map((t) => [t.topicId, t.title])),
          ts: Date.now(),
        }
        try {
          await firebaseWrite(cachePath, ranking)
        } catch {
          // silent — best-effort cache
        }

        console.log(`[gdelt-rank] ${cc}/${dateKey}: AI ranked ${numbers.length} topics, ${unranked.length} appended, cached to Firebase`)
        return ranked
      }
    }
  } catch (err) {
    console.warn(`[gdelt-rank] AI ranking failed for ${cc}, falling back to coverage sort:`, err)
  }

  // 5. AI failed → fall back to coverage desc + recency desc
  console.warn(`[gdelt-rank] ${cc}/${dateKey}: using fallback coverage sort`)
  return topics.sort((a, b) => {
    if (b.coverage !== a.coverage) return b.coverage - a.coverage
    return b.latestSeen - a.latestSeen
  })
}

// ---------- Country relevance filter ----------
// GDELT's sourcecountry filter returns articles from OUTLETS in that country,
// but those outlets also cover international news. This filter keeps only
// stories that are actually ABOUT the country (mention UK places, people,
// institutions, or use UK-specific terms).
//
// For the UK (GB): requires at least one UK keyword in the title.
// For other countries: uses their own keyword lists.
// Stories with NO country keyword are excluded (they're international news
// that a UK outlet happened to cover).

const COUNTRY_KEYWORDS_GDELT: Record<string, string[]> = {
  GB: [
    // UK places
    'uk', 'britain', 'british', 'england', 'english', 'london', 'scotland',
    'scottish', 'wales', 'welsh', 'northern ireland', 'belfast', 'edinburgh',
    'cardiff', 'manchester', 'birmingham', 'leeds', 'liverpool', 'bristol',
    'sheffield', 'newcastle', 'york', 'brighton', 'oxford', 'cambridge',
    'glasgow', 'aberdeen', 'dublin',
    // UK government/institutions
    'parliament', 'westminster', 'downing street', 'whitehall', 'number 10',
    'no 10', 'commons', 'lords', 'mps', 'mp ', 'tories', 'tory', 'labour',
    'conservative', 'lib dem', 'snp', 'reform uk', 'prime minister',
    'chancellor', 'home secretary', 'foreign secretary',
    // UK public services
    'nhs', 'ofsted', 'bbc', 'met office', 'hmrc', 'dvla', 'dwp',
    'council tax', 'income tax', 'vat', 'state pension',
    // UK legal
    'supreme court', 'high court', 'crown court', 'met police',
    'scotland yard', 'cps',
    // UK people (current)
    'starmer', 'burnham', 'sunak', 'farage', 'streeting', 'reeves',
    'badenoch', 'davey', 'khan', 'sadiq',
    // UK-specific terms
    'king charles', 'queen', 'prince william', 'princess', 'royal family',
    'windsor', 'buckingham', 'commonwealth', 'the crown',
    // UK transport
    'heathrow', 'gatwick', 'stansted', 'network rail', 'national rail',
    'hs2', 'transport for london', 'tfl',
    // UK companies/institutions
    'barclays', 'lloyds', 'hsbc', 'rbs', 'natwest', 'tesco', 'sainsbury',
    'marks and spencer', 'm&s', 'bt group', 'rolls-royce',
    // UK events/culture
    'premier league', 'fa cup', 'wimbledon', 'ashes', 'glastonbury',
    'commonwealth games', 'boat race', 'proms', 'bafta',
  ],
  US: [
    'us', 'america', 'american', 'united states', 'washington', 'white house',
    'capitol', 'congress', 'senate', 'house of representatives', 'pentagon',
    'supreme court', 'fbi', 'cia', 'doj', 'trump', 'biden', 'harris',
    'new york', 'los angeles', 'chicago', 'houston', 'phoenix',
  ],
}

function isAboutCountry(title: string, countryCode: string): boolean {
  const cc = countryCode.toUpperCase()
  const keywords = COUNTRY_KEYWORDS_GDELT[cc] || COUNTRY_KEYWORDS_GDELT[cc === 'UK' ? 'GB' : '']
  if (!keywords) return true // unknown country — don't filter

  const titleLower = ` ${title.toLowerCase()} `
  for (const kw of keywords) {
    // Word-boundary match for short keywords (uk, mp, us)
    if (kw.length <= 3) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`(?:^|[^a-z])${escaped}(?:[^a-z]|$)`, 'i')
      if (re.test(titleLower)) return true
    } else {
      if (titleLower.includes(kw)) return true
    }
  }
  return false
}

interface GdeltArticle {
  url: string
  url_mobile?: string
  title: string
  seendate: string // "20260728T151500Z"
  socialimage?: string
  domain: string
  language?: string
  sourcecountry?: string
}

// ---------- Domain → leaning map (best-effort, for the bias bar) ----------
// GDELT doesn't tag leaning, so we infer from the domain. This covers the
// major UK + international outlets; unknown domains default to 'center'.
const DOMAIN_LEANING: Record<string, Leaning> = {
  // UK
  'theguardian.com': 'left',
  'mirror.co.uk': 'left',
  'independent.co.uk': 'center',
  'bbc.co.uk': 'center',
  'bbc.com': 'center',
  'skynews.com': 'center',
  'ft.com': 'center',
  'economist.com': 'center',
  'telegraph.co.uk': 'right',
  'dailymail.co.uk': 'right',
  'express.co.uk': 'right',
  'thetimes.co.uk': 'center',
  'thesun.co.uk': 'right',
  'standard.co.uk': 'center',
  'huffingtonpost.co.uk': 'left',
  'huffpost.com': 'left',
  'nytimes.com': 'left',
  'washingtonpost.com': 'left',
  'cnn.com': 'left',
  'msnbc.com': 'left',
  'nbcnews.com': 'center',
  'cnbc.com': 'center',
  'abcnews.go.com': 'center',
  'cbsnews.com': 'center',
  'foxnews.com': 'right',
  'breitbart.com': 'right',
  'nypost.com': 'right',
  'thehill.com': 'center',
  'reuters.com': 'center',
  'apnews.com': 'center',
  'aljazeera.com': 'center',
  'france24.com': 'center',
  'dw.com': 'center',
}

function leaningForDomain(domain: string): Leaning {
  const d = domain.toLowerCase().replace(/^www\./, '')
  for (const [key, leaning] of Object.entries(DOMAIN_LEANING)) {
    if (d === key || d.endsWith('.' + key)) return leaning
  }
  return 'center'
}

// ---------- Sports filter ----------
const SPORTS_KEYWORDS = [
  'premier league', 'champions league', 'la liga', 'serie a', 'bundesliga',
  'nba', 'nfl', 'super bowl', 'nhl', 'fa cup', 'world cup', 'euro 202',
  'wimbledon', 'french open', 'us open', 'australian open', 'atp', 'wta',
  'fifa', 'uefa', 'rugby world cup', 'six nations', 'tour de france',
  'ipl', 'the ashes', 'arsenal', 'chelsea', 'liverpool fc', 'man city',
  'man united', 'manchester city', 'manchester united', 'tottenham', 'spurs',
  'newcastle united', 'aston villa', 'west ham', 'barcelona', 'real madrid',
  'bayern munich', 'paris saint-germain', 'juventus', 'lakers', 'celtics',
  'warriors', 'knicks', 'cowboys', 'chiefs', 'eagles', 'verstappen',
  'leclerc', 'norris', 'djokovic', 'alcaraz', 'sinner', 'joshua', 'fury',
  'usyk', 'haaland', 'mbappe', 'vinicius', 'bellingham', 'transfer news',
  'transfer window', 'transfer fee', 'goalkeeper', 'striker', 'midfielder',
  'grand prix', 'pole position', 'kickoff', 'full-time', 'half-time',
  'penalty shootout', 'match report', 'player ratings', 'squad', 'fixture',
  'premiership', 'championship', 'league one', 'league two',
]

function isSportsTitle(title: string): boolean {
  const t = title.toLowerCase()
  for (const kw of SPORTS_KEYWORDS) {
    if (t.includes(kw)) return true
  }
  return false
}

// ---------- Non-news filter ----------
// GDELT indexes everything published by news outlets, including press
// releases, job ads, obituaries, photo galleries, and sponsored content.
// These aren't "news" and pollute the feed.
const NON_NEWS_PATTERNS = [
  /^(job|jobs|careers|hiring|vacancy|vacancies)\b/i,
  /^(press release|sponsored|advertorial|promoted|paid content)\b/i,
  /\b(photo gallery|photos of the week|pictures of the day|in pictures)\b/i,
  /^(horoscope|weather forecast|lottery results|crossword|sudoku)\b/i,
  /^(obituary|death notice|in memoriam)\b/i,
  /\b(coupon|discount|deal of the day|black friday|cyber monday)\b/i,
]

function isNonNews(title: string): boolean {
  for (const pattern of NON_NEWS_PATTERNS) {
    if (pattern.test(title)) return true
  }
  return false
}

// ---------- Title keyword extraction (for clustering) ----------
const STOPWORDS = new Set([
  'a','an','the','and','or','but','if','then','for','of','to','in','on','at',
  'by','with','from','as','is','are','was','were','be','been','being','this',
  'that','these','those','it','its','they','them','their','there','here','we',
  'us','our','you','your','he','she','his','her','my','me','not','no','yes',
  'do','does','did','have','has','had','will','would','can','could','should',
  'may','might','must','about','after','before','between','during','through',
  'over','under','up','down','out','off','again','more','most','some','such',
  'only','own','same','so','than','too','very','just','also','new','one','two',
  'three','said','says','say','news','report','reports','amid','while','because',
  'since','until','without','within','against','above','below','into','onto',
  'upon','who','what','when','where','why','how','which','whom','whose','via',
])

function titleKeywords(t: string): Set<string> {
  const words = t.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean)
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

// ---------- Date parsing ----------
// GDELT format: "20260728T151500Z"
function parseGdeltDate(s: string): number {
  if (!s || s.length < 8) return Date.now()
  // YYYYMMDDTHHMMSSZ
  const y = parseInt(s.slice(0, 4), 10)
  const mo = parseInt(s.slice(4, 6), 10) - 1
  const d = parseInt(s.slice(6, 8), 10)
  const h = s.length >= 11 ? parseInt(s.slice(9, 11), 10) : 0
  const mi = s.length >= 13 ? parseInt(s.slice(11, 13), 10) : 0
  const se = s.length >= 15 ? parseInt(s.slice(13, 15), 10) : 0
  return Date.UTC(y, mo, d, h, mi, se)
}

// ---------- Hash ----------
function hashId(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return 'g' + (h >>> 0).toString(36) // 'g' prefix = GDELT-sourced
}

// ---------- Image URL scoring + upgrade (mirrors news-aggregator.ts) ----------
function upgradeToHighRes(url: string): string {
  if (!url) return url
  try {
    if (/ichef\.bbci\.co\.uk\//.test(url)) {
      return url.replace(/\/ace\/(?:standard|ic)\/\d+\//, '/ace/standard/800/')
    }
    if (/i\.guim\.co\.uk\//.test(url)) {
      return url.replace(/([?&])width=\d+/, '$1width=1200')
    }
    if (/static\d?\.nyt\.com\//.test(url)) {
      return url
        .replace(/-thumbStandard\./, '-articleLarge.')
        .replace(/-thumbLarge\./, '-articleLarge.')
        .replace(/-small\./, '-articleLarge.')
        .replace(/-mediumSquareAt3X\./, '-jumbo.')
    }
    if (/www\.aljazeera\.com\//.test(url)) {
      return url.replace(/\/(?:240|360|480|640)\//, '/1280/')
    }
    return url
  } catch {
    return url
  }
}

function scoreImageUrl(url: string): number {
  if (!url) return 0
  const u = url.toLowerCase()
  let score = 50
  if (/width=1[0-9]{3}/.test(u)) score += 40
  else if (/width=[7-9]\d{2}/.test(u)) score += 25
  else if (/width=\d{1,3}(?!\d)/.test(u)) score -= 20
  if (/\/(?:1[0-9]{3}|[7-9]\d{2})(?:x(?:1[0-9]{3}|[7-9]\d{2}))?\//.test(u)) score += 35
  if (/-jumbo\.|-articleLarge\.|-superJumbo\./.test(u)) score += 30
  if (/-mediumSquareAt3X\./.test(u)) score += 20
  if (/-thumbStandard\.|-thumbLarge\.|-small\./.test(u)) score -= 25
  return score
}

// ---------- Image validation ----------
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
    const buf = await res.arrayBuffer()
    const ok = (ct.startsWith('image/') || buf.byteLength > 1000) && buf.byteLength < 10 * 1024 * 1024
    VALIDATED_CACHE.set(url, { ts: Date.now(), ok })
    return ok
  } catch {
    VALIDATED_CACHE.set(url, { ts: Date.now(), ok: false })
    return false
  }
}

// ---------- Clustering ----------
// Group articles into topics by title similarity. Same approach as the main
// aggregator: Jaccard >= 0.22 OR shared significant keywords >= 3, within 48h.
function clusterGdeltArticles(articles: FeedArticle[]): TopicArticle[] {
  const kwSets = articles.map((a) => titleKeywords(a.title))
  const order = articles.map((_, i) => i).sort((a, b) => articles[b].iso - articles[a].iso)
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
      let shared = 0
      const setI = kwSets[i]
      for (const w of kwSets[j]) {
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

    // Build the topic from the cluster
    let bestTitle = articles[clusterIdx[0]].title
    let bestSummary = articles[clusterIdx[0]].description
    let bestImage = articles[clusterIdx[0]].imageUrl
    let bestKwSize = kwSets[clusterIdx[0]].size
    let firstSeen = articles[clusterIdx[0]].iso
    let latestSeen = articles[clusterIdx[0]].iso
    let leanLeft = 0, leanCenter = 0, leanRight = 0
    const seenSourceIds = new Set<string>()
    const clusterArticles: FeedArticle[] = []
    for (const idx of clusterIdx) {
      const a = articles[idx]
      if (!seenSourceIds.has(a.sourceId)) {
        seenSourceIds.add(a.sourceId)
        if (a.leaning === 'left') leanLeft++
        else if (a.leaning === 'center') leanCenter++
        else leanRight++
      }
      clusterArticles.push(a)
      if (kwSets[idx].size > bestKwSize) {
        bestKwSize = kwSets[idx].size
        bestTitle = a.title
        bestSummary = a.description
      }
      if (a.imageUrl) {
        const upgraded = upgradeToHighRes(a.imageUrl)
        if (!bestImage || scoreImageUrl(upgraded) > scoreImageUrl(bestImage)) {
          bestImage = upgraded
        }
      }
      if (a.iso < firstSeen) firstSeen = a.iso
      if (a.iso > latestSeen) latestSeen = a.iso
    }

    topics.push({
      topicId: hashId(bestTitle + '|' + firstSeen),
      title: bestTitle,
      summary: bestSummary,
      imageUrl: bestImage,
      coverage: clusterArticles.length,
      leanLeft,
      leanCenter,
      leanRight,
      firstSeen,
      latestSeen,
      articles: clusterArticles.sort((a, b) => b.iso - a.iso),
      localCoverage: 0, // GDELT articles are all from the country; localCoverage not applicable
    })
  }
  return topics
}

// ---------- Main: aggregate GDELT articles for a country ----------
/**
 * Fetch + cluster UK (or any country) news from GDELT.
 *
 * @param countryCode ISO 3166-1 alpha-2 code (e.g. "GB", "US")
 * @param limit max topics to return
 * @returns { topics, articleCount, sourceCount }
 */
export async function aggregateMyCountryViaGdelt(
  countryCode: string,
  limit: number = 40,
): Promise<{ topics: TopicArticle[]; articleCount: number; sourceCount: number }> {
  const cc = countryCode.toUpperCase()
  const gdeltCountry = COUNTRY_TO_GDELT[cc] || COUNTRY_TO_GDELT[cc === 'UK' ? 'GB' : ''] || null
  if (!gdeltCountry) {
    console.warn(`[gdelt] No GDELT country mapping for ${cc}, returning empty`)
    return { topics: [], articleCount: 0, sourceCount: 0 }
  }

  // Fetch up to 250 articles from GDELT (max allowed by the API).
  // sourcelang:english ensures English-language articles only.
  // sort:DateDesc gives the newest first.
  const query = `sourcecountry:"${gdeltCountry}" sourcelang:english`
  const url = `${GDELT_API_URL}?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=250&format=json&sort=DateDesc&timewindow=72h`

  let raw: GdeltArticle[] = []
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NeutralWireBot/1.0; +https://neutralwire.org)',
        // Referer is REQUIRED — without it GDELT returns 429 for server-side requests
        Referer: 'https://neutralwire.org',
        Accept: 'application/json',
      },
      cache: 'no-store',
    })
    if (!res.ok) {
      console.warn(`[gdelt] API returned ${res.status} for ${cc}`)
      return { topics: [], articleCount: 0, sourceCount: 0 }
    }
    const data = (await res.json()) as { articles?: GdeltArticle[] }
    raw = data.articles || []
  } catch (err) {
    console.warn(`[gdelt] fetch failed for ${cc}:`, err)
    return { topics: [], articleCount: 0, sourceCount: 0 }
  }

  if (raw.length === 0) {
    console.warn(`[gdelt] No articles for ${cc}`)
    return { topics: [], articleCount: 0, sourceCount: 0 }
  }

  // ── Convert GDELT articles to FeedArticle + filter ──
  const seenLinks = new Set<string>()
  const articles: FeedArticle[] = []
  for (const a of raw) {
    if (!a.url || !a.title) continue
    // Dedup by URL (strip query string for syndication dedup)
    const linkKey = a.url.split('?')[0].toLowerCase()
    if (seenLinks.has(linkKey)) continue
    seenLinks.add(linkKey)

    // Decode HTML entities + strip any HTML in the title
    let title = a.title
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ').trim()
    if (title.length < 8) continue

    // Skip sports
    if (isSportsTitle(title)) continue
    // Skip non-news
    if (isNonNews(title)) continue
    // Skip international stories that aren't about the country itself.
    // GDELT's sourcecountry filter returns articles from UK OUTLETS, but those
    // outlets also cover international news (Japan earthquake, US elections,
    // etc.). We only want stories that are ABOUT the UK.
    if (!isAboutCountry(title, cc)) continue

    const domain = a.domain || new URL(a.url).hostname
    const iso = parseGdeltDate(a.seendate)
    const imageUrl = a.socialimage ? upgradeToHighRes(a.socialimage) : null

    articles.push({
      id: hashId(a.url),
      title,
      link: a.url,
      description: '', // GDELT doesn't return descriptions
      pubDate: a.seendate,
      iso,
      imageUrl,
      sourceId: domain,
      sourceName: domain.replace(/^www\./, '').replace(/\.(co\.uk|com|org|net)$/i, ''),
      sourceHomepage: `https://${domain}`,
      leaning: leaningForDomain(domain),
      country: cc,
      category: 'mycountry',
    })
  }

  if (articles.length === 0) {
    return { topics: [], articleCount: 0, sourceCount: 0 }
  }

  // ── Cluster into topics ──
  const topics = clusterGdeltArticles(articles)

  // ── Rank topics using AI with a stable daily cache ──
  // The AI acts as a news editor, ranking stories by national importance
  // (policy, major events, crime, weather) rather than raw coverage. The
  // ranking is cached per-country per-day in Firebase so it stays stable
  // all day (like BBC News) — it doesn't reshuffle on every refresh.
  // Only re-ranks when >30% of topicIds are new.
  const ranked = await rankTopicsStably(topics, cc)

  // ── Validate images for the top 15 ranked topics ──
  const topicsForImageCheck = ranked.slice(0, 15)
  await Promise.all(
    topicsForImageCheck.map(async (topic) => {
      if (!topic.imageUrl) {
        // Try to find a working image from the cluster's articles
        for (const a of topic.articles) {
          if (a.imageUrl && await validateImageUrl(a.imageUrl)) {
            topic.imageUrl = a.imageUrl
            return
          }
        }
        topic.imageUrl = null
        return
      }
      // Validate the chosen image; if it fails, try article images
      if (!(await validateImageUrl(topic.imageUrl))) {
        let found = false
        for (const a of topic.articles) {
          if (a.imageUrl && await validateImageUrl(a.imageUrl)) {
            topic.imageUrl = a.imageUrl
            found = true
            break
          }
        }
        if (!found) topic.imageUrl = null
      }
    }),
  )

  // ── Slice to limit ──
  const result = ranked.slice(0, limit)

  console.log(`[gdelt] ${cc}: fetched ${raw.length} articles → ${articles.length} after filter → ${topics.length} topics → ${result.length} returned (AI-ranked)`)

  return {
    topics: result,
    articleCount: articles.length,
    sourceCount: new Set(articles.map((a) => a.sourceId)).size,
  }
}
