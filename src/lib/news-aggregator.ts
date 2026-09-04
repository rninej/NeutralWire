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
import { callAI, callVisionAI } from '@/lib/ai-providers'
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
  /** Video URL for this article when the RSS feed carries one — a
   *  media:content/enclosure with a video type (mp4/m3u8/etc.) or a
   *  direct YouTube watch link (some sources ARE YouTube channel feeds).
   *  Used by the experimental Watch button (/api/video/[topicId]) —
   *  "the source's own video" is always preferred over a search match.
   *  Optional so all existing cached articles keep validating. */
  videoUrl?: string | null
  /** Declared duration (seconds) of videoUrl when the RSS feed carries a
   *  media:content duration attribute — used by /api/video to enforce the
   *  "longer than 10 seconds" requirement on native source videos.
   *  Optional so all existing cached articles keep validating. */
  videoDuration?: number | null
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
  /** Blindspot metadata (only set for /api/news?category=blindspots) */
  blindspotSide?: 'left' | 'right'
  blindspotPct?: number
  /** Total articles found by GDELT for this country query (not just this
   * topic). Shown as "312 articles" in the topic detail. */
  totalArticles?: number
  /** Total distinct newsrooms (domains) found by GDELT for this country
   * query. Shown as "14 distinct newsrooms" in the topic detail. */
  totalNewsrooms?: number
  /** Global ranking boost from notification Likes (set by /api/news from
   * the topicBoost Firebase node). 0/undefined = normal position; each
   * like promotes the story a few positions for EVERY visitor. Included
   * in the client's personalization score too. */
  boostScore?: number
}

export interface CategoryCachePayload {
  updatedAt: number
  sourceCount: number
  articleCount: number
  topics: TopicArticle[]
  /** Cache version — used to invalidate ALL caches when the source list
   *  or clustering logic changes. If this doesn't match the current
   *  CACHE_VERSION in news-cache.ts, the cache is treated as stale and
   *  replaced (not merged) on the next refresh. */
  cacheVersion?: number
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

// ---------- Sports topic detection ----------
// Used to DEPRIORITISE sports stories in non-sports categories.
//
// PROBLEM: Sports stories (Premier League, F1, boxing, cricket) often have
// very high coverage (6-9 sources) because every outlet has a sports desk.
// On the Relevant / World / Top tabs they bubble to the top, pushing down
// equally-important non-sports news (wars, elections, science) that has
// fewer sources.
//
// SOLUTION: In every category EXCEPT 'sports', we apply a coverage penalty
// to topics detected as sports. The penalty is large enough to push sports
// stories below non-sports stories of similar coverage, but NOT so large
// that a 10-source sports story disappears entirely — it just ranks below
// a 5-source non-sports story instead of above it.
//
// Detection: keyword scan of title (+summary as backup). The keyword list
// covers team names, leagues, competitions, sports terms, and athletes that
// overwhelmingly indicate a sports story.
const SPORTS_KEYWORDS = [
  // Competitions / leagues (unambiguous)
  'premier league', 'champions league', 'la liga', 'serie a', 'bundesliga',
  'mls', 'nba', 'nfl', 'super bowl', 'nhl', 'stanley cup', 'fa cup',
  'world cup', 'euro 2024', 'euro 2025', 'euro 2026', 'copa america', 'afcon',
  'asian cup', 'wimbledon', 'french open', 'us open tennis', 'australian open',
  'atp finals', 'wta finals', 'fifa', 'uefa', 'rugby world cup', 'six nations',
  'tour de france', 'giro d\'italia', 'ryder cup', 'the masters tournament',
  'pga championship', 'pba', 'ipl', 'the ashes',
  // Sports-specific terms (unambiguous — wouldn't appear in political/business news)
  'kickoff', 'kick-off', 'full-time', 'half-time', 'extra time',
  'penalty shootout', 'penalty kick', 'goalkeeper', 'striker', 'midfielder',
  'winger', 'transfer window', 'transfer fee',
  'pole position', 'grand prix', 'grid position',
  'set point', 'match point', 'break point', 'tiebreak', 'tie-break',
  'innings', 'wicket', 'batsman', 'bowler', 'lbw',
  'penalty try', 'scrum', 'lineout', 'try scorer',
  'title fight', 'title bout', 'weigh-in',
  'birdie', 'eagle', 'bogey', 'tee time', 'fairway', 'putt',
  'semifinal', 'semi-final', 'quarterfinal', 'quarter-final',
  // Teams (high-coverage ones that dominate sports feeds) — full names only
  // to avoid false positives on city names in news.
  'arsenal', 'chelsea', 'liverpool fc', 'man city', 'man united',
  'manchester city', 'manchester united', 'tottenham', 'spurs',
  'newcastle united', 'aston villa', 'west ham', 'brighton ',
  'barcelona', 'real madrid', 'atletico madrid', 'bayern munich', 'dortmund',
  'paris saint-germain', 'juventus', 'inter milan', 'ac milan',
  'napoli', 'roma ', 'lazio', 'sevilla', 'valencia',
  'ajax', 'porto', 'benfica', 'celtic fc', 'rangers fc',
  'lakers', 'celtics', 'warriors', 'knicks', 'bulls', 'nuggets',
  'cowboys', 'chiefs', 'eagles', '49ers', 'bills', 'ravens', 'steelers',
  'packers', 'patriots',
  // Athletes (unambiguous names)
  'verstappen', 'leclerc', 'norris', 'piastri',
  'djokovic', 'alcaraz', 'sinner', 'medvedev', 'zverev',
  'swiatek', 'sabalenka', 'gauff', 'rybakina',
  'joshua', 'fury', 'usyk', 'wildler', 'ngannou', 'prenga',
  'mcilroy', 'scheffler', 'tiger woods',
  'haaland', 'mbappe', 'vinicius', 'bellingham',
  'de bruyne', 'gakpo', 'odegaard',
  'suryavanshi',
]

/**
 * Detect whether a topic is about sports, using its title and summary.
 *
 * Returns true if any sports keyword is found. Used to apply a coverage
 * penalty in non-sports categories so sports stories rank lower.
 */
function isSportsTopic(topic: TopicArticle): boolean {
  const text = `${topic.title} ${topic.summary || ''}`.toLowerCase()
  for (const kw of SPORTS_KEYWORDS) {
    if (text.includes(kw)) return true
  }
  // Backup: if a strong majority of the topic's articles come from sources
  // categorized as 'sports' feeds, treat it as a sports topic. This catches
  // stories that don't have obvious sports keywords (e.g. a transfer rumor
  // phrased generically) but are clearly sports because every source is a
  // sports feed.
  if (topic.articles && topic.articles.length >= 3) {
    const sportsCount = topic.articles.filter((a) => a.category === 'sports').length
    if (sportsCount / topic.articles.length >= 0.6) return true
  }
  return false
}

// ---------- Recency scoring ----------
// Used to boost FRESH stories and decay STALE ones in the ranking.
//
// PROBLEM: Pure coverage-based ranking lets a 36-hour-old 8-source story
// dominate over a 2-hour-old 5-source story. Users see stale news at the
// top instead of the latest developments.
//
// SOLUTION: Add a recency boost/penalty to the sort score:
//   < 3h old:  +15  (breaking — strong boost)
//   < 6h old:  +8   (fresh — moderate boost)
//   < 12h old: +3   (recent — small boost)
//   < 24h old:  0   (neutral)
//   < 36h old: -5   (stale — small penalty)
//   >= 36h:   -15   (very stale — strong penalty)
//
// This is ADDITIVE to the coverage score (coverage*10), so a 12-source
// stale story (120 - 15 = 105) still beats a 5-source fresh story
// (50 + 15 = 65) — coverage remains king. But a 6-source stale story
// (60 - 15 = 45) loses to a 5-source fresh story (50 + 15 = 65), which
// is the desired behaviour: fresh developments surface above yesterday's
// news at similar coverage.
function recencyBoost(topic: TopicArticle): number {
  const ageMs = Date.now() - topic.latestSeen
  const ageH = ageMs / (60 * 60 * 1000)
  if (ageH < 3) return 15
  if (ageH < 6) return 8
  if (ageH < 12) return 3
  if (ageH < 24) return 0
  if (ageH < 36) return -5
  return -15
}

// ---------- Aggregate engagement scoring ----------
// Reads notification-stats from Firebase (keyword → {clicks, likes, dislikes}).
// Topics whose keywords match high-engagement keywords get a boost — this
// is an aggregate popularity signal across ALL users (stories people are
// clicking/liking rank higher).
//
// Cached in-process for 5 minutes to avoid a Firebase read on every call.
interface EngagementStats {
  clicks?: number
  opens?: number
  dismisses?: number
  likes?: number
  dislikes?: number
}
let ENGAGEMENT_CACHE: { ts: number; stats: Record<string, EngagementStats> } | null = null
const ENGAGEMENT_TTL_MS = 5 * 60 * 1000

async function loadEngagementStats(): Promise<Record<string, EngagementStats>> {
  if (ENGAGEMENT_CACHE && Date.now() - ENGAGEMENT_CACHE.ts < ENGAGEMENT_TTL_MS) {
    return ENGAGEMENT_CACHE.stats
  }
  try {
    const stats =
      (await firebaseRead<Record<string, EngagementStats>>('notification-stats')) || {}
    ENGAGEMENT_CACHE = { ts: Date.now(), stats }
    return stats
  } catch {
    return {}
  }
}

/**
 * Compute an engagement boost for a topic based on aggregate click/like
 * stats stored in Firebase (notification-stats).
 *
 * Extracts significant keywords from the title (same logic as the feedback
 * endpoint) and sums (clicks + likes*2 - dislikes*3) across all matched
 * keywords. Returns a boost in the range [-20, +20].
 *
 * A topic that matches keywords users have been clicking/liking gets a
 * positive boost (max +20). A topic matching heavily-disliked keywords
 * gets a penalty (min -20). Topics with no engagement data get 0.
 */
function engagementBoost(
  topic: TopicArticle,
  stats: Record<string, EngagementStats>,
): number {
  if (!stats || Object.keys(stats).length === 0) return 0
  // Extract significant keywords (mirrors /api/notification/feedback logic)
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'from', 'by', 'is', 'was', 'are', 'were', 'be', 'been',
    'this', 'that', 'it', 'its', 'they', 'them', 'their', 'there', 'we',
    'us', 'our', 'you', 'your', 'he', 'she', 'his', 'her', 'not', 'no',
    'has', 'have', 'had', 'will', 'would', 'can', 'could', 'should',
    'about', 'after', 'before', 'during', 'over', 'under', 'up', 'down',
    'out', 'off', 'than', 'too', 'very', 'just', 'also', 'only', 'says',
    'said', 'say', 'new', 'one', 'two', 'amid', 'news', 'report',
  ])
  const keywords = (topic.title + ' ' + (topic.summary || ''))
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 4 && !stopWords.has(w))
    .slice(0, 8)

  let score = 0
  for (const kw of keywords) {
    const s = stats[kw]
    if (!s) continue
    score += (s.clicks || 0) * 1 + (s.likes || 0) * 2 - (s.dislikes || 0) * 3
  }
  // Clamp to [-20, +20] so engagement is a tie-breaker, not a dominator
  return Math.max(-20, Math.min(20, score))
}

// ---------- Post-clustering near-duplicate merge ----------
// After clusterTopics, do a SECOND pass to merge topics that are clearly
// about the same event but were clustered separately (different wording,
// different articles, Jaccard just under the initial 0.22 threshold).
//
// This catches the common "same news, different worded titles" problem:
//   "Berlin Pride attack: Police hunt suspect"
//   "German police hunt fugitive after van ramming at Pride"
// These share 3+ significant keywords (police, hunt, pride) AND have
// Jaccard ~0.30 (high overall similarity).
//
// Merge criteria (STRICTER than initial clustering — requires BOTH):
//   - Jaccard >= 0.15  (meaningful overall title similarity)
//   - Share 3+ significant keywords
// AND within 48h of each other.
//
// Both conditions must hold (AND, not OR). The previous OR-based threshold
// (Jaccard >= 0.12 OR shared >= 2) caused false-positive merges between
// unrelated stories that shared 2 generic news words (e.g. "huge" +
// "hands" merged a Barcola/PSG transfer story with a Gatwick water shortage
// story). With AND, both titles must be genuinely similar overall AND share
// multiple event-specific keywords.
//
// Merging combines articles, recalculates coverage/lean/image, and keeps
// the title with the most keywords (best headline).
function mergeNearDuplicateTopics(topics: TopicArticle[]): TopicArticle[] {
  if (topics.length < 2) return topics

  const kwSets = topics.map((t) => titleKeywords(t.title))
  const merged = new Array(topics.length).fill(false)
  const result: TopicArticle[] = []

  for (let i = 0; i < topics.length; i++) {
    if (merged[i]) continue
    // Collect indices of topics to merge with topic[i]
    const mergeIndices = [i]
    merged[i] = true

    for (let j = i + 1; j < topics.length; j++) {
      if (merged[j]) continue
      // Time window: 48h
      if (Math.abs(topics[i].latestSeen - topics[j].latestSeen) > 48 * 60 * 60 * 1000) continue

      const sim = jaccard(kwSets[i], kwSets[j])
      // Count shared significant keywords
      let shared = 0
      for (const w of kwSets[j]) {
        if (kwSets[i].has(w)) shared++
      }

      // Merge ONLY if BOTH conditions hold:
      //   - Jaccard >= 0.12  (was 0.15 — lowered to catch more same-event stories)
      //   - shared significant keywords >= 3  (at least 3 event-specific words in common)
      //
      // This is STRICTER than the previous OR-based threshold (Jaccard >= 0.12
      // OR shared >= 2), which caused false-positive merges between unrelated
      // stories that happened to share 2 generic news words.
      //
      // With AND, both titles must share 3+ significant keywords AND have a
      // Jaccard similarity >= 0.12. This catches genuine same-event stories
      // with different wording while rejecting unrelated stories.
      if (sim >= 0.12 && shared >= 3) {
        mergeIndices.push(j)
        merged[j] = true
      }
    }

    if (mergeIndices.length === 1) {
      result.push(topics[i])
      continue
    }

    // Merge the cluster into a single topic
    const cluster = mergeIndices.map((idx) => topics[idx])
    const allArticles = cluster.flatMap((t) => t.articles || [])
    // Dedup articles by link
    const seenLinks = new Set<string>()
    const dedupArticles = allArticles.filter((a) => {
      if (seenLinks.has(a.link)) return false
      seenLinks.add(a.link)
      return true
    })

    // Pick the best title (most significant keywords)
    let bestTitleIdx = mergeIndices[0]
    for (const idx of mergeIndices) {
      if (kwSets[idx].size > kwSets[bestTitleIdx].size) {
        bestTitleIdx = idx
      }
    }
    const bestTitle = topics[bestTitleIdx].title
    const bestSummary = topics[bestTitleIdx].summary

    // Pick the best image (highest score)
    let bestImage = cluster[0].imageUrl
    for (const t of cluster) {
      if (t.imageUrl && (!bestImage || scoreImageUrl(t.imageUrl) > scoreImageUrl(bestImage))) {
        bestImage = t.imageUrl
      }
    }

    // Recompute lean counts from deduped articles
    let leanLeft = 0, leanCenter = 0, leanRight = 0
    const seenSourceIds = new Set<string>()
    let firstSeen = cluster[0].firstSeen
    let latestSeen = cluster[0].latestSeen
    for (const a of dedupArticles) {
      if (!seenSourceIds.has(a.sourceId)) {
        seenSourceIds.add(a.sourceId)
        if (a.leaning === 'left') leanLeft++
        else if (a.leaning === 'center') leanCenter++
        else leanRight++
      }
      if (a.iso < firstSeen) firstSeen = a.iso
      if (a.iso > latestSeen) latestSeen = a.iso
    }
    // Sum local coverage from cluster members (best estimate without re-deriving
    // the localSourceIds set, which isn't available in this function)
    const localCoverage = cluster.reduce((sum, t) => sum + (t.localCoverage || 0), 0)

    result.push({
      topicId: hashId(bestTitle + '|' + firstSeen),
      title: bestTitle,
      summary: bestSummary,
      imageUrl: bestImage,
      coverage: dedupArticles.length,
      leanLeft,
      leanCenter,
      leanRight,
      firstSeen,
      latestSeen,
      articles: dedupArticles.sort((a, b) => b.iso - a.iso),
      localCoverage,
    })
  }

  return result
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

/**
 * Safety net: detect stories that are OBVIOUSLY NOT about the given country.
 *
 * The AI sometimes approves US politics stories (Trump, Biden, Congress)
 * because a UK outlet covered them. This function does a final keyword
 * check to strip those out — if the title/summary contains strong US
 * politics keywords AND no UK keywords, it's almost certainly not a UK story.
 *
 * Returns true if the story should be EXCLUDED (it's obviously not about
 * the country).
 */
function isObviouslyNotAboutCountry(
  topic: TopicArticle,
  countryCode: string,
): boolean {
  const cc = countryCode.toUpperCase()
  const text = `${topic.title} ${topic.summary}`.toLowerCase()

  // Strong US politics indicators — if these appear, the story is almost
  // certainly US politics, not UK news.
  const usPoliticsPatterns = [
    'trump says', 'trump claims', 'trump attacks', 'trump threatens',
    'trump praises', 'trump blasts', 'trump lashes', 'trump insists',
    'trump calls', 'trump urges', 'trump defends', 'trump mocks',
    'trump vows', 'trump promises', 'trump tweets', 'trump posts',
    'trump campaign', 'trump re-election', 'trump 2028', 'trump 2024',
    'trump rally', 'trump speech', 'trump address', 'trump executive order',
    'trump signs', 'trump vetoes', 'trump nominates', 'trump appoints',
    'biden says', 'biden claims', 'biden signs', 'biden vetoes',
    'us congress', 'us senate', 'us house of representatives',
    'us supreme court', 'scotus', 'us capitol', 'us state department',
    'us poll', 'us approval rating', 'us election', 'us primary',
    'gop rep', 'gop senator', 'democratic rep', 'democratic senator',
    'us governor', 'us state law', 'us federal',
    'us airstrikes', 'us military', 'us troops', 'us drone',
  ]

  // If the story matches any US politics pattern, check if it ALSO has a
  // UK angle. If yes → keep it (UK politician responded, UK troops involved).
  // If no → exclude it.
  const hasUsPolitics = usPoliticsPatterns.some((p) => text.includes(p))

  if (hasUsPolitics) {
    // Check if there's a UK angle that would redeem it
    const ukKeywords = COUNTRY_KEYWORDS['GB'] || []
    const hasUkAngle = ukKeywords.some((kw) => {
      if (text.includes(kw)) return true
      return false
    })
    if (!hasUkAngle) {
      return true // exclude — it's US politics with no UK angle
    }
  }

  return false // keep — passes the safety net
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

  const systemPrompt = `You are a ${countryName} news editor for NeutralWire. Your job is to decide which stories should appear in the "${countryName} News" section.

INCLUSION RULES (aim for 15-25 stories):
- INCLUDE stories ABOUT ${countryName}: ${countryName} politics, events, people, places, institutions, sport, business, weather, crime, court cases.
- INCLUDE stories about ${countryName} politicians, cities, laws, companies, or cultural events.
- INCLUDE ${countryName} sport (football, cricket, rugby, tennis, F1, etc.).
- INCLUDE stories where ${countryName} people are centrally involved.

EXCLUSION RULES (BE STRICT — these are the most common mistakes):
- EXCLUDE US politics: Trump, Biden, US Congress, US elections, US polls, US Supreme Court, US state laws — even if ${countryName} outlets (BBC, Guardian) covered them. The ONLY exception is if a ${countryName} politician/person is centrally involved.
- EXCLUDE foreign domestic news: a US state law change, a Japanese local election, a French protest — unless ${countryName} is directly involved.
- EXCLUDE generic world news with no ${countryName} connection: Middle East wars (unless UK troops involved), foreign elections, foreign court cases.
- EXCLUDE celebrity/entertainment gossip about foreign celebrities with no ${countryName} angle.
- EXCLUDE foreign sport (NFL, NBA, MLB, foreign football leagues) unless a ${countryName} player/team is involved.

KEY DISTINCTION:
- BBC covering Trump's latest statement → EXCLUDE (foreign politics)
- BBC covering a UK politician's response to Trump → INCLUDE (UK angle)
- "7 moments from Trump's speech" → EXCLUDE (US politics, no UK angle)
- "British families evacuated from wildfires" → INCLUDE (UK people)

RANKING (COVERAGE IS KING):
- Rank PRIMARILY by COVERAGE (number of sources). More sources = higher rank. ALWAYS.
- A story with 10 sources ALWAYS ranks above a story with 3 sources.
- A story with 3 sources ALWAYS ranks above a story with 1 source.
- Recency is ONLY a tie-breaker for stories with the SAME coverage.
- Do NOT rank "importance" above coverage — coverage IS the importance signal.
- Sort: highest coverage first, then most recent for ties.

OUTPUT FORMAT:
- Return ONLY a comma-separated list of story numbers (1-${aiTopics.length}) in ranked order.
- HIGHEST COVERAGE FIRST. Only include stories that pass the inclusion rules.
- Example: 3,1,7,5,12,2,8,15
- No explanation, no other text, JUST the numbers.`

  const userPrompt = `Country: ${countryName}
Stories (with coverage count):
${storyList}

Which story numbers (1-${aiTopics.length}) are ABOUT ${countryName} (exclude US/foreign politics with no ${countryName} angle)? Rank them HIGHEST COVERAGE FIRST. Return as a comma-separated list. ONLY the numbers.`

  try {
    const aiResponse = await callAI({ systemPrompt, userPrompt })

    if (!aiResponse) {
      // AI FAILED — fall back to keyword-based country filtering.
      // Previously this returned ONLY previously-approved topics (default-deny),
      // which meant when the AI was unavailable (no API keys, rate-limited),
      // users saw almost no stories in My Country. Now we use the keyword
      // filter (isTopicAboutCountry) as a fallback — it catches UK-relevant
      // stories using a curated keyword list (UK politicians, cities, NHS,
      // parliament, etc.) and excludes obvious non-UK stories via the
      // safety net (isObviouslyNotAboutCountry). This isn't as smart as the
      // AI but shows real UK news instead of an empty/horrid feed.
      console.warn(`[ai-filter] AI returned no response for ${cc}, falling back to keyword filtering`)
      const keywordFiltered = topics
        .filter((t) => isTopicAboutCountry(t, countryCode))
        .filter((t) => !isObviouslyNotAboutCountry(t, countryCode))
        .sort((a, b) => b.coverage - a.coverage)
      if (keywordFiltered.length > 0) return keywordFiltered
      // Last resort: if keyword filtering returned nothing, return
      // previously-approved topics (if any) so the feed isn't totally empty.
      const approvedSet = previouslyApproved
      const result = topics
        .filter((t) => approvedSet.has(t.topicId))
        .sort((a, b) => b.coverage - a.coverage)
      return result
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
      // AI returned nothing parseable — fall back to keyword filtering.
      console.warn(`[ai-filter] AI returned no valid numbers for ${cc}, falling back to keyword filtering`)
      const keywordFiltered = topics
        .filter((t) => isTopicAboutCountry(t, countryCode))
        .filter((t) => !isObviouslyNotAboutCountry(t, countryCode))
        .sort((a, b) => b.coverage - a.coverage)
      if (keywordFiltered.length > 0) return keywordFiltered
      const approvedSet = previouslyApproved
      return topics
        .filter((t) => approvedSet.has(t.topicId))
        .sort((a, b) => b.coverage - a.coverage)
    }

    // Map numbers back to topics (1-based → 0-based index)
    let rankedTopics: TopicArticle[] = []
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

    // SAFETY NET 1: Remove obvious non-UK stories that the AI let through.
    // The AI sometimes approves US politics stories (Trump, Biden, Congress)
    // because a UK outlet covered them. We do a final keyword check to strip
    // these out — they have NO UK angle in the title/summary.
    const beforeCount = rankedTopics.length
    rankedTopics = rankedTopics.filter((t) => !isObviouslyNotAboutCountry(t, countryCode))
    if (rankedTopics.length < beforeCount) {
      console.warn(`[ai-filter] Safety net removed ${beforeCount - rankedTopics.length} non-${cc} stories the AI let through`)
    }

    // SAFETY NET 2: enforce coverage-descending order regardless of what the
    // AI returned. The AI sometimes ignores the "highest coverage first"
    // instruction and ranks by perceived importance instead. We override
    // that here so the user always sees the broadest-coverage stories first.
    // Tie-break by recency (newer first).
    rankedTopics.sort((a, b) => {
      if (b.coverage !== a.coverage) return b.coverage - a.coverage
      return b.latestSeen - a.latestSeen
    })

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
    // AI threw — fall back to keyword filtering (same as the no-response case).
    console.warn(`[ai-filter] AI failed for ${cc}, falling back to keyword filtering:`, err)
    const keywordFiltered = topics
      .filter((t) => isTopicAboutCountry(t, countryCode))
      .filter((t) => !isObviouslyNotAboutCountry(t, countryCode))
      .sort((a, b) => b.coverage - a.coverage)
    if (keywordFiltered.length > 0) return keywordFiltered
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

    // ── Video extraction (experimental Watch feature) ──
    // Two shapes carry a source video in RSS:
    //   1. <media:content type="video/mp4" url="..." duration="..."> /
    //      <enclosure type="video/..." url="..."> — outlets that publish
    //      video pods. The MRSS duration attribute (seconds) is kept so
    //      the Watch feature can enforce its >10s requirement.
    //   2. The entry LINK itself is a YouTube watch URL — some sources in
    //      the list are YouTube channel feeds, where every entry IS a video.
    const videoMedia =
      extractVideoMedia(block, 'media:content') ||
      extractVideoMedia(block, 'enclosure')
    const videoUrl = videoMedia?.url || (isYouTubeUrl(cleanLink) ? cleanLink : null)
    const videoDuration = videoMedia?.duration ?? null

    // Skip non-English articles.
    // Decode entities FIRST (so &lt;a href&gt; becomes <a href>),
    // then STRIP HTML tags (so <a href='...'>text</a> becomes 'text'),
    // then decode entities AGAIN (in case stripping revealed new entities).
    // Without stripHtml, RSS titles containing escaped HTML like
    // &lt;a href='...'&gt;Police conducting enquiries...&lt;/a&gt; would
    // show up as literal HTML code in the topic title.
    let decodedTitle = decodeEntities(cleanTitle)
    decodedTitle = stripHtml(decodedTitle)
    decodedTitle = decodeEntities(decodedTitle)
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
      videoUrl,
      videoDuration,
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

/** True when the URL points at a YouTube video page (watch/short/youtu.be). */
function isYouTubeUrl(url: string): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '').toLowerCase()
    if (host === 'youtu.be') return u.pathname.length > 1
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      return (
        u.pathname === '/watch' ||
        u.pathname.startsWith('/shorts/') ||
        u.pathname.startsWith('/live/')
      )
    }
    return false
  } catch {
    return /(?:youtube\.com\/watch|youtu\.be\/)/i.test(url)
  }
}

/** A video URL plus its declared MRSS duration (seconds, when present). */
interface ExtractedVideo {
  url: string
  duration: number | null
}

/**
 * Extract a VIDEO url (+ optional duration) from an RSS
 * media:content/enclosure block — same tag-scanning approach as
 * extractAttr(), but type-aware: the tag must declare a video MIME type
 * (type="video/mp4") or point at a video file extension. Returns null
 * for the (common) case where the same tags carry only images.
 */
function extractVideoMedia(block: string, tag: string): ExtractedVideo | null {
  const re = new RegExp(`<${escapeReg(tag)}\b[^>]*>`, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) {
    const tagText = m[0]
    const urlMatch = tagText.match(/\burl\s*=\s*["']([^"']+)["']/i)
    if (!urlMatch) continue
    const url = urlMatch[1]
    const typeMatch = tagText.match(/\btype\s*=\s*["']([^"']+)["']/i)
    const type = typeMatch ? typeMatch[1].toLowerCase() : ''
    const isVideo =
      type.startsWith('video/') ||
      /\.(mp4|m3u8|webm|ogv|mov)(\?|$)/i.test(url) ||
      // YouTube media:content in feeds (yt namespace) points at player
      // URLs.
      isYouTubeUrl(url)
    if (!isVideo) continue
    // MRSS duration attribute is in SECONDS (media:content only in practice).
    const durMatch = tagText.match(/\bduration\s*=\s*["']([\d.]+)["']/i)
    const duration = durMatch ? Math.round(parseFloat(durMatch[1])) : null
    return { url, duration: Number.isFinite(duration as number) ? duration : null }
  }
  return null
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

  // ── srcset parsing: prefer the LARGEST image from srcset ──
  // Many RSS descriptions include an <img> with a srcset attribute listing
  // multiple resolutions (e.g. "img-240.jpg 240w, img-800.jpg 800w, img-1200.jpg 1200w").
  // The old code only grabbed `src` (usually the smallest). We now parse
  // srcset and pick the highest-resolution URL.
  const srcsetMatch = html.match(/<img[^>]+srcset=["']([^"']+)["']/i)
  if (srcsetMatch?.[1]) {
    const srcset = srcsetMatch[1]
    // Parse "url Nw, url Nw, ..." entries
    const entries = srcset.split(',').map((entry) => {
      const parts = entry.trim().split(/\s+/)
      const url = parts[0]
      const widthDescriptor = parts[1] || ''
      const width = parseInt(widthDescriptor, 10) || 0
      return { url, width }
    })
    // Pick the entry with the highest width (fallback to first if no widths)
    const best = entries.sort((a, b) => b.width - a.width)[0]
    // decodeEntities: srcset URLs inside RSS HTML carry &amp; between
    // query params — decode so the proxy fetches the real URL.
    if (best?.url) return decodeEntities(best.url)
  }

  // ── data-src / data-lazy-src: some feeds lazy-load images ──
  const dataSrcMatch = html.match(/<img[^>]+data-src=["']([^"']+)["']/i)
  if (dataSrcMatch?.[1]) return decodeEntities(dataSrcMatch[1])

  // ── Fallback: plain src attribute ──
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i)
  return m ? decodeEntities(m[1]) : null
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

  // Remove leading tags: BREAKING, LIVE, UPDATE, EXCLUSIVE, DEVELOPING,
  // ANALYSIS — and WATCH / VIDEO (the "WATCH:", "WATCH LIVE:" and "Video:"
  // prefixes Sky News, Express, GB News and ABC put on video posts).
  // Looping handles stacked prefixes like "WATCH LIVE: X" (strips WATCH,
  // then LIVE).
  const LEADING_TAGS =
    /^(BREAKING|LIVE|UPDATE|UPDATED|EXCLUSIVE|DEVELOPING|ANALYSIS|JUST IN|REPORT|WATCH|VIDEO)[\s:|-]+/i
  for (let i = 0; i < 3; i++) {
    const next = t.replace(LEADING_TAGS, '')
    if (next === t) break
    t = next
  }

  // Also strip a trailing " - WATCH" / " | WATCH" / " | Video" fragment some
  // outlets use ("Cameron speech - WATCH"). Only the exact word as its OWN
  // final segment — genuine uses ("Apple Watch launches...") never match,
  // and a title that would become too short is restored by the safety net
  // below.
  t = t.replace(/\s*[|\-–]\s*(WATCH|Video|VIDEO)\s*$/i, '')

  // Remove source prefixes: "BBC News - ", "The Guardian - ", "Reuters: "
  t = t.replace(/^(BBC News|The Guardian|Reuters|AP|AFP|CNN|Fox News|NBC News|CBS News|ABC News|NPR|CNBC|New York Times|Washington Post|Financial Times|The Economist|Al Jazeera|France 24|Deutsche Welle|Bloomberg)[\s:|-]+/i, '')

  // Remove trailing live/update tags (SHORT, known tags only — NOT greedy
  // patterns that could eat the rest of the title).
  t = t.replace(/\s*[–-]\s*(live|live updates|live blog|video|analysis|opinion|report|explainer|podcast|poll|quiz|cartoon)\s*$/i, '')

  // Remove trailing " | Source Name" or " - Source Name" — but ONLY when
  // the part after the separator is a SHORT source-name-like fragment
  // (1-3 words, each starting with uppercase, no sentence-ending punctuation).
  // This prevents the regex from eating long descriptive tails of titles.
  // Old regex `[\w\s]+$` was greedy and matched any trailing words, causing
  // titles like "Boris Johnson - Ministers to vote" → "Boris Johnson" (3 words).
  // Now: only match 1-3 words that look like a source name (no lowercase
  // sentence fragments).
  t = t.replace(/\s*[|\-]\s*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s*$/, '')

  // Collapse multiple spaces
  t = t.replace(/\s+/g, ' ').trim()

  // Remove trailing punctuation that looks messy
  t = t.replace(/[,;:\s]+$/, '')

  // SAFETY: if the result is now too short (less than 4 words and the
  // original was longer), the regex above probably ate too much —
  // return the original title instead. This prevents broken 3-word titles.
  const originalWords = wordCount(title)
  const resultWords = wordCount(t)
  if (originalWords > 6 && resultWords < 4) {
    return title.trim()
  }

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
 * Check if a title needs shortening (>15 words OR >140 characters).
 * GDELT titles can be very long, so the character check catches verbose
 * headlines that have few words but many characters.
 */
function titleNeedsShortening(title: string): boolean {
  return wordCount(title) > 15 || title.length > 140
}

/**
 * Shorten long titles using the AI fallback chain.
 *
 * For each topic with >15 words OR >140 characters, calls callAI with a
 * prompt asking for a concise 6-12 word headline that preserves the key
 * facts.
 *
 * Result is cached in Firebase (title-rewrites/<topicId>) and in-process
 * so subsequent loads are instant.
 *
 * Operates IN PLACE on the topics array — modifies topic.title.
 * Runs in parallel for speed (batches of 5 to avoid rate limits).
 *
 * Exported so the GDELT aggregator (gdelt-aggregator.ts) can call it on
 * GDELT-sourced topics too.
 */
export async function shortenLongTitles(topics: TopicArticle[]): Promise<void> {
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

/**
 * Normalize a hostname for the same-publisher check in fetchOgImage:
 * strips common mobile/amp subdomain prefixes so "www.bbc.co.uk" ≡
 * "bbc.co.uk" and "amp.theguardian.com" ≡ "theguardian.com".
 */
function normalizeHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/^(www\.|m\.|mobile\.|amp\.|amp-\d+\.)/, '')
}

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
    // ── REDIRECT GUARD ──
    // If the article URL redirected to a DIFFERENT site (paywall/consent
    // interstitial, syndication partner, link shortener, homepage), the
    // og:image we'd extract belongs to the WRONG page — not the article.
    // This is exactly how a "Tesco storefront" photo once ended up on an
    // unrelated headline. Reject those og:images outright.
    try {
      const askedHost = normalizeHost(new URL(articleUrl).host)
      const finalHost = normalizeHost(new URL(res.url).host)
      if (askedHost !== finalHost) {
        OG_IMAGE_CACHE.set(articleUrl, { ts: Date.now(), url: null })
        return null
      }
    } catch {
      // res.url unparsable — treat as failure rather than trusting a
      // possibly-wrong og:image
      OG_IMAGE_CACHE.set(articleUrl, { ts: Date.now(), url: null })
      return null
    }
    const html = await res.text()
    // Extract og:image or twitter:image meta tag. decodeEntities: meta
    // content attributes are HTML-escaped (&amp; between query params) —
    // decode so the image proxy gets a working URL.
    const ogMatch = html.match(
      /<meta\s+(?:property|name)=["']og:image["']\s+content=["']([^"']+)["']/i,
    )
    if (ogMatch?.[1]) {
      const url = decodeEntities(ogMatch[1].trim())
      OG_IMAGE_CACHE.set(articleUrl, { ts: Date.now(), url })
      return url
    }
    const twMatch = html.match(
      /<meta\s+(?:property|name)=["']twitter:image["']\s+content=["']([^"']+)["']/i,
    )
    if (twMatch?.[1]) {
      const url = decodeEntities(twMatch[1].trim())
      OG_IMAGE_CACHE.set(articleUrl, { ts: Date.now(), url })
      return url
    }
    // Also try og:image:url and og:image:secure_url
    const ogAltMatch = html.match(
      /<meta\s+(?:property|name)=["']og:image:(?:secure_)?url["']\s+content=["']([^"']+)["']/i,
    )
    if (ogAltMatch?.[1]) {
      const url = decodeEntities(ogAltMatch[1].trim())
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
 * Upgrade a low-resolution RSS thumbnail URL to a higher-resolution variant
 * for known publisher URL patterns. Returns the upgraded URL (or the
 * original if no upgrade applies).
 *
 * RSS feeds often include small thumbnails (240px, 140px, 96px). Many
 * publishers use predictable URL patterns where a dimension appears in
 * the path/query — we can swap it for a larger dimension to get a
 * full-resolution image suitable for cards (≥600px).
 *
 * Examples:
 *   BBC:      /ace/standard/240/...  →  /ace/standard/800/...
 *   Guardian: ?width=140             →  ?width=1200
 *   NYT:      -mediumSquareAt3X      →  -articleLarge (or keep, it's 3x)
 *   Independent: /width=1200 (already large, leave alone)
 *   France24: /w:1280/ (already large, leave alone)
 *   Telegraph: keep
 *   CNBC:     ?v=...&w=1920 (already large, leave alone)
 */
function upgradeToHighRes(url: string): string {
  if (!url) return url
  try {
    // BBC: /ace/standard/<N>/cpsprodpb/... → bump N to 800
    // Also /ace/ic/<N>/ and /${N}x${N}/ variants
    if (/ichef\.bbci\.co\.uk\//.test(url)) {
      return url
        .replace(/\/ace\/(?:standard|ic)\/\d+\//, '/ace/standard/800/')
    }
    // Guardian: width=NNN → width=1200
    if (/i\.guim\.co\.uk\//.test(url)) {
      return url.replace(/([?&])width=\d+/, '$1width=1200')
    }
    // NYT: -mediumSquareAt3X.jpg is 3x (good), but -thumbStandard / -small
    // variants are tiny. Upgrade known small variants to -articleLarge.
    if (/static\d?\.nyt\.com\//.test(url)) {
      return url
        .replace(/-thumbStandard\./, '-articleLarge.')
        .replace(/-thumbLarge\./, '-articleLarge.')
        .replace(/-small\./, '-articleLarge.')
        .replace(/-mediumSquareAt3X\./, '-jumbo.') // jumbo is larger than mediumSquareAt3X
    }
    // Al Jazeera: /640/ or /240/ → /1280/
    if (/www\.aljazeera\.com\//.test(url)) {
      return url.replace(/\/(?:240|360|480|640)\//, '/1280/')
    }
    // HuffPost: resize as query param
    if (/media\.cldnry\.s-nbcnews\.com\//.test(url)) {
      return url.replace(/t_nbcnews-fp-\d+x\d+/, 't_nbcnews-fp-1200x630')
    }
    // Japan Times: keep /uploads/ images as-is (already full-res)
    // Reuters/Independent/FT: already large in RSS
    return url
  } catch {
    return url
  }
}

/**
 * Score an image URL by likely resolution quality (higher = better).
 * Used to rank candidate images so we PREFER high-resolution URLs.
 *
 * Heuristics:
 *   - URLs with explicit large dimension hints (width=1200, /1280/, -jumbo)
 *     score highest
 *   - OG images (from article pages) score higher than RSS thumbnails
 *     (detected by typical RSS thumbnail patterns)
 *   - URLs with tiny dimension hints (width=140, /96/, -thumbStandard) score
 *     lowest — we still use them as a last resort but prefer larger ones
 */
function scoreImageUrl(url: string): number {
  if (!url) return 0
  const u = url.toLowerCase()
  let score = 50 // baseline

  // High-res hints (boost)
  if (/width=1[0-9]{3}/.test(u)) score += 40 // width=1200, width=1920
  else if (/width=[7-9]\d{2}/.test(u)) score += 25 // width=800
  else if (/width=[4-6]\d{2}/.test(u)) score += 10 // width=600
  else if (/width=\d{1,3}(?!\d)/.test(u)) score -= 20 // width=140, width=240

  if (/\/(?:1[0-9]{3}|[7-9]\d{2})(?:x(?:1[0-9]{3}|[7-9]\d{2}))?\//.test(u)) score += 35 // /1280/ or /800x800/
  else if (/\/(?:[4-6]\d{2})\//.test(u)) score += 10 // /600/
  else if (/\/(?:[1-3]\d{2})\//.test(u)) score -= 15 // /240/, /140/

  if (/-jumbo\.|-articleLarge\.|-superJumbo\./.test(u)) score += 30
  if (/-mediumSquareAt3X\./.test(u)) score += 20 // 3x retina, decent
  if (/-thumbStandard\.|-thumbLarge\.|-small\./.test(u)) score -= 25

  // Known high-quality OG image hosts
  if (/ichef\.bbci\.co\.uk\/ace\/(?:standard|ic)\/[6-9]\d{2}\//.test(u)) score += 15
  if (/static\d?\.nyt\.com\/images\/.*-(?:jumbo|articleLarge|superJumbo)\./.test(u)) score += 15

  // ── Guardian media URLs are TIME-SIGNED (`s=` param) ──
  // The signature expires hours after the RSS feed is fetched, so every
  // cached i.guim.co.uk URL 401s permanently afterwards (the console 502
  // storms). Penalise them heavily so a cluster with ANY other outlet's
  // image uses that instead; the Guardian photo stays only as a last
  // resort (it works briefly, then falls back to the gradient placeholder).
  if (/i\.guim\.co\.uk\//.test(u)) score -= 45
  if (/media\.guim\.co\.uk\//.test(u)) score -= 45

  return score
}

// ---------- AI image-content verification (the "Tesco fix") ----------
// A candidate image can be fetchable, high-resolution, and STILL be the
// wrong photo — e.g. an og:image grabbed from a page an article URL
// redirected to, or a mismatched RSS enclosure. Score + fetchability
// can't detect that; a vision model can.
//
// For each (image URL, topic title) we ask a vision model "does this
// photo plausibly illustrate this headline?". Verdicts are cached
// in-process AND in Firebase (image-verdicts/<hash>) so repeat refreshes
// never re-pay the AI call.
//
// FAIL-OPEN DESIGN: when no vision provider can answer (missing keys,
// rate limits, unsupported format, timeouts) we KEEP the image — the
// check only ever rejects images the model is CONFIDENT are unrelated.

/** In-process verdict cache: key → verdict (true = ok, false = mismatch). */
const IMAGE_VERDICT_CACHE = new Map<string, boolean>()
const IMAGE_VERDICT_CACHE_TS = new Map<string, number>()
const IMAGE_VERDICT_TTL_MS = 6 * 60 * 60 * 1000

/** Max vision calls per topic — 3 strikes (mismatches) → no image. */
const MAX_VLM_CHECKS_PER_TOPIC = 3

/** Global concurrency limiter — protects AI rate limits when 24 topics
 *  are image-checked in parallel. */
const VLM_CONCURRENCY = 4
let vlmActive = 0
const vlmQueue: Array<() => void> = []

async function withVlmSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (vlmActive >= VLM_CONCURRENCY) {
    await new Promise<void>((resolve) => vlmQueue.push(resolve))
  }
  vlmActive++
  try {
    return await fn()
  } finally {
    vlmActive--
    const next = vlmQueue.shift()
    if (next) next()
  }
}

/**
 * Per-aggregation context: the Firebase verdict map (loaded once) and
 * the new verdicts to persist (patched once at the end). Passed through
 * findImageForTopic so concurrent aggregations never share state.
 */
export interface ImageVerifyContext {
  fbVerdicts: Map<string, number>
  pending: Record<string, number>
}

async function createImageVerifyContext(): Promise<ImageVerifyContext> {
  const fb = await firebaseRead<Record<string, number>>('image-verdicts')
  const map = new Map<string, number>()
  if (fb) {
    for (const [k, v] of Object.entries(fb)) map.set(k, v)
  }
  return { fbVerdicts: map, pending: {} }
}

async function flushImageVerdicts(ctx: ImageVerifyContext): Promise<void> {
  const keys = Object.keys(ctx.pending)
  if (keys.length === 0) return
  try {
    await firebasePatch('image-verdicts', ctx.pending)
    console.log(`[image-verify] persisted ${keys.length} new verdicts to Firebase`)
  } catch {
    // best-effort — verdicts re-verify next run
  }
}

const IMAGE_VERIFY_SYSTEM = `You verify that a news photo matches its headline. Look at the photo and decide whether it plausibly illustrates the given news headline. Reply with exactly one word: YES or NO.`

function imageVerifyPrompt(title: string): string {
  return `Headline: "${title}"

- Reply YES if the photo shows a person, place, object, flag, document or scene plausibly connected to this headline, or a generic news graphic (newspapers, world map, studio backdrop).
- Reply NO only if the photo CLEARLY depicts a different, unrelated subject — for example a supermarket storefront, an unrelated product or advertisement, an unrelated celebrity, or an unrelated sports match — with no plausible connection to the headline.
- If uncertain, reply YES.

Does the photo plausibly illustrate the headline? Reply YES or NO only.`
}

/**
 * Look up a CACHED verdict for (url, title) — memory or the Firebase map
 * loaded for this aggregation. Never calls the AI. Returns undefined when
 * no verdict exists yet.
 */
function lookupVerdict(
  ctx: ImageVerifyContext,
  url: string,
  title: string,
): boolean | undefined {
  const key = hashId(url + '|' + title)
  const ts = IMAGE_VERDICT_CACHE_TS.get(key)
  if (ts !== undefined && Date.now() - ts < IMAGE_VERDICT_TTL_MS) {
    const cached = IMAGE_VERDICT_CACHE.get(key)
    if (cached !== undefined) return cached
  }
  const fb = ctx.fbVerdicts.get(key)
  if (fb === 1) return true
  if (fb === 0) return false
  return undefined
}

/**
 * Verify that an image's CONTENT plausibly matches a topic title.
 * Returns:
 *   true  → matches (keep the image)
 *   false → the vision model confidently says it's unrelated (skip it)
 *   null  → couldn't verify (no provider answered) — caller should fail open
 */
async function verifyImageContent(
  ctx: ImageVerifyContext,
  url: string,
  title: string,
): Promise<boolean | null> {
  const key = hashId(url + '|' + title)

  // 1. In-process cache
  const ts = IMAGE_VERDICT_CACHE_TS.get(key)
  if (ts !== undefined && Date.now() - ts < IMAGE_VERDICT_TTL_MS) {
    const cached = IMAGE_VERDICT_CACHE.get(key)
    if (cached !== undefined) return cached
  }

  // 2. Firebase verdict map (loaded for this aggregation)
  const fb = ctx.fbVerdicts.get(key)
  if (fb === 1 || fb === 0) {
    const verdict = fb === 1
    IMAGE_VERDICT_CACHE.set(key, verdict)
    IMAGE_VERDICT_CACHE_TS.set(key, Date.now())
    return verdict
  }

  // 3. Ask a vision model
  let answer: string | null = null
  try {
    answer = await withVlmSlot(() =>
      callVisionAI(IMAGE_VERIFY_SYSTEM, imageVerifyPrompt(title), url),
    )
  } catch {
    answer = null
  }
  if (!answer) return null

  const m = answer.match(/\b(yes|no)\b/i)
  if (!m) return null
  const verdict = m[1].toLowerCase() === 'yes'

  // Cache in-process + queue for Firebase persistence
  IMAGE_VERDICT_CACHE.set(key, verdict)
  IMAGE_VERDICT_CACHE_TS.set(key, Date.now())
  ctx.fbVerdicts.set(key, verdict ? 1 : 0)
  ctx.pending[key] = verdict ? 1 : 0
  return verdict
}

/**
 * For a topic, find the best HIGHEST-QUALITY image URL that works.
 *
 * Strategy (v3 — quality + CONTENT relevance):
 * 1. Collect candidates from BOTH sources in parallel:
 *    a. OG images from article pages (typically 1200px+, full-resolution)
 *    b. RSS-provided image URLs (often small thumbnails 140-240px)
 * 2. Upgrade every RSS candidate via upgradeToHighRes() — swaps low-res
 *    dimension hints (width=140, /240/) for high-res ones (width=1200, /800/)
 *    on known publisher URL patterns (BBC, Guardian, NYT, Al Jazeera, ...).
 * 3. Score every candidate via scoreImageUrl() — higher score = likely
 *    higher resolution. Sort candidates by score DESC so we validate the
 *    highest-quality ones first.
 * 4. Validate each candidate (in quality order) with a GET request.
 * 5. NEW: verify each fetchable candidate's CONTENT against the topic
 *    title with a vision model (verifyImageContent). A candidate that
 *    the model confidently says is unrelated (the "Tesco storefront on
 *    a Netanyahu story" glitch) is skipped; the next-best candidate is
 *    tried. After MAX_VLM_CHECKS_PER_TOPIC confident mismatches we give
 *    up and return null — no image is better than a wrong image. When
 *    no vision provider answers, we fail OPEN (accept the image).
 *
 * Tries up to `maxAttempts` articles for OG images.
 */
async function findImageForTopic(
  topic: TopicArticle,
  maxAttempts = 5,
  verifyCtx?: ImageVerifyContext,
): Promise<string | null> {
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

  // ── Collect ALL candidates in parallel: OG images + RSS images ──
  // Fetch OG from up to maxAttempts articles. RSS images we already have
  // (no fetch needed) — collect from the topic + all articles, then
  // upgrade each to a high-res variant.
  const ogFetchPromises = sorted.slice(0, maxAttempts).map(async (a) => {
    try {
      return await fetchOgImage(a.link)
    } catch {
      return null
    }
  })

  const rssCandidates: string[] = []
  if (topic.imageUrl) rssCandidates.push(topic.imageUrl)
  for (const a of topic.articles) {
    if (a.imageUrl) rssCandidates.push(a.imageUrl)
  }
  // Upgrade each RSS candidate to high-res + dedup
  const upgradedRss = Array.from(
    new Set(rssCandidates.map((u) => upgradeToHighRes(u)).filter(Boolean)),
  )

  const ogResults = await Promise.all(ogFetchPromises)
  // Also upgrade OG image URLs to high-res (some publishers return small
  // OG thumbnails, e.g. BBC's og:image sometimes points to /ace/standard/240/)
  const ogCandidates = ogResults
    .filter((u): u is string => !!u)
    .map((u) => upgradeToHighRes(u))

  // ── Combine + score + sort (highest quality first) ──
  const allCandidates = Array.from(new Set([...ogCandidates, ...upgradedRss]))
  const scored = allCandidates
    .map((url) => ({ url, score: scoreImageUrl(url) }))
    .sort((a, b) => b.score - a.score)

  // ── Validate in quality order — return first working + relevant URL ──
  // For each candidate (highest quality first):
  //   1. Skip if not fetchable (existing validateImageUrl).
  //   2. If we have a cached verdict for (url, title): use it (no AI call).
  //   3. Otherwise ask the vision model (budget: MAX_VLM_CHECKS_PER_TOPIC).
  //      - match    → return this URL
  //      - mismatch → skip to the next candidate
  //      - no answer→ fail OPEN: return this URL (an unverifiable image is
  //                   better than no image)
  // After the budget is exhausted, if we've already seen confident
  // mismatches, give up (null) — the feed's images for this story are
  // systematically wrong, so show no image rather than a wrong one.
  let checksUsed = 0
  let mismatches = 0
  for (const { url } of scored) {
    if (!(await validateImageUrl(url))) continue

    if (verifyCtx) {
      // Cached verdicts (memory + Firebase map) cost nothing — always consult
      const cached = lookupVerdict(verifyCtx, url, topic.title)
      if (cached !== undefined) {
        if (cached === true) return url
        mismatches++
        continue
      }

      if (checksUsed >= MAX_VLM_CHECKS_PER_TOPIC) {
        // Vision budget exhausted for this topic
        if (mismatches > 0) return null // everything we checked was wrong
        return url // nothing verifiable found — fail open
      }

      checksUsed++
      const verdict = await verifyImageContent(verifyCtx, url, topic.title)
      if (verdict === null) return url // unverifiable — fail open
      if (verdict === true) return url
      mismatches++
    } else {
      // No verification context (legacy callers) — old behaviour
      return url
    }
  }

  // Every candidate was either unfetchable or confidently mismatched —
  // null either way (no image beats a wrong image).
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

  const JACCARD_THRESHOLD = 0.15 // was 0.18 — lowered to catch more same-event stories
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

      // Pick the HIGHEST-QUALITY image across all articles in the cluster
      if (a.imageUrl) {
        const upgraded = upgradeToHighRes(a.imageUrl)
        if (!bestImage) {
          bestImage = upgraded
        } else {
          if (scoreImageUrl(upgraded) > scoreImageUrl(bestImage)) {
            bestImage = upgraded
          }
        }
      }
      if (a.iso < firstSeen) firstSeen = a.iso
      if (a.iso > latestSeen) latestSeen = a.iso
    }

    // ── Title selection: prefer BBC → center → best quality ──
    // Picks a title that is neither too short (broken/truncated) nor too
    // long (verbose). Prefers titles with 5-20 words.
    // 1. If BBC has an article in this cluster, use BBC's title (if >=5 words)
    // 2. Otherwise, pick the best-length title from CENTER-leaning outlets
    // 3. If no center titles, pick the best-length title from ANY outlet
    // 4. Fallback: use the first article's title
    {
      const clusterArtcls = clusterArticles
      // Helper: score a title by length quality. Prefers 5-20 words.
      const titleScore = (s: string): number => {
        const wc = wordCount(s)
        if (wc < 3) return -100 // too short (broken/truncated)
        if (wc < 5) return -10  // short — deprioritize
        if (wc <= 20) return 100 - Math.abs(wc - 10) * 2 // ideal range
        return 50 // long but usable
      }
      // Step 1: BBC (if its title is good quality)
      const bbcArticle = clusterArtcls.find((a) => a.sourceId === 'bbc')
      if (bbcArticle && bbcArticle.title.length > 10 && titleScore(bbcArticle.title) > 0) {
        bestTitle = bbcArticle.title
        bestSummary = bbcArticle.description
      } else {
        // Step 2: best center title by score
        const centerTitles = clusterArtcls
          .filter((a) => a.leaning === 'center' && a.title.length > 10)
          .sort((a, b) => titleScore(b.title) - titleScore(a.title))
        if (centerTitles.length > 0 && titleScore(centerTitles[0].title) > 0) {
          bestTitle = centerTitles[0].title
          bestSummary = centerTitles[0].description
        } else {
          // Step 3: best any title by score
          const anyTitles = clusterArtcls
            .filter((a) => a.title.length > 10)
            .sort((a, b) => titleScore(b.title) - titleScore(a.title))
          if (anyTitles.length > 0) {
            bestTitle = anyTitles[0].title
            bestSummary = anyTitles[0].description
          }
          // Step 4: fallback — bestTitle already set to first article's title
        }
      }
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
  // Reduced from 18s to 12s — with 100+ feeds, 18s was causing the cron
  // refresh to hit 28-30s (cron-job.org times out at 30s). 12s is enough
  // for all fast feeds; slow feeds just get skipped (cached fallback).
  const ac = new AbortController()
  const timeout = setTimeout(() => ac.abort(), 12000)

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

    // Cluster articles into topics, then run a SECOND merge pass to catch
    // near-duplicates that slipped through the initial clustering (same
    // event, different worded titles). See mergeNearDuplicateTopics().
    const clustered = clusterTopics(fresh, (isRelevantMode || isMyCountryMode) ? localSet : new Set())
    const topics = mergeNearDuplicateTopics(clustered)

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
    if (isSportsMode) {
      // Sports tab: AI already ranked — just filter + slice, preserve AI order.
      // No sports penalty here — this IS the sports tab.
      filtered = relevantTopics
        .filter((t) => t.coverage >= minCoverage)
        .slice(0, limit)
    } else if (isMyCountryMode) {
      // My Country: AI already ranked, BUT we still apply the sports penalty
      // (re-sort by effective coverage + recency). Sports stories dominate UK
      // feeds (every outlet has a sports desk) and would otherwise push down
      // non-sports UK news. The AI ranking is preserved as a tie-breaker via
      // stable sort.
      const SPORTS_PENALTY = 4
      const hasNonSports = relevantTopics.some((t) => !isSportsTopic(t))
      const applySportsPenalty = hasNonSports
      const effectiveCoverage = (t: TopicArticle): number => {
        if (!applySportsPenalty) return t.coverage
        return isSportsTopic(t) ? Math.max(0, t.coverage - SPORTS_PENALTY) : t.coverage
      }
      const engStats = await loadEngagementStats()
      filtered = relevantTopics
        .filter((t) => t.coverage >= minCoverage)
        .sort((a, b) => {
          const ea = effectiveCoverage(a)
          const eb = effectiveCoverage(b)
          const scoreA = ea * 10 + recencyBoost(a) + engagementBoost(a, engStats)
          const scoreB = eb * 10 + recencyBoost(b) + engagementBoost(b, engStats)
          if (scoreB !== scoreA) return scoreB - scoreA
          return b.latestSeen - a.latestSeen
        })
        .slice(0, limit)
    } else {
      // ── Sports deprioritisation in non-sports categories ──
      // Sports stories (Premier League, F1, boxing) often have very high
      // coverage because every outlet has a sports desk — they bubble to
      // the top of Relevant/World/Top tabs, pushing down equally-important
      // non-sports news (wars, elections, science) with fewer sources.
      //
      // We apply a coverage penalty to sports topics so they rank lower.
      // The penalty treats a sports story as if it had ~4 fewer sources:
      //   effectiveCoverage = coverage - 4 (min 0)
      // This means a 7-source sports story (effective 3) ranks BELOW a
      // 5-source non-sports story (effective 5), but ABOVE a 2-source
      // non-sports story. Sports stories still appear, just further down.
      //
      // The penalty ONLY applies when there are non-sports stories to
      // show — if a category is dominated by sports (rare for non-sports
      // tabs), we don't want to show an empty feed.
      const SPORTS_PENALTY = 4
      const hasNonSports = relevantTopics.some((t) => !isSportsTopic(t))
      const applySportsPenalty = hasNonSports

      const effectiveCoverage = (t: TopicArticle): number => {
        if (!applySportsPenalty) return t.coverage
        return isSportsTopic(t) ? Math.max(0, t.coverage - SPORTS_PENALTY) : t.coverage
      }

      // ── Load aggregate engagement stats (cached 5 min) ──
      // Topics matching keywords users are clicking/liking get a boost;
      // topics matching disliked keywords get a penalty. Range [-20, +20].
      const engStats = await loadEngagementStats()

      filtered = relevantTopics
        .filter((t) => t.coverage >= minCoverage)
        .sort((a, b) => {
          // ── Relevant mode: local boost + recency + engagement ──
          if (isRelevantMode) {
            const la = a.localCoverage ?? 0
            const lb = b.localCoverage ?? 0
            const ea = effectiveCoverage(a)
            const eb = effectiveCoverage(b)
            const scoreA = ea * 10 + la * 5 + (la > 0 ? 30 : 0) + recencyBoost(a) + engagementBoost(a, engStats)
            const scoreB = eb * 10 + lb * 5 + (lb > 0 ? 30 : 0) + recencyBoost(b) + engagementBoost(b, engStats)
            if (scoreB !== scoreA) return scoreB - scoreA
            return b.latestSeen - a.latestSeen
          }
          // ── Other categories: coverage + recency + engagement ──
          const ea = effectiveCoverage(a)
          const eb = effectiveCoverage(b)
          const scoreA = ea * 10 + recencyBoost(a) + engagementBoost(a, engStats)
          const scoreB = eb * 10 + recencyBoost(b) + engagementBoost(b, engStats)
          if (scoreB !== scoreA) return scoreB - scoreA
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

    // ── Image validation + fallback + CONTENT verification ──
    // Validate + upgrade + AI-verify images for the TOP 24 topics (every
    // topic that gets returned to clients — not just the top 15) so all
    // displayed stories have a working, high-resolution, TOPIC-RELEVANT
    // image. Each topic tries:
    //   - OG images from up to 5 articles (redirect-guarded — see fetchOgImage)
    //   - Upgraded RSS thumbnails (width=140 → width=1200, etc.)
    //   - Scored + sorted by likely resolution (highest first)
    //   - NEW: content-verified against the headline by a vision model;
    //     confidently-unrelated images are skipped (the "Tesco fix").
    //     Verdicts cached in Firebase (image-verdicts) so repeat refreshes
    //     cost zero AI calls.
    // Runs in parallel for speed; VLM calls are globally throttled.
    const verifyCtx = await createImageVerifyContext()
    const topicsForImageCheck = filtered.slice(0, 24)
    await Promise.all(
      topicsForImageCheck.map(async (topic) => {
        const img = await findImageForTopic(topic, 5, verifyCtx)
        if (img) topic.imageUrl = img
        else topic.imageUrl = null // ensure broken URLs are cleared
      }),
    )
    // Persist any new AI verdicts (single patch) for future refreshes
    await flushImageVerdicts(verifyCtx)

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
