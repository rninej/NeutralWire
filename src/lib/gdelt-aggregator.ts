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

// ── Country config (per the spec) ──
// Each country has: name, UI code, GDELT sourcecountry candidates,
// strong terms (+3), weak terms (+2), and false-positive blocklist (-2).
interface CountryConfig {
  name: string
  code: string
  gdeltSourceCountries: string[]
  strongTerms: string[]
  weakTerms: string[]
  blocklist: string[]
  /**
   * If true, try sourcecountry:<Country> FIRST (before strong-terms).
   * Use this for countries with many English-language domestic outlets
   * that GDELT indexes well (India, Hong Kong, Singapore, etc.). The
   * strong-terms OR query can be rejected by GDELT for these countries
   * because the terms match too many articles globally.
   *
   * UK and US leave this false — their strong-terms queries work well
   * and give better relevance filtering.
   */
  preferSourceCountry?: boolean
}

const COUNTRY_CONFIG: Record<string, CountryConfig> = {
  GB: {
    name: 'United Kingdom',
    code: 'GB',
    gdeltSourceCountries: ['UK', 'GB'],
    strongTerms: ['united kingdom', 'great britain', 'britain', 'england', 'scotland', 'wales', 'northern ireland'],
    weakTerms: ['uk', 'u.k.', 'london', 'manchester', 'birmingham', 'edinburgh', 'cardiff', 'belfast',
      'glasgow', 'leeds', 'liverpool', 'bristol', 'sheffield', 'newcastle', 'oxford', 'cambridge',
      'parliament', 'westminster', 'downing street', 'nhs', 'starmer', 'burnham', 'labour', 'conservative',
      'tories', 'met police', 'heathrow', 'gatwick', 'council tax', 'bbc'],
    blocklist: ['london ontario', 'university of kentucky', 'uk football', 'new london', 'london ohio'],
  },
  US: {
    name: 'United States',
    code: 'US',
    gdeltSourceCountries: ['US'],
    strongTerms: ['united states', 'america', 'american'],
    weakTerms: ['us', 'u.s.', 'washington', 'white house', 'capitol', 'congress', 'senate', 'pentagon',
      'new york', 'los angeles', 'chicago', 'houston', 'phoenix', 'trump', 'biden', 'fbi', 'cia'],
    blocklist: ['us weekly', 'us news'],
  },
  FR: {
    name: 'France',
    code: 'FR',
    gdeltSourceCountries: ['FR'],
    strongTerms: ['france', 'french'],
    weakTerms: ['paris', 'lyon', 'marseille', 'macron', 'elysee', 'national assembly'],
    blocklist: ['paris texas', 'paris hilton'],
  },
  DE: {
    name: 'Germany',
    code: 'DE',
    gdeltSourceCountries: ['DE'],
    strongTerms: ['germany', 'german'],
    weakTerms: ['berlin', 'munich', 'hamburg', 'merz', 'bundestag', 'frankfurt'],
    blocklist: ['german shepherd', 'german measles'],
  },
  JP: {
    name: 'Japan',
    code: 'JP',
    gdeltSourceCountries: ['JP'],
    strongTerms: ['japan', 'japanese'],
    weakTerms: ['tokyo', 'osaka', 'kyoto', 'diet', 'prime minister kishida', 'abe'],
    blocklist: ['japan airlines', 'japan cup'],
  },
  AU: {
    name: 'Australia',
    code: 'AU',
    gdeltSourceCountries: ['AU'],
    strongTerms: ['australia', 'australian'],
    weakTerms: ['canberra', 'sydney', 'melbourne', 'brisbane', 'perth', 'parliament house'],
    blocklist: ['australian shepherd', 'australian open'],
  },
  CA: {
    name: 'Canada',
    code: 'CA',
    gdeltSourceCountries: ['CA'],
    strongTerms: ['canada', 'canadian'],
    weakTerms: ['ottawa', 'toronto', 'vancouver', 'montreal', 'parliament hill', 'trudeau'],
    blocklist: ['canada goose', 'canada dry'],
  },
  IE: {
    name: 'Ireland',
    code: 'IE',
    gdeltSourceCountries: ['IE'],
    strongTerms: ['ireland', 'irish'],
    weakTerms: ['dublin', 'cork', 'galway', 'dail', 'taoiseach', 'leo varadkar'],
    blocklist: ['irish setter', 'irish coffee'],
  },
  IN: {
    name: 'India',
    code: 'IN',
    gdeltSourceCountries: ['IN'],
    strongTerms: ['india', 'indian', 'modi', 'delhi', 'mumbai', 'bengaluru', 'chennai'],
    weakTerms: ['kolkata', 'hyderabad', 'pune', 'ahmedabad', 'jaipur', 'lucknow',
      'bhopal', 'patna', 'surat', 'kanpur', 'nagpur', 'indore', 'thane',
      'lok sabha', 'rajya sabha', 'parliament', 'bharatiya janata', 'bjp',
      'congress', 'rahul gandhi', 'narendra modi', 'amit shah', 'rashtriya',
      'supreme court of india', 'reserve bank of india', 'rbi', 'isro',
      'uttar pradesh', 'maharashtra', 'karnataka', 'tamil nadu', 'kerala',
      'west bengal', 'gujarat', 'rajasthan', 'punjab', 'haryana', 'madhya pradesh',
      'bihar', 'andhra pradesh', 'telangana', 'odisha', 'assam', 'jammu',
      'kashmir', 'bollywood', 'tata', 'reliance', 'adani', 'infosys', 'wipro',
      'hindu', 'sikh', 'muslim', 'jaish', 'lashkar', 'naxal'],
    blocklist: ['indiana', 'indianapolis', 'indian ocean', 'west indian'],
    // India has many English-language domestic outlets that GDELT indexes
    // well (Times of India, Hindustan Times, Indian Express, NDTV, etc.).
    // sourcecountry:India is more reliable than the strong-terms OR query,
    // which GDELT sometimes rejects because "india" matches too many
    // articles globally.
    preferSourceCountry: true,
  },
  HK: {
    name: 'Hong Kong',
    code: 'HK',
    gdeltSourceCountries: ['HK'],
    strongTerms: ['hong kong', 'hongkong'],
    weakTerms: ['hong kong', 'hongkong', 'carrie lam', 'john lee',
      'legco', 'legislative council', 'basic law', 'one country two systems',
      'central', 'mong kok', 'causeway bay', 'kowloon', 'new territories',
      'hksi', 'hang seng'],
    blocklist: ['hong kong disneyland'],
    preferSourceCountry: true,
  },
  SG: {
    name: 'Singapore',
    code: 'SG',
    gdeltSourceCountries: ['SG'],
    strongTerms: ['singapore', 'singaporean'],
    weakTerms: ['lee hsien loong', 'lawrence wong', 'pap', 'people\u2019s action party',
      'parliament of singapore', 'istana', 'marina bay', 'sentosa', 'changi',
      'jurong', 'woodlands', 'temasek', 'gic', 'mas', 'sbs transit', 'smrt',
      'singapore airlines'],
    blocklist: ['singapore airlines flight'],
    preferSourceCountry: true,
  },
  NZ: {
    name: 'New Zealand',
    code: 'NZ',
    gdeltSourceCountries: ['NZ'],
    strongTerms: ['new zealand', 'kiwi', 'wellington', 'auckland'],
    weakTerms: ['christchurch', 'hamilton', 'dunedin', 'tauranga', 'napier',
      'parliament of new zealand', 'jacinda', 'chris hipkins', 'christopher luxon',
      'national party', 'labour party', 'aotearoa', 'treasury nz'],
    blocklist: ['kiwi shoe polish', 'kiwi bird'],
  },
  ES: {
    name: 'Spain',
    code: 'ES',
    gdeltSourceCountries: ['ES'],
    strongTerms: ['spain', 'spanish', 'madrid'],
    weakTerms: ['barcelona', 'seville', 'valencia', 'zaragoza', 'malaga',
      'sanchez', 'pedro sanchez', 'cortes generales', 'congreso', 'senado',
      'partido popular', 'psoe', 'vox', 'catalonia', 'catalan', 'basque'],
    blocklist: ['spanish flu', 'spanish moss'],
  },
  IT: {
    name: 'Italy',
    code: 'IT',
    gdeltSourceCountries: ['IT'],
    strongTerms: ['italy', 'italian', 'rome'],
    weakTerms: ['milan', 'naples', 'turin', 'florence', 'bologna', 'venice',
      'meloni', 'giorgia meloni', 'parlamento', 'camera', 'senato',
      'forza italia', 'lega', 'partito democratico', 'vatican', 'pope'],
    blocklist: ['italian dressing', 'italian greyhound'],
  },
  NL: {
    name: 'Netherlands',
    code: 'NL',
    gdeltSourceCountries: ['NL'],
    strongTerms: ['netherlands', 'dutch', 'amsterdam'],
    weakTerms: ['the hague', 'rotterdam', 'utrecht', 'eindhoven', 'tilders',
      'rutte', 'mark rutte', 'staten-generaal', 'tweede kamer', 'eerste kamer',
      'pvv', 'vvd', 'd66', 'amstelveen'],
    blocklist: ['dutch oven', 'dutch bros'],
  },
  BR: {
    name: 'Brazil',
    code: 'BR',
    gdeltSourceCountries: ['BR'],
    strongTerms: ['brazil', 'brazilian'],
    weakTerms: ['brasilia', 'sao paulo', 'rio de janeiro', 'salvador',
      'fortaleza', 'lula', 'partido dos trabalhadores', 'congresso',
      'senado', 'camara', 'stf', 'supremo', 'bolsonaro'],
    blocklist: ['brazil nuts', 'brazilian wax'],
  },
  ZA: {
    name: 'South Africa',
    code: 'ZA',
    gdeltSourceCountries: ['ZA'],
    strongTerms: ['south africa', 'south african'],
    weakTerms: ['pretoria', 'cape town', 'johannesburg', 'durban', 'bloemfontein',
      'anc', 'eff', 'parliament of south africa', 'ramaphosa',
      'cyril ramaphosa', 'zuma', 'jacob zuma'],
    blocklist: ['south african airways'],
  },
  NG: {
    name: 'Nigeria',
    code: 'NG',
    gdeltSourceCountries: ['NG'],
    strongTerms: ['nigeria', 'nigerian'],
    weakTerms: ['lagos', 'abuja', 'kano', 'ibadan', 'port harcourt', 'benin city',
      'national assembly', 'tinubu', 'bola tinubu', 'apc', 'pdp', 'naira'],
    blocklist: ['nigerian dwarf'],
  },
  AE: {
    name: 'United Arab Emirates',
    code: 'AE',
    gdeltSourceCountries: ['AE'],
    strongTerms: ['united arab emirates', 'uae', 'emirati'],
    weakTerms: ['dubai', 'abu dhabi', 'sharjah', 'ajman', 'ras al khaimah',
      'fujairah', 'umm al quwain', 'mohammed bin rashid', 'mbz',
      'emirates news agency'],
    blocklist: ['uae football'],
  },
  SA: {
    name: 'Saudi Arabia',
    code: 'SA',
    gdeltSourceCountries: ['SA'],
    strongTerms: ['saudi arabia', 'saudi'],
    weakTerms: ['riyadh', 'jeddah', 'mecca', 'medina', 'dammam', 'mbs',
      'mohammed bin salman', 'salman', 'shura council', 'aramco'],
    blocklist: ['saudi arabian airlines'],
  },
  PK: {
    name: 'Pakistan',
    code: 'PK',
    gdeltSourceCountries: ['PK'],
    strongTerms: ['pakistan', 'pakistani'],
    weakTerms: ['islamabad', 'karachi', 'lahore', 'peshawar', 'quetta',
      'multan', 'faisalabad', 'rawalpindi', 'national assembly',
      'shehbaz sharif', 'imran khan', 'pti', 'pml-n', 'ppp'],
    blocklist: ['pakistani mango'],
  },
  BD: {
    name: 'Bangladesh',
    code: 'BD',
    gdeltSourceCountries: ['BD'],
    strongTerms: ['bangladesh', 'bangladeshi'],
    weakTerms: ['dhaka', 'chittagong', 'khulna', 'rajshahi', 'sylhet',
      'jatiya sangsad', 'hasina', 'sheikh hasina', 'yunus', 'muhammad yunus',
      'awami league', 'bnp'],
    blocklist: ['bangladesh tiger'],
  },
}

// ISO country code → GDELT sourcecountry filter value (for backward compat)
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
  IN: [
    'india', 'indian', 'delhi', 'new delhi', 'mumbai', 'bombay', 'bengaluru',
    'bangalore', 'chennai', 'madras', 'kolkata', 'calcutta', 'hyderabad',
    'pune', 'ahmedabad', 'jaipur', 'lucknow', 'modi', 'narendra modi',
    'amit shah', 'rahul gandhi', 'bjp', 'congress', 'lok sabha', 'rajya sabha',
    'parliament', 'supreme court of india', 'reserve bank of india', 'rbi',
    'isro', 'uttar pradesh', 'maharashtra', 'karnataka', 'tamil nadu', 'kerala',
    'west bengal', 'gujarat', 'rajasthan', 'punjab', 'haryana', 'madhya pradesh',
    'bihar', 'telangana', 'jammu', 'kashmir', 'bollywood', 'tata', 'reliance',
    'adani', 'infosys', 'wipro', 'hindu', 'sikh', 'naxal', 'jaish', 'lashkar',
    'narendra', 'hindenburg',
  ],
  HK: ['hong kong', 'hongkong', 'carrie lam', 'john lee', 'legco',
    'legislative council', 'basic law', 'mong kok', 'causeway bay', 'kowloon',
    'new territories', 'hang seng'],
  SG: ['singapore', 'singaporean', 'lee hsien loong', 'lawrence wong', 'pap',
    'people\u2019s action party', 'istana', 'marina bay', 'sentosa', 'changi',
    'jurong', 'temasek', 'smrt'],
  NZ: ['new zealand', 'kiwi', 'wellington', 'auckland', 'christchurch',
    'hamilton', 'jacinda', 'chris hipkins', 'christopher luxon', 'aotearoa'],
  FR: ['france', 'french', 'paris', 'lyon', 'marseille', 'macron',
    'elysee', 'national assembly'],
  DE: ['germany', 'german', 'berlin', 'munich', 'hamburg', 'merz', 'bundestag',
    'frankfurt'],
  JP: ['japan', 'japanese', 'tokyo', 'osaka', 'kyoto', 'diet', 'abe', 'kishida'],
  AU: ['australia', 'australian', 'canberra', 'sydney', 'melbourne', 'brisbane',
    'perth', 'parliament house'],
  CA: ['canada', 'canadian', 'ottawa', 'toronto', 'vancouver', 'montreal',
    'parliament hill', 'trudeau'],
  IE: ['ireland', 'irish', 'dublin', 'cork', 'galway', 'dail', 'taoiseach'],
  ES: ['spain', 'spanish', 'madrid', 'barcelona', 'seville', 'valencia',
    'sanchez', 'cortes generales', 'catalonia', 'catalan'],
  IT: ['italy', 'italian', 'rome', 'milan', 'naples', 'turin', 'florence',
    'meloni', 'parlamento', 'vatican', 'pope'],
  NL: ['netherlands', 'dutch', 'amsterdam', 'the hague', 'rotterdam',
    'utrecht', 'rutte', 'tweede kamer'],
  BR: ['brazil', 'brazilian', 'brasilia', 'sao paulo', 'rio de janeiro',
    'lula', 'bolsonaro', 'congresso', 'supremo'],
  ZA: ['south africa', 'south african', 'pretoria', 'cape town',
    'johannesburg', 'durban', 'anc', 'ramaphosa', 'zuma'],
  NG: ['nigeria', 'nigerian', 'lagos', 'abuja', 'kano', 'ibadan',
    'tinubu', 'apc', 'pdp', 'naira'],
  AE: ['united arab emirates', 'uae', 'emirati', 'dubai', 'abu dhabi',
    'sharjah', 'mohammed bin rashid', 'aramco'],
  SA: ['saudi arabia', 'saudi', 'riyadh', 'jeddah', 'mecca', 'medina',
    'mohammed bin salman', 'aramco'],
  PK: ['pakistan', 'pakistani', 'islamabad', 'karachi', 'lahore', 'peshawar',
    'quetta', 'shehbaz sharif', 'imran khan', 'pti'],
  BD: ['bangladesh', 'bangladeshi', 'dhaka', 'chittagong', 'khulna',
    'sheikh hasina', 'yunus', 'awami league'],
}

/**
 * RELAXED country filter — the AI fallback.
 *
 * Strategy: KEEP everything UNLESS it's CLEARLY about another country.
 * This prevents accidentally removing UK local news that doesn't mention
 * "UK" in the title (e.g. "Leicester church fire", "Heathrow fares").
 *
 * A story is removed ONLY if it matches a STRONG foreign indicator:
 *   1. A foreign country name/capital/adjective in the title
 *   2. AND no UK keyword in the title (if it mentions both UK and a foreign
 *      country, it's likely a UK angle on an international story — keep it)
 *
 * This is deliberately conservative: better to keep a few non-UK stories
 * than to accidentally remove UK news.
 */
function isAboutCountry(title: string, countryCode: string): boolean {
  const cc = countryCode.toUpperCase()
  const keywords = COUNTRY_KEYWORDS_GDELT[cc] || COUNTRY_KEYWORDS_GDELT[cc === 'UK' ? 'GB' : '']
  if (!keywords) return true // unknown country — don't filter

  const titleLower = ` ${title.toLowerCase()} `

  // Step 1: Check if the title contains a UK keyword
  let hasCountryKeyword = false
  for (const kw of keywords) {
    if (kw.length <= 3) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`(?:^|[^a-z])${escaped}(?:[^a-z]|$)`, 'i')
      if (re.test(titleLower)) { hasCountryKeyword = true; break }
    } else {
      if (titleLower.includes(kw)) { hasCountryKeyword = true; break }
    }
  }
  // If it has a UK keyword → definitely keep (even if it also mentions
  // a foreign country — e.g. "UK responds to Japan earthquake" is UK news)
  if (hasCountryKeyword) return true

  // Step 2: No UK keyword found. Check if it's CLEARLY about another country.
  // Comprehensive list of foreign country indicators (name, capital, adjective, demonym)
  const foreignIndicators = [
    // Asia
    'japan', 'japanese', 'tokyo', 'china', 'chinese', 'beijing', 'shanghai',
    'india', 'indian', 'mumbai', 'delhi', 'new delhi',
    'south korea', 'korean', 'seoul', 'north korea',
    'thailand', 'thai', 'bangkok', 'vietnam', 'vietnamese', 'hanoi',
    'indonesia', 'indonesian', 'jakarta', 'philippines', 'filipino', 'manila',
    'pakistan', 'pakistani', 'islamabad', 'karachi', 'lahore',
    'bangladesh', 'bangladeshi', 'dhaka', 'myanmar', 'burma',
    'taiwan', 'taiwanese', 'hong kong', 'singapore', 'malaysia', 'malay',
    // Middle East
    'iran', 'iranian', 'tehran', 'iraq', 'iraqi', 'baghdad',
    'israel', 'israeli', 'palestinian', 'gaza', 'west bank',
    'saudi arabia', 'saudi', 'uae', 'emirates', 'dubai', 'abu dhabi',
    'turkey', 'turkish', 'istanbul', 'ankara', 'syria', 'syrian', 'damascus',
    'lebanon', 'lebanese', 'beirut', 'jordan', 'jordanian', 'amman',
    'yemen', 'yemeni', 'qatar', 'doha', 'kuwait', 'bahrain', 'oman',
    'egypt', 'egyptian', 'cairo',
    // Europe (non-UK)
    'germany', 'german', 'berlin', 'france', 'french', 'paris',
    'spain', 'spanish', 'madrid', 'italy', 'italian', 'rome', 'milan',
    'portugal', 'portuguese', 'lisbon', 'netherlands', 'dutch', 'amsterdam',
    'belgium', 'belgian', 'brussels', 'switzerland', 'swiss', 'bern',
    'austria', 'austrian', 'vienna', 'sweden', 'swedish', 'stockholm',
    'norway', 'norwegian', 'oslo', 'denmark', 'danish', 'copenhagen',
    'finland', 'finnish', 'helsinki', 'poland', 'polish', 'warsaw',
    'greece', 'greek', 'athens', 'croatia', 'serbia', 'serbian',
    'ukraine', 'ukrainian', 'kyiv', 'kiev', 'russia', 'russian', 'moscow',
    'belarus', 'czech', 'romania', 'bulgaria', 'hungary', 'hungarian',
    'ireland', 'irish', 'dublin',
    // Americas (non-UK)
    'us ', 'u.s.', 'united states', 'america', 'american', 'washington',
    'white house', 'capitol', 'congress', 'senate', 'pentagon',
    'trump', 'biden', 'harris', 'obama', 'us congress', 'us senate',
    'us supreme court', 'scotus', 'fbi', 'cia',
    'canada', 'canadian', 'ottawa', 'toronto',
    'brazil', 'brazilian', 'argentina', 'argentine', 'mexico', 'mexican',
    'chile', 'chilean', 'colombia', 'colombian', 'peru', 'venezuela',
    'cuba', 'cuban', 'jamaica', 'haiti',
    // Africa
    'nigeria', 'nigerian', 'kenya', 'kenyan', 'ethiopia', 'sudan',
    'somalia', 'somali', 'zimbabwe', 'ghana', 'morocco', 'moroccan',
    'south africa', 'libya', 'tunisia', 'algeria',
    // Oceania
    'australia', 'australian', 'canberra', 'sydney', 'melbourne',
    'new zealand', 'wellington',
  ]

  for (const kw of foreignIndicators) {
    if (titleLower.includes(kw)) return false // clearly about another country
  }

  // Step 3: No UK keyword AND no foreign indicator → KEEP
  // It's from a UK outlet and doesn't clearly mention another country.
  // This catches UK local news like "Leicester church fire", "Heathrow fares",
  // "Boy critical after Mersea Beach incident" etc.
  return true
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
])

// Stopwords for title fingerprinting (dedup)
const STOPWORDS_FP = new Set([
  'a','an','the','and','or','but','if','then','for','of','to','in','on','at',
  'by','with','from','as','is','are','was','were','be','been','being','this',
  'that','these','those','it','its','they','them','their','there','here','we',
  'us','our','you','your','he','she','his','her','my','me','not','no','yes',
  'do','does','did','have','has','had','will','would','can','could','should',
  'after','before','into','through','over','under','up','down','out','off',
  'says','said','say','new','one','two','amid','news','report','reports',
  'may','might','must','about','between','during','again','more','most','some','such',
  'only','own','same','so','than','too','very','just','also',
  'three','while','because','since','until','without','within','against','above','below',
  'onto','upon','who','what','when','where','why','how','which','whom','whose','via',
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
      if (a.imageUrl) {
        const upgraded = upgradeToHighRes(a.imageUrl)
        if (!bestImage || scoreImageUrl(upgraded) > scoreImageUrl(bestImage)) {
          bestImage = upgraded
        }
      }
      if (a.iso < firstSeen) firstSeen = a.iso
      if (a.iso > latestSeen) latestSeen = a.iso
    }

    // ── Title selection: prefer BBC → center → shortest >10 chars ──
    {
      // Step 1: BBC
      const bbcArticle = clusterArticles.find((a) => a.sourceId === 'bbc' || a.sourceName === 'BBC')
      if (bbcArticle && bbcArticle.title.length > 10) {
        bestTitle = bbcArticle.title
        bestSummary = bbcArticle.description
      } else {
        // Step 2: shortest center title >10 chars
        const centerTitles = clusterArticles.filter(
          (a) => a.leaning === 'center' && a.title.length > 10,
        )
        if (centerTitles.length > 0) {
          const shortest = centerTitles.reduce((a, b) =>
            a.title.length <= b.title.length ? a : b,
          )
          bestTitle = shortest.title
          bestSummary = shortest.description
        } else {
          // Step 3: shortest any title >10 chars
          const anyTitles = clusterArticles.filter((a) => a.title.length > 10)
          if (anyTitles.length > 0) {
            const shortest = anyTitles.reduce((a, b) =>
              a.title.length <= b.title.length ? a : b,
            )
            bestTitle = shortest.title
            bestSummary = shortest.description
          }
        }
      }
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

// ---------- RSS fallback with AI country filter ----------
// Used when GDELT is unavailable (429, query rejected, network error).
// Fetches from curated RSS sources for the country, then applies the AI
// country filter to remove international stories those outlets covered.
// Falls back to keyword filtering (isAboutCountry) if the AI fails.
async function rssFallbackWithAIFilter(
  countryCode: string,
  cc: string,
): Promise<{ topics: TopicArticle[]; articleCount: number; sourceCount: number }> {
  try {
    const { aggregateCategory } = await import('@/lib/news-aggregator')
    const { sourcesForCountry } = await import('@/lib/country-detect')
    const countrySourceIds = sourcesForCountry(countryCode)
    const rssResult = await aggregateCategory('mycountry', {
      limit: 40,
      minCoverage: 1,
      countrySourceIds,
      countryCode: countryCode,
    })
    console.log(`[gdelt] RSS fallback for ${cc}: ${rssResult.topics.length} topics from ${rssResult.sourceCount} sources`)

    // Apply the AI country filter to RSS results too.
    // RSS sources are country-based but cover international news. We need
    // to filter out non-country stories just like we do for GDELT.
    if (rssResult.topics.length > 0) {
      const countryDisplay = COUNTRY_DISPLAY[cc] || COUNTRY_TO_GDELT[cc] || cc
      const titleList = rssResult.topics
        .map((t, i) => `${i + 1}. ${t.title}`)
        .join('\n')

      const aiSystemPrompt = `You are a news editor for a ${countryDisplay} news app. You are given a list of news headlines from ${countryDisplay} news outlets. Your job is to identify which stories are ACTUALLY ABOUT ${countryDisplay} (or directly affect ${countryDisplay} people), and which are international stories that ${countryDisplay} outlets happened to cover.

Rules for KEEPING a story:
- The story is about events happening IN ${countryDisplay}
- The story is about ${countryDisplay} government, politics, or public services
- The story directly affects ${countryDisplay} people (e.g. ${countryDisplay} citizens abroad, ${countryDisplay} companies, ${countryDisplay} laws)
- The story is about ${countryDisplay} local news (cities, towns, incidents)

Rules for REMOVING a story:
- The story is about another country's domestic affairs (US politics, Japan earthquake, etc.)
- The story is about international events with no ${countryDisplay} angle
- The story is about a foreign country's elections, laws, or internal politics
- The story is about Trump, US politics, US elections, US Congress, etc.

Respond with ONLY the numbers of the stories to KEEP, comma-separated. Example: 1,3,5,7,10
No explanation, no other text.`

      const aiUserPrompt = `Country: ${countryDisplay}
News headlines from ${countryDisplay} outlets:

${titleList}

Which story numbers are ACTUALLY ABOUT ${countryDisplay}? Return ONLY the numbers, comma-separated.`

      try {
        console.log(`[gdelt-ai-filter] ${cc} (RSS fallback): Sending ${rssResult.topics.length} titles to AI for country filtering...`)
        const aiResponse = await callAI({ systemPrompt: aiSystemPrompt, userPrompt: aiUserPrompt, maxTokens: 200 })

        if (aiResponse) {
          const keepNumbers = aiResponse
            .replace(/[^0-9,\s]/g, ' ')
            .split(/[,\s]+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .map((s) => parseInt(s, 10))
            .filter((n) => !isNaN(n) && n >= 1 && n <= rssResult.topics.length)

          if (keepNumbers.length > 0) {
            const keepSet = new Set(keepNumbers)
            const filtered = rssResult.topics.filter((_, i) => keepSet.has(i + 1))
            console.log(`[gdelt-ai-filter] ${cc} (RSS fallback): AI kept ${filtered.length}/${rssResult.topics.length} stories`)
            rssResult.topics = filtered
          } else {
            console.warn(`[gdelt-ai-filter] ${cc} (RSS fallback): AI returned no valid numbers, using keyword fallback`)
            rssResult.topics = rssResult.topics.filter((t) => isAboutCountry(t.title, cc))
            console.log(`[gdelt-ai-filter] ${cc} (RSS fallback): Keyword fallback kept ${rssResult.topics.length} stories`)
          }
        } else {
          console.warn(`[gdelt-ai-filter] ${cc} (RSS fallback): AI returned null, using keyword fallback`)
          rssResult.topics = rssResult.topics.filter((t) => isAboutCountry(t.title, cc))
          console.log(`[gdelt-ai-filter] ${cc} (RSS fallback): Keyword fallback kept ${rssResult.topics.length} stories`)
        }
      } catch (aiErr) {
        console.warn(`[gdelt-ai-filter] ${cc} (RSS fallback): AI filter failed, using keyword fallback:`, aiErr)
        rssResult.topics = rssResult.topics.filter((t) => isAboutCountry(t.title, cc))
        console.log(`[gdelt-ai-filter] ${cc} (RSS fallback): Keyword fallback kept ${rssResult.topics.length} stories`)
      }
    }

    return rssResult
  } catch (err) {
    console.warn(`[gdelt] RSS fallback also failed for ${cc}:`, err)
    return { topics: [], articleCount: 0, sourceCount: 0 }
  }
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
  const config = COUNTRY_CONFIG[cc] || COUNTRY_CONFIG[cc === 'UK' ? 'GB' : '']
  const gdeltCountry = COUNTRY_TO_GDELT[cc] || COUNTRY_TO_GDELT[cc === 'UK' ? 'GB' : ''] || null
  if (!gdeltCountry) {
    console.warn(`[gdelt] No GDELT mapping for ${cc}, returning empty`)
    return { topics: [], articleCount: 0, sourceCount: 0 }
  }

  // ── GDELT query: search for articles ABOUT the country ──
  // For countries WITH a full config (UK, US, IN, etc.): use the country's
  // strong terms as the query. This finds articles from ANY outlet that
  // mention the country. sourcecountry is used as a scoring boost.
  //
  // For countries WITHOUT a config (any other GDELT-supported country):
  // use sourcecountry:<Country> directly. This returns articles from
  // outlets IN that country. We then rely on the AI country filter to
  // remove international stories those outlets covered.
  const buildStrongQuery = () => {
    const strongQuery = config.strongTerms
      .map((t) => `"${t}"`)
      .join(' OR ')
    return `(${strongQuery}) sourcelang:english`
  }
  const buildSourceCountryQuery = () => `sourcecountry:${gdeltCountry} sourcelang:english`

  let query: string
  if (config?.preferSourceCountry) {
    // Countries with many English-language domestic outlets (India, HK,
    // SG, etc.): sourcecountry first — more reliable than strong-terms.
    query = buildSourceCountryQuery()
  } else if (config) {
    query = buildStrongQuery()
  } else {
    query = buildSourceCountryQuery()
  }

  // Helper: fetch from GDELT, returning raw articles or null on any failure.
  // GDELT sometimes returns a text error page (e.g. "The specified query...")
  // instead of JSON when it rejects a query — we catch that as a failure.
  const fetchGdelt = async (q: string): Promise<GdeltArticle[] | null> => {
    const u = `${GDELT_API_URL}?query=${encodeURIComponent(q)}&mode=ArtList&maxrecords=250&format=json&sort=DateDesc&timewindow=1d`
    try {
      const res = await fetch(u, {
        signal: AbortSignal.timeout(20000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; NeutralWireBot/1.0; +https://neutralwire.org)',
          Referer: 'https://neutralwire.org',
          Accept: 'application/json',
        },
        cache: 'no-store',
      })
      if (!res.ok) {
        console.warn(`[gdelt] API returned ${res.status} for ${cc} (query: ${q.slice(0, 60)}...)`)
        return null
      }
      // GDELT sometimes returns a text error page with 200 status — guard
      // by checking content-type and trying to parse JSON safely.
      const ct = res.headers.get('content-type') || ''
      if (!ct.includes('json')) {
        const text = await res.text()
        console.warn(`[gdelt] Non-JSON response for ${cc}: ${text.slice(0, 100)}`)
        return null
      }
      const data = (await res.json()) as { articles?: GdeltArticle[] }
      return data.articles || []
    } catch (err) {
      console.warn(`[gdelt] fetch failed for ${cc} (query: ${q.slice(0, 60)}...):`, err)
      return null
    }
  }

  let raw: GdeltArticle[] = []
  // 1. Try the primary query.
  raw = (await fetchGdelt(query)) || []

  // 2. If the primary query failed, try the OTHER query as a fallback.
  //    - If we tried sourcecountry first → try strong-terms
  //    - If we tried strong-terms first → try sourcecountry
  //    This gives every country TWO chances at GDELT before RSS fallback.
  if (raw.length === 0 && config) {
    const fallbackQuery = config.preferSourceCountry
      ? buildStrongQuery()
      : buildSourceCountryQuery()
    console.log(`[gdelt] ${cc}: primary query returned no results, retrying with ${config.preferSourceCountry ? 'strong-terms' : 'sourcecountry'}...`)
    raw = (await fetchGdelt(fallbackQuery)) || []
    if (raw.length > 0) {
      console.log(`[gdelt] ${cc}: retry succeeded with ${raw.length} articles`)
    }
  }

  // 3. If BOTH GDELT queries failed → fall back to RSS aggregator with
  //    AI country filter. This ensures My Country always has news.
  if (raw.length === 0) {
    console.warn(`[gdelt] All GDELT queries failed for ${cc} — falling back to RSS aggregator with AI filter`)
    return await rssFallbackWithAIFilter(countryCode, cc)
  }

  // ── Convert GDELT articles to FeedArticle + score + filter + dedup ──
  const seenLinks = new Set<string>()
  const seenFingerprints = new Set<string>()
  const domainCounts: Record<string, number> = {}
  const scored: Array<{ article: FeedArticle; score: number; reason: string }> = []

  for (const a of raw) {
    if (!a.url || !a.title) continue

    // Decode HTML entities + strip any HTML in the title
    let title = a.title
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ').trim()
    if (title.length < 8) continue

    // Skip non-news (but NOT sports — sports gets a -3 penalty below
    // instead of being filtered entirely, so some high-relevance sports
    // stories can still appear if they're genuinely about the country)
    if (isNonNews(title)) continue

    const domain = a.domain || new URL(a.url).hostname
    const titleLower = title.toLowerCase()

    // ── Dedup by URL (normalized) ──
    const linkKey = a.url.split('?')[0].toLowerCase().replace(/\/$/, '')
    if (seenLinks.has(linkKey)) continue

    // ── Dedup by title fingerprint ──
    const fingerprint = titleLower
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter((w) => w.length > 2 && !STOPWORDS_FP.has(w))
      .sort()
      .join('|')
    if (seenFingerprints.has(fingerprint)) continue

    // ── Scoring ──
    // For countries WITH a config: score via strong/weak/blocklist terms.
    // For countries WITHOUT a config (generic sourcecountry fallback):
    //   - every article starts at score 3 (passes the threshold)
    //   - sports gets -3 (deprioritized but not removed)
    //   - the AI country filter (below) does the real relevance filtering
    let score = 0
    const reasons: string[] = []

    if (config) {
      // +3 if title contains a strong country term
      for (const term of config.strongTerms) {
        if (titleLower.includes(term)) {
          score += 3
          reasons.push(`headline mentions ${term}`)
          break
        }
      }

      // +2 if title contains a weak city/region term
      for (const term of config.weakTerms) {
        if (titleLower.includes(term)) {
          score += 2
          reasons.push(`headline mentions ${term}`)
          break
        }
      }

      // +1 if sourcecountry matches one of the country's candidates
      const articleSourceCountry = (a.sourcecountry || '').toLowerCase()
      for (const candidate of config.gdeltSourceCountries) {
        if (articleSourceCountry === candidate.toLowerCase()) {
          score += 1
          reasons.push('source is domestic')
          break
        }
      }

      // -2 if title contains a false-positive term
      for (const term of config.blocklist) {
        if (titleLower.includes(term)) {
          score -= 2
          reasons.push(`blocked: ${term}`)
          break
        }
      }
    } else {
      // ── Generic fallback (no country config) ──
      // sourcecountry query already filtered to outlets in this country.
      // Give a passing base score; the AI filter below removes irrelevant
      // international stories. sourcecountry match = domestic source.
      score = 3
      reasons.push('source is domestic (sourcecountry filter)')
    }

    // -3 if title is about sports (deprioritize in My Country)
    if (isSportsTitle(title)) {
      score -= 3
      reasons.push('sports deprioritized')
    }

    // Keep only articles with score >= 3
    if (score < 3) {
      console.log(`[gdelt-score] ${cc}: REJECTED "${title.slice(0, 50)}" (score: ${score})`)
      continue
    }

    // ── Source diversity: max 2 articles per domain ──
    if ((domainCounts[domain] || 0) >= 2) {
      console.log(`[gdelt-diversity] ${cc}: SKIPPED "${title.slice(0, 50)}" (domain ${domain} already has 2)`)
      continue
    }
    domainCounts[domain] = (domainCounts[domain] || 0) + 1

    seenLinks.add(linkKey)
    seenFingerprints.add(fingerprint)

    const iso = parseGdeltDate(a.seendate)
    const imageUrl = a.socialimage ? upgradeToHighRes(a.socialimage) : null
    const reason = `Shown because ${reasons.join(' and ')}`

    const article: FeedArticle = {
      id: hashId(a.url),
      title,
      link: a.url,
      description: reason, // Store the "Why am I seeing this?" reason in description
      pubDate: a.seendate,
      iso,
      imageUrl,
      sourceId: domain,
      sourceName: domain.replace(/^www\./, '').replace(/\.(co\.uk|com|org|net)$/i, ''),
      sourceHomepage: `https://${domain}`,
      leaning: leaningForDomain(domain),
      country: cc,
      category: 'mycountry',
    }

    scored.push({ article, score, reason })
    console.log(`[gdelt-score] ${cc}: KEPT "${title.slice(0, 50)}" (score: ${score}, reason: ${reason})`)
  }

  // Sort by relevance score first, then recency
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return b.article.iso - a.article.iso
  })

  const articles = scored.map((s) => s.article)
  console.log(`[gdelt] ${cc}: fetched ${raw.length} → scored ${scored.length} (score >= 3) → ${articles.length} kept`)

  // Skip AI filter — the scoring system above is the primary filter.
  // The AI filter was unreliable (GDELT 429 → RSS fallback → AI also fails).
  // The scoring system is deterministic and always works.

  // ── AI country-relevance filter ──
  // Send all article titles to the AI and ask it to return ONLY the ones
  // that are actually about the visitor's country (not international news
  // that a UK outlet happened to cover). This is much more accurate than
  // keyword matching — the AI understands context (e.g. "Heathrow fares"
  // is UK news even though it doesn't say "UK").
  //
  // Fallback: if the AI fails, use the relaxed isAboutCountry() filter
  // (keeps stories unless they clearly mention a foreign country).
  if (articles.length > 0) {
    const countryDisplay = COUNTRY_DISPLAY[cc] || COUNTRY_TO_GDELT[cc] || cc
    const titleList = articles
      .map((a, i) => `${i + 1}. ${a.title}`)
      .join('\n')

    const aiSystemPrompt = `You are a news editor for a ${countryDisplay} news app. You are given a list of news headlines from ${countryDisplay} news outlets. Your job is to identify which stories are ACTUALLY ABOUT ${countryDisplay} (or directly affect ${countryDisplay} people), and which are international stories that ${countryDisplay} outlets happened to cover.

Rules for KEEPING a story:
- The story is about events happening IN ${countryDisplay}
- The story is about ${countryDisplay} government, politics, or public services
- The story directly affects ${countryDisplay} people (e.g. ${countryDisplay} citizens abroad, ${countryDisplay} companies, ${countryDisplay} laws)
- The story is about ${countryDisplay} local news (cities, towns, incidents)

Rules for REMOVING a story:
- The story is about another country's domestic affairs (US politics, Japan earthquake, etc.)
- The story is about international events with no ${countryDisplay} angle
- The story is about a foreign country's elections, laws, or internal politics

Respond with ONLY the numbers of the stories to KEEP, comma-separated. Example: 1,3,5,7,10
No explanation, no other text.`

    const aiUserPrompt = `Country: ${countryDisplay}
News headlines from ${countryDisplay} outlets:

${titleList}

Which story numbers are ACTUALLY ABOUT ${countryDisplay}? Return ONLY the numbers, comma-separated.`

    try {
      console.log(`[gdelt-ai-filter] ${cc}: Sending ${articles.length} titles to AI for country filtering...`)
      const aiResponse = await callAI({ systemPrompt: aiSystemPrompt, userPrompt: aiUserPrompt, maxTokens: 200 })

      if (aiResponse) {
        // Parse the comma-separated list of numbers
        const keepNumbers = aiResponse
          .replace(/[^0-9,\s]/g, ' ')
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((s) => parseInt(s, 10))
          .filter((n) => !isNaN(n) && n >= 1 && n <= articles.length)

        if (keepNumbers.length > 0) {
          const keepSet = new Set(keepNumbers)
          const filtered = articles.filter((_, i) => keepSet.has(i + 1))
          console.log(`[gdelt-ai-filter] ${cc}: AI kept ${filtered.length}/${articles.length} stories (removed ${articles.length - filtered.length} non-${cc} stories)`)
          articles.length = 0
          articles.push(...filtered)
        } else {
          console.warn(`[gdelt-ai-filter] ${cc}: AI returned no valid numbers, using keyword fallback`)
          // Fallback: relaxed keyword filter
          const filtered = articles.filter((a) => isAboutCountry(a.title, cc))
          console.log(`[gdelt-ai-filter] ${cc}: Keyword fallback kept ${filtered.length}/${articles.length} stories`)
          articles.length = 0
          articles.push(...filtered)
        }
      } else {
        console.warn(`[gdelt-ai-filter] ${cc}: AI returned null, using keyword fallback`)
        const filtered = articles.filter((a) => isAboutCountry(a.title, cc))
        console.log(`[gdelt-ai-filter] ${cc}: Keyword fallback kept ${filtered.length}/${articles.length} stories`)
        articles.length = 0
        articles.push(...filtered)
      }
    } catch (err) {
      console.warn(`[gdelt-ai-filter] ${cc}: AI filter failed, using keyword fallback:`, err)
      const filtered = articles.filter((a) => isAboutCountry(a.title, cc))
      console.log(`[gdelt-ai-filter] ${cc}: Keyword fallback kept ${filtered.length}/${articles.length} stories`)
      articles.length = 0
      articles.push(...filtered)
    }
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
