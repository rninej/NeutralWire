/**
 * search-client.ts — CLIENT-side search helpers for the feed filter.
 *
 * The server scorer lives in lib/search-match.ts, but it imports
 * STOPWORDS from story-quality (which pulls image-upgrade → network
 * code into the bundle), so the browser gets this dependency-free
 * mirror instead: same tokenization spirit, same word-boundary prefix
 * matching, same coverage rules — zero imports.
 *
 * Also hosts the RECENT SEARCHES store (localStorage) for the search
 * bar's quick-access chips.
 */

// Same spirit as story-quality's list — the words that appear in every
// headline and carry no story identity.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
  'this', 'that', 'these', 'those', 'it', 'its', 'their', 'his', 'her',
  'he', 'she', 'they', 'we', 'you', 'i', 'not', 'no', 'do', 'does', 'did',
  'has', 'have', 'had', 'will', 'would', 'could', 'should', 'can', 'may',
  'after', 'before', 'over', 'under', 'about', 'against', 'between',
  'into', 'through', 'during', 'than', 'then', 'so', 'if', 'because',
  'new', 'news', 'says', 'said', 'say', 'saying', 'report', 'reports',
  'up', 'down', 'out', 'off', 'more', 'most', 'some', 'all', 'any',
])

/** Tokenize a raw query — lowercase, punctuation stripped, stopwords
 *  dropped, unique. Numbers ≥4 chars (years) kept. */
export function tokenizeQuery(q: string): string[] {
  const words = q
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(
      (w) =>
        (w.length >= 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w)) ||
        (w.length >= 4 && /^\d+$/.test(w)),
    )
  return [...new Set(words)]
}

/** Does the token appear in the text as a whole word or word PREFIX?
 *  Prefix matching handles outlet conjugation ("russia" → "russian",
 *  "indict" → "indicted"). Prefix only for tokens ≥4 chars so "war"
 *  doesn't swallow "warden". */
function fieldHasToken(text: string, tok: string): boolean {
  if (text.includes(tok)) return true
  if (tok.length >= 4) {
    return new RegExp(`\\b${tok}`).test(text)
  }
  return false
}

export interface LocalSearchFields {
  title?: string | null
  summary?: string | null
  articleTitles?: Array<string | null | undefined>
  sourceNames?: Array<string | null | undefined>
}

/** True when a topic matches the query the same way the SERVER would
 *  judge it — used by the in-feed filter so local results and the
 *  full-catalog API results behave consistently (a multi-word query
 *  matches ANY word order, not just the raw substring). */
export function localSearchHit(fields: LocalSearchFields, tokens: string[]): boolean {
  if (tokens.length === 0) return true
  const title = (fields.title || '').toLowerCase()
  const summary = (fields.summary || '').toLowerCase()
  const articleTitles = (fields.articleTitles || []).map((t) =>
    typeof t === 'string' ? t.toLowerCase() : '',
  )
  const sourceNames = (fields.sourceNames || []).map((s) =>
    typeof s === 'string' ? s.toLowerCase() : '',
  )

  let matched = 0
  let titleMatched = 0
  for (const tok of tokens) {
    const inTitle = fieldHasToken(title, tok)
    const inSummary = fieldHasToken(summary, tok)
    const inArticle = articleTitles.some((t) => fieldHasToken(t, tok))
    const inSource = sourceNames.some((s) => fieldHasToken(s, tok))
    if (!inTitle && !inSummary && !inArticle && !inSource) continue
    matched++
    if (inTitle) titleMatched++
  }
  if (matched === 0) return false
  const total = tokens.length
  // Same recall rules as the server scorer:
  const singleHit = total === 1 && matched === 1
  const majorityHit = matched >= 2 && matched / total >= 0.5
  const longQueryHit = matched >= 4 && total >= 6
  // Single-token queries with a TITLE hit get a freer pass (a strong
  // topical word in the headline is a great local result even alone).
  return singleHit || majorityHit || longQueryHit || titleMatched >= Math.min(2, matched)
}

// ── Recent searches (localStorage) ────────────────────────────────────────

const RECENT_KEY = 'neutralwire:recent-searches'
const RECENT_MAX = 8

export function getRecentSearches(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter((s) => typeof s === 'string' && s.length >= 2).slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

export function addRecentSearch(q: string): void {
  const trimmed = q.trim()
  if (trimmed.length < 2) return
  try {
    const current = getRecentSearches().filter(
      (s) => s.toLowerCase() !== trimmed.toLowerCase(),
    )
    const next = [trimmed, ...current].slice(0, RECENT_MAX)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // private mode — recent searches are a nice-to-have
  }
}

export function clearRecentSearches(): void {
  try {
    localStorage.removeItem(RECENT_KEY)
  } catch {
    // silent
  }
}
