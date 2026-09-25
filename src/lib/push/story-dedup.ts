/**
 * story-dedup.ts — near-duplicate NEWS detection (stemmed keyword-set
 * similarity), shared by the briefing pipeline and the news-cache room
 * writer.
 *
 * ── WHY (the OpenAI/Australia incident, Sep 2026) ──
 * The old guard deduped notifications by EXACT match on either topicId or
 * an unstemmed sorted-keyword fingerprint. "Slightly different words" —
 * the same event re-headlined as
 *     "OpenAI hacked Australians' phones, Dutton says"
 *     "Australia calls out OpenAI over hacking claims"
 * — produced a different keyword set, a different fingerprint, a new
 * topicId (rooms are REPLACED every refresh and topicId is derived from
 * the title), and the user got the SAME NEWS twice in one day.
 *
 * ── HOW ──
 * 1. Tokenize + stopword-filter the title (merged stopword list from the
 *    aggregator + the briefing fingerprint, plus generic news verbs).
 * 2. STEM each token (one suffix strip: -s/-es/-ed/-ing/-er/-ers/-ion/
 *    -ions/-ies, remainder >= 4 chars) then prefix-cap at 6 chars —
 *    "australia" and "australian" both become "austra", "russian" and
 *    "russia" both "russia", "hacked"/"hacking"/"hackers" all "hack".
 *    A tiny post-stem synonym map merges the classic re-headline pairs
 *    (dead/dies/died/deadly -> "kill", quake -> "earthq", breach ->
 *    "hack", gunman -> "shooter").
 * 3. Entity extraction: tokens that are proper-noun-ish in either title
 *    (mid-title capitalisation, camelCase like OpenAI/SpaceX, or all-caps
 *    like NATO).
 * 4. Two titles are NEAR-DUPLICATES when their stemmed sets satisfy ANY of:
 *       a) shared >= 2 AND jaccard >= 0.55          (near-identical)
 *       b) shared >= 3 AND jaccard >= 0.30 AND sharedEntities >= 2
 *          (paraphrase sharing 2+ named entities — the OpenAI case)
 *       c) shared >= 3 AND jaccard >= 0.40 AND sharedEntities >= 1
 *          (strong overlap with at least one shared entity)
 *    GUARD — entity-only differences on BOTH sides mean DIFFERENT named
 *    actors/places ("Russia strikes Kyiv" vs "Russia strikes Lviv"):
 *    never a duplicate, whatever the jaccard.
 *
 * Titles with fewer than 3 significant stemmed tokens never dedup (same
 * conservatism as the old fingerprint).
 */

// ── Stopwords: union of the aggregator's list + the old briefing
// fingerprint list + generic news verbs that carry no event identity. ──
const STOPWORDS = new Set([
  // articles / conjunctions / prepositions / pronouns
  'a','an','the','and','or','but','if','then','else','for','of','to','in','on','at','by','with','from','as','is','are','was','were','be','been','being','this','that','these','those','it','its','they','them','their','there','here','we','us','our','you','your','he','she','his','her','my','me','not','no','yes','do','does','did','done','have','has','had','will','would','can','could','should','may','might','must','shall','about','after','before','between','during','through','over','under','up','down','out','off','again','more','most','some','such','only','own','same','so','than','too','very','just','also','new','news','one','two','three','who','what','when','where','why','how','which','whom','whose','whether','either','neither','both','each','other','another','via','am','pm','gmt','utc','against','above','below','into','onto','upon','without','within',
  // reporting verbs / filler that re-headlines swap freely
  'says','said','say','saying','reports','report','reported','amid','amidst','while','because','since','until','calls','call','warns','warn','urges','urge','seeks','seek','tells','tell','slams','slam','hits','hit','wins','win','rises','rise','falls','fall','drops','drop','grows','grow','clashes','clash',
])

/** Post-stem synonym roots for the classic same-event re-headline pairs. */
const SYNONYM_ROOTS: Record<string, string> = {
  dead: 'kill', dies: 'kill', died: 'kill', death: 'kill', deaths: 'kill', deadly: 'kill',
  quake: 'earthq', tremor: 'earthq',
  breach: 'hack',
  gunman: 'shooter', gunmen: 'shooter',
}

/** One suffix strip, longest-first, remainder must stay >= 4 chars. */
const SUFFIXES = ['ions', 'ing', 'ers', 'ies', 'es', 'ed', 'er', 'ion', 's']

// Prefix cap: 6 chars merges country/adjective forms (australia/
// australian → "austra", russia/russian → "russia", america/american →
// "americ", israel/israeli → "israel", europe/european → "europe") while
// keeping genuinely different words apart (china/chines, britain/britis).
const STEM_CAP = 6

export function stemToken(word: string): string {
  let s = word
  for (const suf of SUFFIXES) {
    if (s.length - suf.length >= 4 && s.endsWith(suf)) {
      s = s.slice(0, -suf.length)
      break
    }
  }
  if (s.length > STEM_CAP) s = s.slice(0, STEM_CAP)
  return SYNONYM_ROOTS[s] || s
}

/** Stemmed, stopword-filtered keyword SET for a title (lowercase source). */
export function titleKeywordSet(title: string): Set<string> {
  const words = title.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim().split(' ')
  const out = new Set<string>()
  for (const w of words) {
    if (w.length < 3) continue
    if (STOPWORDS.has(w)) continue
    if (/^\d+$/.test(w)) continue
    out.add(stemToken(w))
  }
  return out
}

/**
 * Sorted-token signature string ("<kw> <kw> ..."), '' when fewer than 3
 * significant tokens (too generic to block anything — matches the old
 * fingerprint's conservatism). Stored in notification-sent-history so
 * future runs can compare with plain string keys.
 */
export function titleSignature(title: string): string {
  const kws = Array.from(titleKeywordSet(title)).sort()
  return kws.length >= 3 ? kws.join(' ') : ''
}

// ── Proper-noun ("entity") extraction ──
// A raw word is entity-ish when: camelCase (OpenAI, iPhone, SpaceX), ALL-CAPS
// (NATO, BBC), or Capitalized anywhere EXCEPT the plain first word of the
// title (sentence-initial capitals are ambiguous: "Trump..." vs "Police...").
function entityTokens(title: string): Set<string> {
  const raw = title.replace(/[^\w\s'-]/g, ' ').replace(/\s+/g, ' ').trim().split(' ')
  const out = new Set<string>()
  raw.forEach((w, i) => {
    if (!w || w.length < 2) return
    const camel = /[a-z][A-Z]/.test(w)
    const allCaps = w.length >= 2 && w === w.toUpperCase() && /[A-Z]/.test(w)
    const midCap = i > 0 && /^[A-Z][a-z]/.test(w)
    if (camel || allCaps || midCap) {
      const stemmed = stemToken(w.toLowerCase().replace(/[^\w]/g, ''))
      if (stemmed) out.add(stemmed)
    }
  })
  return out
}

export interface TitleSimilarity {
  shared: number
  jaccard: number
}

/** Compare two SIGNATURE strings (sorted stemmed tokens, space-joined). */
export function signatureSimilarity(a: string, b: string): TitleSimilarity {
  if (!a || !b) return { shared: 0, jaccard: 0 }
  const setA = new Set(a.split(' '))
  const setB = new Set(b.split(' '))
  let shared = 0
  for (const t of setA) if (setB.has(t)) shared++
  const union = setA.size + setB.size - shared
  return { shared, jaccard: union ? shared / union : 0 }
}

/**
 * Full near-duplicate test for two TITLES (needs the original casing for
 * entity extraction). Any of:
 *   a) shared >= 2 && jaccard >= 0.55
 *   b) shared >= 3 && jaccard >= 0.30 && sharedEntities >= 2
 *   c) shared >= 3 && jaccard >= 0.40 && sharedEntities >= 1
 * with the entity-only-difference GUARD (different named actors/places on
 * both sides → different events, never a duplicate).
 */
export function isNearDuplicateTitle(a: string, b: string): boolean {
  if (!a || !b) return false
  const setA = titleKeywordSet(a)
  const setB = titleKeywordSet(b)
  if (setA.size < 3 || setB.size < 3) return false
  let shared = 0
  for (const t of setA) if (setB.has(t)) shared++
  if (shared < 2) return false
  const union = setA.size + setB.size - shared
  const jaccard = union ? shared / union : 0

  const entsA = entityTokens(a)
  const entsB = entityTokens(b)
  const ents = new Set([...entsA, ...entsB])

  // GUARD: entity-only differences on BOTH sides = different named
  // actors/places ("Russia strikes Kyiv" vs "Russia strikes Lviv") —
  // different events even at jaccard 0.7+.
  const diffA: string[] = []
  const diffB: string[] = []
  for (const t of setA) if (!setB.has(t)) diffA.push(t)
  for (const t of setB) if (!setA.has(t)) diffB.push(t)
  if (
    diffA.length > 0 &&
    diffB.length > 0 &&
    diffA.every((t) => ents.has(t)) &&
    diffB.every((t) => ents.has(t))
  ) {
    return false
  }

  if (shared >= 2 && jaccard >= 0.55) return true
  let sharedEntities = 0
  for (const t of setA) if (setB.has(t) && ents.has(t)) sharedEntities++
  if (shared >= 3 && jaccard >= 0.3 && sharedEntities >= 2) return true
  if (shared >= 3 && jaccard >= 0.4 && sharedEntities >= 1) return true
  return false
}

/**
 * Near-duplicate test against a STORED signature string (no original
 * casing available on the stored side, so entity boosting approximates).
 * Used by trigger-tz against notification-sent-history entries.
 *
 * Legacy guard: when the candidate differs from the stored signature by
 * EXACTLY ONE token and that token is an entity in the candidate (a
 * different city/person — "Russia strikes Kyiv" vs stored "…Lviv…"),
 * the events are distinct.
 */
export function isNearDuplicateSignature(candidateTitle: string, storedSig: string): boolean {
  if (!storedSig) return false
  const setA = titleKeywordSet(candidateTitle)
  if (setA.size < 3) return false
  const setB = new Set(storedSig.split(' '))
  let shared = 0
  for (const t of setA) if (setB.has(t)) shared++
  if (shared < 2) return false
  const union = setA.size + setB.size - shared
  const jaccard = union ? shared / union : 0
  if (setA.size - shared === 1) {
    const ents = entityTokens(candidateTitle)
    for (const t of setA) {
      if (!setB.has(t) && ents.has(t)) return false
    }
  }
  // Signature-mode cannot verify entities; require a bit more overlap.
  return (shared >= 2 && jaccard >= 0.55) || (shared >= 3 && jaccard >= 0.45)
}

/**
 * Greedy near-duplicate drop for an ALREADY-RANKED topic list (rank order
 * preserved; a topic is dropped when it near-duplicates one KEPT above it).
 * Used at news-cache room-write time so the feed, mesh snapshots, sitemap
 * AND briefing candidates all see one story per event.
 */
export function dropNearDuplicateTopics<T extends { title: string }>(topics: T[]): T[] {
  if (topics.length < 2) return topics
  const kept: T[] = []
  const keptSets: Array<Set<string>> = []
  const keptEnts: Array<Set<string>> = []
  for (const t of topics) {
    const kws = titleKeywordSet(t.title)
    if (kws.size >= 3) {
      const candEnts = entityTokens(t.title)
      let dup = false
      for (let i = 0; i < kept.length; i++) {
        let shared = 0
        for (const w of kws) if (keptSets[i].has(w)) shared++
        if (shared < 2) continue
        const union = kws.size + keptSets[i].size - shared
        const jaccard = union ? shared / union : 0

        // GUARD: entity-only differences on both sides → different
        // events (Kyiv vs Lviv); keep both.
        const diffCand: string[] = []
        const diffKept: string[] = []
        for (const w of kws) if (!keptSets[i].has(w)) diffCand.push(w)
        for (const w of keptSets[i]) if (!kws.has(w)) diffKept.push(w)
        if (
          diffCand.length > 0 &&
          diffKept.length > 0 &&
          diffCand.every((w) => keptEnts[i].has(w) || candEnts.has(w)) &&
          diffKept.every((w) => keptEnts[i].has(w) || candEnts.has(w))
        ) {
          continue
        }

        if (shared >= 2 && jaccard >= 0.55) { dup = true; break }
        // A shared token counts as a shared ENTITY when entity-ish in
        // EITHER title (union semantics — same as isNearDuplicateTitle).
        let sharedEntities = 0
        for (const w of kws) {
          if (keptSets[i].has(w) && (keptEnts[i].has(w) || candEnts.has(w))) sharedEntities++
        }
        if (shared >= 3 && jaccard >= 0.3 && sharedEntities >= 2) { dup = true; break }
        if (shared >= 3 && jaccard >= 0.4 && sharedEntities >= 1) { dup = true; break }
      }
      if (dup) continue
      keptSets.push(kws)
      keptEnts.push(candEnts)
    }
    kept.push(t)
  }
  return kept
}
