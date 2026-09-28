/**
 * story-quality.ts — ONE shared, dependency-free quality module for
 * story summaries and title attribution.
 *
 * WHY THIS EXISTS (Sep 2026):
 *  1. SHARE-CARD DESCRIPTIONS: a topic's stored summary can be a bare
 *     section word ("U.S."), a two-word quip ("tk"), or GDELT's internal
 *     "Shown because…" diagnostics — and generateMetadata used to pipe
 *     whatever was there straight into og:description (the shared-link
 *     cards that showed only "U.S."). isUsefulSummary is the one gate
 *     every surface now consults: the aggregators pick summaries with it
 *     at build time, page.tsx gates the description at share time.
 *  2. IMAGE/TOPIC ATTRIBUTION: "SpaceX's Starship launches into orbit for
 *     the first time" and "Andy Burnham's first-time buyer scheme" share
 *     the generic words {first, time} → Jaccard 0.154 → the housing story
 *     merged into the Starship cluster and its stock photo became the
 *     topic image. sharesSignificantKeyword requires a story-IDENTIFYING
 *     shared word (spacex, burnham, pride…), never generic filler.
 *
 * Deliberately dependency-free so page.tsx generateMetadata, the OG-image
 * route and the aggregators can all import it without pulling Firebase or
 * AI providers into the render path.
 */

// ── Significant keywords ─────────────────────────────────────────────────
// High-frequency news words that appear in headlines across EVERY topic.
// They inflate Jaccard similarity and shared-keyword counts; excluded from
// "significant" keyword sets used by clustering + image attribution.
const GENERIC_WORDS = new Set([
  'first', 'second', 'third', 'final', 'last', 'next', 'time', 'times',
  'year', 'years', 'month', 'months', 'week', 'weeks', 'day', 'days',
  'hour', 'hours', 'today', 'tonight', 'tomorrow', 'yesterday',
  'morning', 'evening', 'night', 'latest', 'live', 'update', 'updates',
  'full', 'major', 'minor', 'record', 'world', 'top', 'best', 'worst',
  'big', 'biggest', 'large', 'largest', 'huge', 'high', 'low', 'good',
  'bad', 'great', 'early', 'late', 'long', 'short', 'back', 'home',
  'open', 'close', 'free', 'new', 'old', 'young', 'set', 'eye', 'eyes',
  'plan', 'plans', 'deal', 'talks', 'win', 'wins', 'won', 'beat', 'beats',
  'clash', 'war', 'warns', 'urges', 'vows', 'says', 'tells', 'calls',
  'face', 'faces', 'rise', 'rises', 'fall', 'falls', 'grow', 'grows',
  'human', 'people', 'man', 'woman', 'history', 'future', 'past',
  'north', 'south', 'east', 'west', 'away', 'ahead', 'behind', 'again',
])

/** Base stopwords for keyword extraction (kept local so this module
 *  stays dependency-free — mirrors the aggregator's STOPWORDS). */
const STOPWORDS = new Set([
  'a','an','the','and','or','but','if','then','else','for','of','to','in','on','at','by','with','from','as','is','are','was','were','be','been','being','this','that','these','those','it','its','they','them','their','there','here','we','us','our','you','your','he','she','his','her','my','me','not','no','yes','do','does','did','done','have','has','had','will','would','can','could','should','may','might','must','shall','about','after','before','between','during','through','over','under','up','down','out','off','again','more','most','some','such','only','own','same','so','than','too','very','just','also','new','one','two','three','said','says','say','saying','news','report','reports','reported','amid','amidst','while','because','since','until','without','within','against','above','below','into','onto','upon','who','what','when','where','why','how','which','whom','whose','whether','either','neither','both','each','other','another','via','am','pm','gmt','utc',
])

/** Normalize a title to lowercase alpha-numeric words. */
export function normalizeTitleWords(t: string): string[] {
  return t
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** The keywords of a title (≥3 chars, non-stopword, non-numeric). */
export function titleKeywordSet(t: string): Set<string> {
  const out = new Set<string>()
  for (const w of normalizeTitleWords(t)) {
    if (w.length < 3) continue
    if (STOPWORDS.has(w)) continue
    if (/^\d+$/.test(w)) continue
    out.add(w)
  }
  return out
}

/** The subset of a title's keywords that actually IDENTIFIES the story
 *  (entities, actors, places) — generic news filler excluded. */
export function significantKeywordSet(t: string): Set<string> {
  const out = new Set<string>()
  for (const w of titleKeywordSet(t)) {
    if (GENERIC_WORDS.has(w)) continue
    out.add(w)
  }
  return out
}

/** Do two titles share at least one SIGNIFICANT (story-identifying)
 *  keyword? The gate for cluster merges and image attribution: a photo
 *  may only represent a headline when its own article's title shares a
 *  real subject word with that headline. */
export function sharesSignificantKeyword(a: string, b: string): boolean {
  const A = significantKeywordSet(a)
  if (A.size === 0) return false
  for (const w of significantKeywordSet(b)) {
    if (A.has(w)) return true
  }
  return false
}

// ── Summary quality ──────────────────────────────────────────────────────
/** Is a summary good enough to show as a story description (share cards,
 *  snippets, feed cards)? Rejects: empty, tiny fragments ("U.S.", "tk"),
 *  clauses under 8 words, and internal system notes (GDELT's "Shown
 *  because…" diagnostics, which used to leak straight into
 *  og:description and onto feed cards). */
export function isUsefulSummary(s: string | null | undefined): boolean {
  if (!s) return false
  const t = s.trim()
  if (t.length < 45) return false
  const words = t.split(/\s+/).filter(Boolean)
  if (words.length < 8) return false
  if (/^shown because/i.test(t)) return false
  // Category/section fragments some feeds put in <description> ("U.S.",
  // "World", "Politics"…)
  if (/^[a-z. ]+$/i.test(t) && words.length < 12) return false
  return true
}

// ── Serve-time presentation repair (cached topics) ───────────────────────
// Imported by /api/topic/[id] and /api/og-image: topics cached BEFORE the
// build-time guards shipped can still carry a wrong image (an off-topic
// merged article's photo — the asapilf Starship/housing bug) or a junk
// summary ("U.S.", a GDELT "Shown because…" note). The repair re-picks
// the image from ON-TOPIC articles (highest URL-quality score, upgraded
// to high-res) and blanks a non-useful summary, so every cached topic
// presents correctly without waiting for the cache to rotate. Both
// modules stay dependency-light: story-quality + image-upgrade only.
import { upgradeToHighRes } from '@/lib/image-upgrade'

/** URL-quality score for the serve-time re-pick — mirrors the
 *  aggregator's heuristics (dimension hints, thumbnail penalties,
 *  Guardian time-signed URLs deprioritised). */
export function scoreImageUrlLike(url: string): number {
  if (!url) return 0
  const u = url.toLowerCase()
  let score = 50
  if (/width=1[0-9]{3}/.test(u)) score += 40
  else if (/width=[7-9]\d{2}/.test(u)) score += 25
  else if (/width=[4-6]\d{2}/.test(u)) score += 10
  else if (/width=\d{1,3}(?!\d)/.test(u)) score -= 20
  if (/\/(?:1[0-9]{3}|[7-9]\d{2})(?:x(?:1[0-9]{3}|[7-9]\d{2}))?\//.test(u)) score += 35
  else if (/\/(?:[4-6]\d{2})\//.test(u)) score += 10
  else if (/\/(?:[1-3]\d{2})\//.test(u)) score -= 15
  if (/-jumbo\.|-articleLarge\.|-superJumbo\./.test(u)) score += 30
  if (/-mediumSquareAt3X\./.test(u)) score += 20
  if (/-thumbStandard\.|-thumbLarge\.|-small\./.test(u)) score -= 25
  if (/i\.guim\.co\.uk\//.test(u)) score -= 45
  if (/media\.guim\.co\.uk\//.test(u)) score -= 45
  // Card-sized Bing thumbnails score well
  if (/bing\.com\/th\?/i.test(u) && /[?&]w=600/.test(u)) score += 30
  return score
}

/** Minimal topic shape the repair needs (both TopicArticle and the
 *  og-image override object satisfy it structurally). */
export interface RepairableTopic {
  title: string
  summary?: string | null
  imageUrl?: string | null
  articles?: Array<{
    title?: string
    imageUrl?: string | null
    description?: string
  }>
}

/** Presentation fields after repair. */
export interface RepairedPresentation {
  imageUrl: string | null
  summary: string
}

/**
 * Repair a cached topic's PRESENTATION fields (image + summary) at serve
 * time. Rules:
 *  • IMAGE: if the current imageUrl is attached to one of the topic's own
 *    articles and that article's title does NOT share a significant
 *    keyword with the headline, the photo belongs to an unrelated merged
 *    story → re-pick from the on-topic articles (highest score, upgraded
 *    to high-res; any image-bearing article as the last resort). Images
 *    not attached to any article (og-fetched + VLM-verified at build
 *    time) are only upgraded, never re-picked.
 *  • SUMMARY: a non-useful summary ("U.S.", "Shown because…") is replaced
 *    by the first USEFUL article description, or blanked — share cards
 *    and snippets gate it at render time, cards just show no blurb.
 * Never throws; a topic without articles comes back upgraded-only.
 */
export function repairTopicPresentation(
  topic: RepairableTopic,
): RepairedPresentation {
  let imageUrl = topic.imageUrl ?? null
  const summary = topic.summary ?? ''
  const articles = topic.articles || []

  try {
    if (imageUrl) {
      const owner = articles.find(
        (a) => a.imageUrl && a.imageUrl === topic.imageUrl,
      )
      if (owner && !sharesSignificantKeyword(owner.title || '', topic.title)) {
        let pick: string | null = null
        let pickScore = -1
        let fallback: string | null = null
        let fallbackScore = -1
        for (const a of articles) {
          if (!a.imageUrl) continue
          const upgraded = upgradeToHighRes(a.imageUrl)
          const s = scoreImageUrlLike(upgraded)
          if (s > fallbackScore) {
            fallback = upgraded
            fallbackScore = s
          }
          if (
            s > pickScore &&
            sharesSignificantKeyword(a.title || '', topic.title)
          ) {
            pick = upgraded
            pickScore = s
          }
        }
        imageUrl = pick || fallback || upgradeToHighRes(imageUrl)
      } else {
        // On-topic owner, or not attached to any article (og-fetched) —
        // upgrade only.
        imageUrl = upgradeToHighRes(imageUrl)
      }
    }
  } catch {
    // never fail a serve path because of the repair
  }

  let repairedSummary = summary
  try {
    if (!isUsefulSummary(summary)) {
      const useful = articles.find(
        (a) => a.description && isUsefulSummary(a.description),
      )
      repairedSummary = useful?.description || ''
    }
  } catch {
    repairedSummary = summary
  }

  return { imageUrl, summary: repairedSummary }
}
