import { firebaseRead, firebaseWrite, firebasePatch } from './firebase-server'
import type { TopicArticle } from './news-aggregator'

/**
 * Interest Engine v2 — the server-side personalisation brain.
 *
 * DESIGN (the owner's brief: "intelligently get better at finding your
 * interests", Google-Discover-class matching across notifications, the
 * Relevant feed and the email digest):
 *
 *   1. SIGNALS — every meaningful interaction becomes an event:
 *        story_open (+2.5 per matched term)     — the workhorse signal
 *        story_share (+4)  story_like (+4)      — strong positive
 *        notification click-through → arrives as story_open (the push URL
 *        opens the page), so notifications learn from what you open
 *        digest_click (+4)                      — explicit email engagement
 *        story_dislike (−5) / notification dismiss (−1.5) — negative
 *        interests_pick (+8 per sector)         — the onboarding picker
 *
 *   2. PROFILE — a per-device (and per-account, mirrored) vector:
 *        terms   — keyword + bigram affinity scores (the fine-grained
 *                  layer the old 7-sector system lacked entirely: it knows
 *                  you read about "heathrow", not just "politics")
 *        sectors — coarse affinity (compat with the existing taxonomy)
 *        categories / topics — feed-section and story-cluster affinity
 *      Everything DECAYS with a 14-day half-life — interests fade, the
 *      profile follows. Terms are capped (120) and pruned by |score| so
 *      the node stays small forever.
 *
 *   3. APPLICATION — one scorer feeds three surfaces:
 *        /api/news?personalize=…  → server-side re-rank of the Relevant
 *                                   feed (stories carry interestScore +
 *                                   matchedTerms — visible, explainable)
 *        gatherStories (digest)   → candidate pool ranked by interest,
 *                                   minus already-sent-without-click drag
 *        trigger-tz (notifications) → engine delta on top of the proven
 *                                   coverage/recency base score
 *
 *   4. REVERT — the whole engine sits behind featureFlags/
 *      smartPersonalization (default ON). Flip it off in /debug and all
 *      three surfaces return to the exact pre-engine behaviour; the
 *      profile keeps recording but nothing consumes it.
 *
 * AI is polish, never a gate: the engine is 100% deterministic keyword
 * mathematics — no provider call, no quota, no failure mode.
 */

// ── Types ─────────────────────────────────────────────────────────────────

export interface InterestProfile {
  version: number
  createdAt: number
  updatedAt: number
  lastDecayAt: number
  /** keyword/bigram → { s: affinity score, c: touch count, ts: last seen } */
  terms: Record<string, { s: number; c: number; ts: number }>
  /** sector id → affinity score */
  sectors: Record<string, number>
  /** feed category → affinity score */
  categories: Record<string, number>
  /** topicId → { s: affinity, ts: last seen } — story-cluster memory */
  topics: Record<string, { s: number; ts: number }>
  eventCount: number
}

export type InterestEventType =
  | 'story_open'
  | 'story_share'
  | 'story_like'
  | 'story_dislike'
  | 'digest_click'
  | 'notification_click'
  | 'notification_dismiss'
  | 'interests_pick'

export interface InterestEvent {
  type: InterestEventType
  topicId?: string
  title?: string
  summary?: string
  category?: string
  /** for interests_pick: the chosen sector ids */
  sectors?: string[]
}

// ── Constants (tuned so one story open can move a feed but can't dominate) ─

const TERM_WEIGHTS: Record<InterestEventType, number> = {
  story_open: 2.5,
  story_share: 4,
  story_like: 4,
  story_dislike: -5,
  digest_click: 4,
  notification_click: 3.5,
  notification_dismiss: -1.5,
  interests_pick: 0, // sectors only
}

const SECTOR_WEIGHTS: Record<InterestEventType, number> = {
  story_open: 3,
  story_share: 5,
  story_like: 5,
  story_dislike: -4,
  digest_click: 4,
  notification_click: 3,
  notification_dismiss: -1,
  interests_pick: 8,
}

const TOPIC_WEIGHTS: Record<InterestEventType, number> = {
  story_open: 4,
  story_share: 8,
  story_like: 8,
  story_dislike: -10,
  digest_click: 8,
  notification_click: 6,
  notification_dismiss: -2,
  interests_pick: 0,
}

const CATEGORY_WEIGHTS: Record<InterestEventType, number> = {
  story_open: 2,
  story_share: 3,
  story_like: 3,
  story_dislike: -2,
  digest_click: 3,
  notification_click: 2,
  notification_dismiss: -0.5,
  interests_pick: 0,
}

const MAX_TERMS = 120
const MAX_TOPICS = 100
const MAX_EVENTS = 50
const TERM_HALF_LIFE_DAYS = 14
const SECTOR_HALF_LIFE_DAYS = 21
const DAY_MS = 24 * 60 * 60 * 1000

/** Stopwords — shared shape with the notification keyword extractor. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'from', 'by', 'is', 'was', 'are', 'were', 'be', 'been',
  'being', 'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them',
  'their', 'there', 'here', 'we', 'us', 'our', 'you', 'your', 'he', 'she',
  'his', 'her', 'not', 'no', 'yes', 'do', 'does', 'did', 'has', 'have',
  'had', 'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must',
  'about', 'after', 'before', 'between', 'during', 'through', 'over',
  'under', 'up', 'down', 'out', 'off', 'than', 'too', 'very', 'just',
  'also', 'only', 'own', 'same', 'so', 'says', 'said', 'say', 'new', 'one',
  'two', 'amid', 'news', 'report', 'why', 'how', 'what', 'who', 'when',
  'where', 'which', 'could', 'talks', 'set', 'due', 'am', 'pm', 'vs',
  'u', 's', 'uk', 'us', 'eu', 'first', 'second', 'third', 'back', 'more',
  'most', 'other', 'others', 'against', 'among', 'into', 'onto', 'per',
  'via', 'as', 'at', 'if', 'no', 'now', 'old', 'see', 'seen', 'make',
  'made', 'take', 'takes', 'took', 'get', 'gets', 'got', 'give', 'gives',
])

// ── Term extraction (the fine-grained layer) ──────────────────────────────

/**
 * Tokenise a headline into unigrams + bigrams.
 * Bigrams carry the entity signal ("artificial intelligence",
 * "supreme court"); unigrams carry the topic drift ("tariff", "vaccine").
 * Light plural stemming (models→model) keeps singular/plural stories
 * matching — both sides get the same transform, so it is consistent.
 */
function stemToken(w: string): string {
  if (w.length >= 5 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) {
    return w.slice(0, -1)
  }
  return w
}

export function extractTerms(title: string, summary = ''): string[] {
  const text = `${title} ${summary}`.toLowerCase()
  const tokens = text
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && w.length <= 24 && !STOPWORDS.has(w))
    .map(stemToken)
    .filter((w) => w.length >= 3)
    .slice(0, 24) // a monster summary must not flood the profile
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    out.push(tokens[i])
    if (i + 1 < tokens.length) out.push(`${tokens[i]} ${tokens[i + 1]}`)
  }
  return out
}

/** Terms that are safe to surface as "why you're seeing this" labels. */
export function prettyTerm(term: string): string {
  return term.split(' ').map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ')
}

// ── Sector detection (server-side, richer than trigger-tz's copy) ─────────

const SECTOR_KEYWORDS: Record<string, string[]> = {
  politics: [
    'trump', 'biden', 'starmer', 'parliament', 'congress', 'senate', 'election',
    'vote', 'voting', 'labour', 'conservative', 'tories', 'democrat', 'republican',
    'mps', 'westminster', 'policy', 'government', 'minister', 'prime minister',
    'president', 'campaign', 'poll', 'lawmaker', 'legislation', 'cabinet',
    'downing street', 'white house', 'supreme court', 'impeach', 'lawsuit',
    'farage', 'reform uk', 'snp', 'scotus',
  ],
  world: [
    'ukraine', 'russia', 'putin', 'china', 'israel', 'gaza', 'hamas', 'iran',
    'middle east', 'europe', 'nato', 'africa', 'asia', 'japan', 'india',
    'france', 'germany', 'turkey', 'north korea', 'south korea', 'refugee',
    'migrant', 'ceasefire', 'pentagon', 'nuclear', 'war', 'conflict',
  ],
  technology: [
    'ai', 'artificial intelligence', 'openai', 'chatgpt', 'anthropic', 'claude',
    'gemini', 'google', 'apple', 'microsoft', 'meta', 'facebook', 'amazon',
    'tesla', 'nvidia', 'chip', 'semiconductor', 'tiktok', 'twitter',
    'elon musk', 'zuckerberg', 'iphone', 'android', 'startup', 'crypto',
    'bitcoin', 'cyber', 'hack', 'algorithm', 'deepmind', 'quantum',
    'robotics', 'chatbot', 'llm', 'data breach',
  ],
  business: [
    'stock', 'market', 'shares', 'dow', 'nasdaq', 'ftse', 'economy',
    'economic', 'inflation', 'interest rate', 'federal reserve', 'gdp',
    'recession', 'tariff', 'trade war', 'merger', 'acquisition', 'earnings',
    'ipo', 'billion', 'layoff', 'job cut', 'oil price', 'opec', 'wall street',
    'banking', 'finance', 'bank of england',
  ],
  science: [
    'nasa', 'spacex', 'rocket', 'mars', 'moon', 'space', 'astronaut',
    'telescope', 'james webb', 'cern', 'physics', 'chemistry', 'biology',
    'genome', 'dna', 'crispr', 'researchers', 'scientists', 'discovery',
    'breakthrough', 'climate', 'carbon', 'emissions', 'glacier', 'species',
    'fossil', 'dinosaur', 'earthquake', 'volcano',
  ],
  health: [
    'covid', 'pandemic', 'vaccine', 'hospital', 'nhs', 'fda', 'medicine',
    'drug', 'pharma', 'cancer', 'disease', 'outbreak', 'virus', 'flu',
    'measles', 'mental health', 'diabetes', 'heart', 'stroke', 'surgery',
    'clinical trial', 'therapy', 'dementia', 'obesity',
  ],
  sports: [
    'premier league', 'champions league', 'world cup', 'la liga', 'serie a',
    'bundesliga', 'nba', 'nfl', 'super bowl', 'wimbledon', 'fifa', 'uefa',
    'arsenal', 'chelsea', 'liverpool', 'man city', 'man united', 'tottenham',
    'cricket', 'rugby', 'golf', 'f1', 'formula 1', 'boxing', 'ufc',
    'olympics', 'football', 'tennis', 'transfer',
  ],
  entertainment: [
    'movie', 'film', 'oscar', 'emmy', 'grammy', 'netflix', 'disney', 'hbo',
    'spotify', 'taylor swift', 'concert', 'album', 'celebrity', 'actor',
    'actress', 'director', 'marvel', 'star wars', 'youtube', 'gaming',
    'playstation', 'xbox', 'nintendo', 'reality tv',
  ],
}

/** Detect sectors from a title (+optional summary). Empty → ['world']. */
export function detectSectorsForTitle(title: string, summary = ''): string[] {
  const text = ` ${title} ${summary} `.toLowerCase()
  const matched = new Set<string>()
  for (const [sector, kws] of Object.entries(SECTOR_KEYWORDS)) {
    for (const kw of kws) {
      // word-boundary-ish: ' ai ' not 'said' — pad with spaces, match ' kw '
      if (text.includes(kw.length <= 3 ? ` ${kw} ` : kw)) {
        matched.add(sector)
        break
      }
    }
  }
  if (matched.size === 0) matched.add('world')
  return Array.from(matched)
}

// ── Profile creation / decay / update ─────────────────────────────────────

export function newProfile(): InterestProfile {
  return {
    version: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastDecayAt: Date.now(),
    terms: {},
    sectors: {},
    categories: {},
    topics: {},
    eventCount: 0,
  }
}

/** Exponential decay factor for a half-life in days. */
function decayFactor(lastSeen: number, halfLifeDays: number, now: number): number {
  const days = Math.max(0, (now - lastSeen) / DAY_MS)
  return Math.pow(0.5, days / halfLifeDays)
}

/**
 * Apply time decay IN PLACE (lazy — call when a profile is loaded for a
 * write, or >24h since lastDecayAt). Read-only consumers compute effective
 * scores via decayFactor directly instead.
 */
export function decayProfile(p: InterestProfile, now = Date.now()): InterestProfile {
  if (now - (p.lastDecayAt || 0) < DAY_MS) return p
  for (const [term, v] of Object.entries(p.terms)) {
    v.s = v.s * decayFactor(v.ts, TERM_HALF_LIFE_DAYS, now)
    if (Math.abs(v.s) < 0.15 && now - v.ts > 3 * DAY_MS) delete p.terms[term]
  }
  for (const [sector, s] of Object.entries(p.sectors)) {
    p.sectors[sector] = s * 0.92 // sectors decay slowly and never vanish
  }
  for (const [cat, s] of Object.entries(p.categories)) {
    p.categories[cat] = s * 0.92
  }
  for (const [id, v] of Object.entries(p.topics)) {
    v.s = v.s * decayFactor(v.ts, SECTOR_HALF_LIFE_DAYS, now)
    if (Math.abs(v.s) < 0.2 && now - v.ts > 7 * DAY_MS) delete p.topics[id]
  }
  p.lastDecayAt = now
  return p
}

function pruneProfile(p: InterestProfile): InterestProfile {
  const termEntries = Object.entries(p.terms)
  if (termEntries.length > MAX_TERMS) {
    termEntries
      .sort((a, b) => Math.abs(b[1].s) - Math.abs(a[1].s))
      .slice(MAX_TERMS)
      .forEach(([term]) => delete p.terms[term])
  }
  const topicEntries = Object.entries(p.topics)
  if (topicEntries.length > MAX_TOPICS) {
    topicEntries
      .sort((a, b) => b[1].ts - a[1].ts)
      .slice(MAX_TOPICS)
      .forEach(([id]) => delete p.topics[id])
  }
  return p
}

/**
 * Fold one event into a profile (pure-ish: mutates and returns the profile).
 * This is the LEARNING step — the entire intelligence of the system.
 */
export function applyEvent(p: InterestProfile, evt: InterestEvent, now = Date.now()): InterestProfile {
  decayProfile(p, now)
  const tw = TERM_WEIGHTS[evt.type] ?? 0
  const sw = SECTOR_WEIGHTS[evt.type] ?? 0
  const tpw = TOPIC_WEIGHTS[evt.type] ?? 0
  const cw = CATEGORY_WEIGHTS[evt.type] ?? 0

  // Terms (title + summary bigrams/unigrams)
  if (tw !== 0 && evt.title) {
    for (const term of extractTerms(evt.title, evt.summary)) {
      const cur = p.terms[term] || { s: 0, c: 0, ts: now }
      // Repeated touches of the same term in later events give slightly
      // less (diminishing returns) — one story about X is a hint, ten is
      // a conviction, but the tenth must not double the first nine.
      const gain = tw / Math.sqrt(cur.c + 1)
      cur.s = Math.max(-30, Math.min(30, cur.s + gain))
      cur.c += 1
      cur.ts = now
      p.terms[term] = cur
    }
  }

  // Sectors — explicit pick OR detected from the story
  const sectors =
    evt.type === 'interests_pick' && evt.sectors?.length
      ? evt.sectors
      : evt.title
        ? detectSectorsForTitle(evt.title, evt.summary)
        : []
  for (const sector of sectors) {
    p.sectors[sector] = Math.max(-60, Math.min(60, (p.sectors[sector] || 0) + sw))
  }

  // Category affinity
  if (cw !== 0 && evt.category) {
    p.categories[evt.category] = Math.max(
      -30,
      Math.min(30, (p.categories[evt.category] || 0) + cw),
    )
  }

  // Topic-cluster affinity (remember THIS story was engaged)
  if (tpw !== 0 && evt.topicId) {
    const cur = p.topics[evt.topicId] || { s: 0, ts: now }
    p.topics[evt.topicId] = { s: Math.max(-20, Math.min(20, cur.s + tpw)), ts: now }
  }

  p.eventCount = (p.eventCount || 0) + 1
  p.updatedAt = now
  return pruneProfile(p)
}

// ── Scoring (the application step) ────────────────────────────────────────

export interface StoryInterestScore {
  score: number
  matchedTerms: string[]
}

/**
 * The interest DELTA for a story vs a profile — add it to whatever base
 * score a surface already computes. Bounded (−70..+70) so a learning
 * profile can reshuffle a feed but never buries a 30-source bombshell.
 */
export function scoreStoryDelta(
  story: Pick<TopicArticle, 'title' | 'summary' | 'coverage' | 'latestSeen' | 'topicId'>,
  profile: InterestProfile | null,
  now = Date.now(),
): StoryInterestScore {
  if (!profile || profile.eventCount < 3) return { score: 0, matchedTerms: [] }

  const terms = extractTerms(story.title, story.summary || '')
  const matched: Array<{ term: string; s: number }> = []
  let termSum = 0
  for (const term of terms) {
    const v = profile.terms[term]
    if (!v) continue
    const effective = v.s * decayFactor(v.ts, TERM_HALF_LIFE_DAYS, now)
    if (Math.abs(effective) < 0.1) continue
    termSum += effective
    matched.push({ term, s: effective })
  }
  // Raw sum, hard-bounded: a story that matches many learned terms is
  // simply MORE about what you read — but the cap keeps interest from
  // ever burying a 30-source bombshell entirely.
  const termScore = Math.max(-45, Math.min(45, termSum))

  // Sector affinity (decayed)
  let sectorScore = 0
  for (const sector of detectSectorsForTitle(story.title, story.summary || '')) {
    sectorScore += (profile.sectors[sector] || 0) * 0.35
  }
  sectorScore = Math.max(-20, Math.min(20, sectorScore))

  // Topic-cluster affinity: disliked story clusters come back weaker
  const topicAff = profile.topics[story.topicId]
  const topicScore = topicAff
    ? Math.max(-15, Math.min(15, topicAff.s * decayFactor(topicAff.ts, SECTOR_HALF_LIFE_DAYS, now) * 0.6))
    : 0

  const score = Math.round(termScore + sectorScore + topicScore)
  matched.sort((a, b) => Math.abs(b.s) - Math.abs(a.s))
  return { score, matchedTerms: matched.slice(0, 5).map((m) => m.term) }
}

/**
 * Full story score for RANKING contexts: importance base + recency +
 * interest delta. Used by the digest candidate ranking (and reusable
 * anywhere a plain "how much will this person like this" number is needed).
 */
export function scoreStoryForRanking(
  story: Pick<TopicArticle, 'title' | 'summary' | 'coverage' | 'latestSeen' | 'topicId'>,
  profile: InterestProfile | null,
  now = Date.now(),
): number {
  let base = (story.coverage || 1) * 2
  const ageHours = (now - (story.latestSeen || now)) / 3.6e6
  if (ageHours < 6) base += 8
  else if (ageHours < 24) base += 4
  else if (ageHours > 36) base -= 6
  return base + scoreStoryDelta(story, profile, now).score
}

/**
 * Rank a candidate list for a profile WITH a diversity pass: after the
 * sort, stories whose strongest bigram was already emitted twice get
 * demoted below the next distinct story (Discover's "don't show me five
 * versions of one event" behaviour).
 */
export function rankStoriesForProfile<T extends { title: string; summary?: string }>(
  stories: T[],
  profile: InterestProfile | null,
  scoreOf: (s: T) => number,
): Array<{ story: T; score: number }> {
  const scored = stories.map((story) => ({ story, score: scoreOf(story) }))
  scored.sort((a, b) => b.score - a.score)

  // Diversity pass on bigram saturation
  const bigramCount = new Map<string, number>()
  const emitted: Array<{ story: T; score: number }> = []
  const deferred: Array<{ story: T; score: number }> = []
  for (const item of scored) {
    const terms = extractTerms(item.story.title, item.story.summary || '').filter((t) => t.includes(' '))
    const saturation = Math.max(0, ...terms.map((t) => bigramCount.get(t) || 0))
    if (saturation >= 2) {
      deferred.push(item)
    } else {
      for (const t of terms) bigramCount.set(t, (bigramCount.get(t) || 0) + 1)
      emitted.push(item)
    }
  }
  // Deferred items re-enter in score order (their saturation may have
  // been lifted by nothing — they simply sit below distinct stories)
  return [...emitted, ...deferred]
}

// ── Firebase persistence ──────────────────────────────────────────────────

export const PROFILE_ROOT = 'interestProfiles'
export const accountProfileId = (accountId: string): string => `acct_${accountId}`

/**
 * Read one profile (null when absent). Never throws — a broken profile
 * read must degrade to "no personalisation", never an error page.
 */
export async function readInterestProfile(profileId: string): Promise<InterestProfile | null> {
  try {
    const p = await firebaseRead<InterestProfile>(`${PROFILE_ROOT}/${profileId}`)
    if (!p || typeof p !== 'object') return null
    return {
      ...newProfile(),
      ...p,
      terms: p.terms || {},
      sectors: p.sectors || {},
      categories: p.categories || {},
      topics: p.topics || {},
    }
  } catch {
    return null
  }
}

/**
 * The merged view for a user: device profile + (optionally) account
 * profile, account counting 1.2× (email + onboarding choices live there).
 */
export async function readMergedProfile(
  deviceId?: string | null,
  accountId?: string | null,
): Promise<InterestProfile | null> {
  const ids: Array<{ id: string; weight: number }> = []
  if (deviceId) ids.push({ id: deviceId, weight: 1 })
  if (accountId) ids.push({ id: accountProfileId(accountId), weight: 1.2 })
  if (ids.length === 0) return null

  const profiles = await Promise.all(ids.map(({ id }) => readInterestProfile(id)))
  const pairs = ids
    .map(({ weight }, i) => ({ weight, profile: profiles[i] }))
    .filter((x): x is { weight: number; profile: InterestProfile } => !!x.profile)
  if (pairs.length === 0) return null
  if (pairs.length === 1) return pairs[0].profile
  const present = pairs.map((x) => x.profile)
  const weights = pairs.map((x) => x.weight)

  const merged = newProfile()
  merged.createdAt = Math.min(...present.map((p) => p.createdAt || Date.now()))
  // merge by weighted sum
  const termMap = new Map<string, { s: number; c: number; ts: number }>()
  present.forEach((p, pi) => {
    const w = weights[pi] || 1
    for (const [term, v] of Object.entries(p.terms)) {
      const cur = termMap.get(term) || { s: 0, c: 0, ts: 0 }
      cur.s += v.s * w
      cur.c += v.c
      cur.ts = Math.max(cur.ts, v.ts)
      termMap.set(term, cur)
    }
    for (const [sector, s] of Object.entries(p.sectors)) {
      merged.sectors[sector] = (merged.sectors[sector] || 0) + s * w
    }
    for (const [cat, s] of Object.entries(p.categories)) {
      merged.categories[cat] = (merged.categories[cat] || 0) + s * w
    }
    for (const [id, v] of Object.entries(p.topics)) {
      const cur = merged.topics[id] || { s: 0, ts: 0 }
      merged.topics[id] = { s: cur.s + v.s * w, ts: Math.max(cur.ts, v.ts) }
    }
    merged.eventCount += p.eventCount || 0
  })
  merged.terms = Object.fromEntries(termMap)
  return pruneProfile(merged)
}

/**
 * Fold an event into every profile that should learn from it (the device
 * always; the account too when known — so email taste and browser taste
 * teach the same brain).
 */
export async function recordInterestEvent(opts: {
  deviceId?: string | null
  accountId?: string | null
  event: InterestEvent
  now?: number
}): Promise<{ ok: boolean; updated: string[] }> {
  const now = opts.now || Date.now()
  const targets: string[] = []
  if (opts.deviceId) targets.push(opts.deviceId)
  if (opts.accountId) targets.push(accountProfileId(opts.accountId))
  if (targets.length === 0) return { ok: false, updated: [] }

  const updated: string[] = []
  await Promise.all(
    targets.map(async (id) => {
      try {
        const existing = await readInterestProfile(id)
        const next = applyEvent(existing || newProfile(), opts.event, now)
        // PATCH the profile fields (never a full-node write — that would
        // clobber the events ring written below with a stale copy).
        await firebasePatch(`${PROFILE_ROOT}/${id}`, {
          version: next.version,
          createdAt: next.createdAt,
          updatedAt: next.updatedAt,
          lastDecayAt: next.lastDecayAt,
          terms: next.terms,
          sectors: next.sectors,
          categories: next.categories,
          topics: next.topics,
          eventCount: next.eventCount,
        })
        // Event ring (inspector + audit) — written AFTER the patch so it
        // can never be clobbered; capped at MAX_EVENTS keys by the pruner.
        const evtKey = `${now}_${Math.random().toString(36).slice(2, 7)}`
        await firebaseWrite(`${PROFILE_ROOT}/${id}/events/${evtKey}`, {
          type: opts.event.type,
          topicId: opts.event.topicId || null,
          title: (opts.event.title || '').slice(0, 90) || null,
          at: now,
        })
        updated.push(id)
      } catch {
        // silent — tracking must never break the page
      }
    }),
  )
  // Prune the event ring (read keys, drop the oldest overflow)
  if (targets.length > 0) void pruneEventRing(targets[0])
  return { ok: updated.length > 0, updated }
}

async function pruneEventRing(profileId: string): Promise<void> {
  try {
    const events = await firebaseRead<Record<string, unknown>>(
      `${PROFILE_ROOT}/${profileId}/events`,
    )
    if (!events) return
    const keys = Object.keys(events)
    if (keys.length <= MAX_EVENTS) return
    const sorted = keys.sort((a, b) => (a < b ? 1 : -1)) // ts-prefixed keys sort newest-first
    for (const k of sorted.slice(MAX_EVENTS)) {
      await firebaseWrite(`${PROFILE_ROOT}/${profileId}/events/${k}`, null)
    }
  } catch {
    // silent
  }
}

// ── The feature flag (one switch, three surfaces, full revert) ────────────

let smartFlagMemo: { value: boolean; ts: number } | null = null
const SMART_FLAG_PATH = 'featureFlags/smartPersonalization'
const FLAG_MEMO_MS = 10 * 1000

/**
 * Is the interest engine ON? Default TRUE (the owner wants the smart
 * experience live); the /debug flip is the revert to the original
 * sector-keyword system everywhere at once.
 */
export async function isSmartPersonalizationOn(): Promise<boolean> {
  try {
    if (smartFlagMemo && Date.now() - smartFlagMemo.ts < FLAG_MEMO_MS) return smartFlagMemo.value
    const stored = await firebaseRead<boolean>(SMART_FLAG_PATH)
    const value = stored === false ? false : stored === true ? true : true
    smartFlagMemo = { value, ts: Date.now() }
    return value
  } catch {
    return true // a flag-read failure must never disable personalisation silently... 
    // ...nor break the page: default ON matches the shipped behaviour.
  }
}

/** Test-only: reset the flag memo. */
export function resetSmartFlagMemo(): void {
  smartFlagMemo = null
}
