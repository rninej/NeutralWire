/**
 * search-match.ts — cross-source headline matching for /api/search.
 *
 * THE PROBLEM (owner request, Oct 2026): search was pure substring
 * matching. Pasting a headline from ANOTHER outlet ("BBC Verify examines
 * Russian-linked operations…") almost never matched the NeutralWire story
 * that CONTAINS that outlet's article, because NeutralWire's synthesized
 * topic title differs and the outlet's own headline only lives in the
 * cluster's article list. Substring search needs the whole pasted string
 * to appear verbatim — hopeless across outlets.
 *
 * THE FIX: token-overlap scoring. Paste ANY outlet's headline → its
 * significant words (verify, russian, operations, spreading, ukraine…)
 * are matched against the topic title + summary + EVERY article headline
 * in the cluster. The story that used that outlet scores high on
 * article-title overlap and wins.
 *
 * Reuses story-quality's stopword/generic-word lists so "significant"
 * means the same thing here as in clustering and image attribution.
 *
 * Dependency-free — importable from any route.
 */

import { STOPWORDS } from '@/lib/story-quality'

/** Query tokens: lowercase words ≥2 chars, stopwords dropped, unique,
 *  ORDER PRESERVED (order feeds nothing today but keeps debugging sane).
 *  Numbers kept — years ("2026") and quantities are legitimate headline
 *  content. */
export function queryTokens(q: string): string[] {
  const words = q
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w) || (w.length >= 4 && /^\d+$/.test(w)))
  return [...new Set(words)]
}

// ── TYPO TOLERANCE (Nov 2026 — "make the search system way better") ──
// Real users misspell names ("Kiev"/"Kyiv", "Macron"/"Marcon",
// "elecion"). Substring and prefix matching both miss those. When a
// token finds NO strict match anywhere in a candidate, we fall back to a
// bounded edit-distance-1 word scan — "haras" matches "harass",
// "sucession" matches "succession". Only for tokens ≥5 chars (a short
// token's one-edit neighbourhood is all real words: "war"→"wars",
// "gas"→"was"…) and only ONE edit (two typos in one word is rare and
// the false-positive rate explodes).

/** Bounded edit-distance ≤ 1: substitution (same length) or one
 *  insertion/deletion (length ±1). Hot path — written branch-cheap. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  if (a.length === b.length) {
    let subs = 0
    for (let k = 0; k < a.length; k++) {
      if (a[k] !== b[k] && ++subs > 1) return false
    }
    return true
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a]
  let i = 0
  let j = 0
  let skipped = false
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++
      j++
    } else {
      if (skipped) return false
      skipped = true
      j++
    }
  }
  return true // any leftover tail ≤1 char (guaranteed by the length diff)
}

// ── Word-boundary prefix matching ──
// Outlets CONJUGATE differently ("indicted" vs "indictment", "Russia"
// vs "Russian", "attack" vs "attacks") — substring matching misses all
// of those. A token matches a field when it appears as a whole-word
// PREFIX (\b<token>): "indict" matches "indicted" and "indictment",
// "russia" matches "russian". Only for tokens ≥4 chars (shorter
// prefixes like "war" would swallow "warden"). Regexes are cached —
// the same tokens are tested against thousands of archive entries.
const tokenRegexCache = new Map<string, RegExp>()
function tokenRegex(tok: string): RegExp {
  let re = tokenRegexCache.get(tok)
  if (!re) {
    re = new RegExp(`\\b${tok}`)
    if (tokenRegexCache.size > 300) tokenRegexCache.clear()
    tokenRegexCache.set(tok, re)
  }
  return re
}

function fieldHasToken(text: string, tok: string): boolean {
  if (text.includes(tok)) return true
  if (tok.length >= 4) return tokenRegex(tok).test(text)
  return false
}

/** Fuzzy fallback for one token against one field's words.
 *  Returns the ACTUAL field word it matched (for "did you mean"), or null. */
function fieldFuzzyToken(text: string, tok: string): string | null {
  if (tok.length < 5) return null // short tokens: one edit = all real words
  const words = text.split(/[^a-z0-9]+/)
  for (const w of words) {
    if (Math.abs(w.length - tok.length) <= 1 && withinOneEdit(w, tok)) {
      return w
    }
  }
  return null
}

/** Where a token was found — title hits outweigh body hits in scoring. */
export interface TokenMatch {
  /** 0..1 — fraction of query tokens found anywhere. */
  coverage: number
  /** How many DISTINCT query tokens matched. */
  matched: number
  /** Total distinct query tokens considered. */
  total: number
  /** Tokens found in the TOPIC title (the strongest signal). */
  titleMatched: number
  /** Tokens found only in article headlines / descriptions. */
  articleMatched: number
  /** True when the FULL query string appears verbatim in a field. */
  exact: boolean
  /** Composite ranking score (higher = better). */
  score: number
  /** Tokens that matched ONLY via typo tolerance, with the field word
   *  they matched — powers the "Did you mean X?" suggestion. */
  fuzzyMatches?: Array<{ query: string; word: string }>
}

/** Empty-ish texts are normal (archive entries can lack summaries). */
function asText(s: string | null | undefined): string {
  return typeof s === 'string' ? s.toLowerCase() : ''
}

/**
 * Score one candidate against the tokenized query.
 *
 * Fields, in match priority order:
 *   title          — topic headline            (weight 1.5 per token)
 *   summary        — neutral/wire summary      (weight 1.0)
 *   articleTitles  — every outlet headline in the cluster (weight 1.2 —
 *                    the cross-source path: another outlet's headline
 *                    matches HERE)
 *   descriptions   — article body snippets     (weight 0.8)
 *
 * HIT RULES (any one):
 *   • exact substring of the full query in any field → dominant score
 *   • single-token query matches → hit (the old "chess" behaviour)
 *   • ≥2 tokens matched AND coverage ≥ 0.5
 *   • ≥4 tokens matched (long pasted headlines where half the words
 *     differ by outlet phrasing — recall over precision at the top)
 *
 * Returns null when the candidate is NOT a hit.
 */
export function scoreCandidate(
  tokens: string[],
  rawQuery: string,
  fields: {
    title?: string | null
    summary?: string | null
    articleTitles?: string[]
    descriptions?: string[]
  },
): TokenMatch | null {
  if (tokens.length === 0) return null

  const title = asText(fields.title)
  const summary = asText(fields.summary)
  const articleTitles = (fields.articleTitles || []).map(asText)
  const descriptions = (fields.descriptions || []).map(asText)
  const all = [title, summary, ...articleTitles, ...descriptions]

  // Exact substring of the whole (trimmed) query anywhere → instant hit.
  const raw = rawQuery.trim().toLowerCase()
  const exact =
    raw.length >= 2 && all.some((t) => t.length > 0 && t.includes(raw))

  let matched = 0
  let titleMatched = 0
  let articleMatched = 0
  let weight = 0
  const fuzzyMatches: Array<{ query: string; word: string }> = []
  // Typo tolerance only for human-sized queries — a pasted 12-word
  // headline gets strict token-overlap (its recall comes from volume).
  const allowFuzzy = tokens.length <= 8
  for (const tok of tokens) {
    let inTitle = fieldHasToken(title, tok)
    let inSummary = fieldHasToken(summary, tok)
    let inArticle = articleTitles.some((t) => fieldHasToken(t, tok))
    let inDesc = descriptions.some((t) => fieldHasToken(t, tok))

    // Typo fallback: the token matched NOTHING strictly — try one-edit
    // matching against the field words. A fuzzy hit counts (slightly
    // softer weight) and is remembered for "Did you mean…?".
    if (!inTitle && !inSummary && !inArticle && !inDesc && allowFuzzy) {
      let fz = fieldFuzzyToken(title, tok)
      if (!fz) fz = fieldFuzzyToken(summary, tok)
      if (!fz) {
        for (const t of articleTitles) {
          const w = fieldFuzzyToken(t, tok)
          if (w) {
            fz = w
            break
          }
        }
      }
      if (!fz) {
        for (const t of descriptions) {
          const w = fieldFuzzyToken(t, tok)
          if (w) {
            fz = w
            break
          }
        }
      }
      if (fz) {
        fuzzyMatches.push({ query: tok, word: fz })
        if (title.includes(fz)) inTitle = true
        else if (articleTitles.some((t) => t.includes(fz))) inArticle = true
        else if (summary.includes(fz)) inSummary = true
        else inDesc = true
      }
    }

    if (!inTitle && !inSummary && !inArticle && !inDesc) continue
    matched++
    if (inTitle) {
      titleMatched++
      weight += fuzzyMatches.some((f) => f.query === tok) ? 1.35 : 1.5
    } else if (inArticle) {
      articleMatched++
      weight += 1.2
    } else if (inSummary) {
      weight += 1.0
    } else {
      weight += 0.8
    }
  }

  const total = tokens.length
  const coverage = matched / total

  // Ratio needed rises as the query SHRINKS — a 3-word query matching
  // only 1 of its words is noise; an 8-word pasted headline matching 5
  // is exactly the cross-source case we exist for.
  const ratioNeeded = total <= 2 ? 1 : total <= 5 ? 0.66 : 0.5

  const singleHit = total === 1 && matched === 1
  const majorityHit = matched >= 2 && coverage >= ratioNeeded
  const longHeadlineHit = matched >= 4 && total >= 6
  if (!exact && !singleHit && !majorityHit && !longHeadlineHit) return null

  // Composite score:
  //   exact substring dominates; then coverage; then a title-richness
  //   bonus (matches in the topic headline mean the story IS about this,
  //   not merely mentions a word in paragraph nine).
  const titleBonus = matched > 0 ? titleMatched / matched : 0
  const score =
    (exact ? 10 : 0) + coverage * 3 + (weight / total) * 1.5 + titleBonus * 0.8

  return {
    coverage,
    matched,
    total,
    titleMatched,
    articleMatched,
    exact,
    score,
    fuzzyMatches: fuzzyMatches.length > 0 ? fuzzyMatches : undefined,
  }
}

/**
 * Build a snippet around the densest cluster of matched tokens.
 * Falls back to the text's start. Best-effort — never throws.
 */
export function snippetAroundTokens(
  text: string,
  tokens: string[],
  maxLen = 170,
): string {
  if (!text) return ''
  const lower = text.toLowerCase()
  const positions: number[] = []
  for (const tok of tokens) {
    const i = lower.indexOf(tok)
    if (i >= 0) positions.push(i)
  }
  if (positions.length === 0) return text.slice(0, maxLen)
  positions.sort((a, b) => a - b)
  // Densest window: start at the first of the two closest positions.
  let start = positions[0]
  let bestGap = Infinity
  for (let i = 0; i < positions.length - 1; i++) {
    const gap = positions[i + 1] - positions[i]
    if (gap < bestGap) {
      bestGap = gap
      start = positions[i]
    }
  }
  const context = Math.max(0, start - 48)
  const end = Math.min(text.length, context + maxLen)
  let snippet = text.slice(context, end)
  if (context > 0) snippet = '…' + snippet.replace(/^\S*\s/, '')
  if (end < text.length) snippet = snippet.replace(/\s\S*$/, '') + '…'
  return snippet.trim()
}
