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

    const topics = clusterTopics(fresh, (isRelevantMode || isMyCountryMode) ? localSet : new Set())

    // For `mycountry` mode: filter by CONTENT, not just by source.
    //
    // OLD BEHAVIOUR (broken): showed any story where all sources were UK-based.
    //   → BBC/Guardian cover Trump all day → Trump showed up in "My Country".
    //
    // NEW BEHAVIOUR: a story must be ABOUT the visitor's country (detected
    //   via title/summary keywords like "starmer", "nhs", "premier league")
    //   to appear in "My Country". Source origin is no longer the primary
    //   filter — content is.
    //
    // We still prefer local sources (a story from BBC about UK politics is
    // more likely to be UK-relevant than the same story from NYT), but the
    // CONTENT check is the gatekeeper. This means:
    //   ✅ "Starmer addresses parliament" from BBC → shown
    //   ✅ "Starmer addresses parliament" from NYT → shown (content is UK)
    //   ❌ "Trump signs executive order" from BBC → filtered out
    //   ❌ "Trump signs executive order" from NYT → filtered out
    const relevantTopics = isMyCountryMode && countryCode
      ? topics.filter((t) => isTopicAboutCountry(t, countryCode))
      : topics

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
    const filtered = relevantTopics
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
        // For mycountry mode, sort by local coverage first (most local = top)
        if (isMyCountryMode) {
          const la = a.localCoverage ?? 0
          const lb = b.localCoverage ?? 0
          if (lb !== la) return lb - la
          return b.latestSeen - a.latestSeen
        }
        if (b.coverage !== a.coverage) return b.coverage - a.coverage
        return b.latestSeen - a.latestSeen
      })
      .slice(0, limit)

    // Image validation + fallback: for the top N topics, validate that the
    // existing imageUrl actually works (many CDNs return 401/403). If it
    // doesn't, or if there's no image, try to find a working one from the
    // article images or OG images.
    //
    // This runs in parallel for the top 10 topics to keep it fast.
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
