import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead } from '@/lib/firebase-server'
import {
  backfillSearchIndex,
  readSearchIndex,
  type SearchIndexEntry,
} from '@/lib/search-index'
import { queryTokens, scoreCandidate, snippetAroundTokens } from '@/lib/search-match'
import { getRequesterTier } from '@/lib/subscriptions'
import type { CategoryCachePayload, TopicArticle, FeedArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
// Generous ceiling: the archive index backfill (first searches after
// deploy) reads up to 80 archived topics in batches before searching.
export const maxDuration = 60

interface SearchHit {
  topic: TopicArticle
  article: FeedArticle
  matchedField: 'title' | 'summary' | 'source'
  snippet: string
  /** true when the hit comes from the permanent archive (older story). */
  fromArchive?: boolean
  /** true when this archive story is older than 3 months AND the visitor
   *  is not Premium — the UI shows it but opens the upgrade prompt when
   *  clicked (direct story links are NEVER affected; the gate exists only
   *  here, in search results). */
  premiumLocked?: boolean
}

interface SearchResponse {
  query: string
  hits: SearchHit[]
  total: number
  categoriesSearched: number
  /** Number of permanently-archived stories scanned (the "ever" catalog). */
  archiveSearched: number
  /** How many archive entries were newly indexed by this request. */
  indexedNow: number
  /** The visitor's tier (so the UI can explain the lock state). */
  premiumTier?: string
  ms: number
}

/**
 * Server-side search across EVERY NeutralWire article ever.
 *
 * Two layers, both scored by lib/search-match.ts (token-overlap):
 *   1. LIVE cache — every category node under newsCache/ (the last ~48h).
 *   2. PERMANENT ARCHIVE — the searchIndex over archive/<topicId> (every
 *      story ever archived, as old as the site). The index is backfilled
 *      lazily here, so the first few searches after deploy converge the
 *      historical backlog.
 *
 * MATCHING (Oct 2026 — the cross-source upgrade): pure substring search
 * could never find a NeutralWire story from ANOTHER outlet's headline
 * (different phrasing on every wire). Now the query is tokenized and
 * scored against the topic title, the summary, EVERY outlet headline in
 * the cluster, and article descriptions — so pasting e.g. the BBC's own
 * headline surfaces the NeutralWire story that used the BBC article.
 * Exact substring matches still rank first (score bonus), and
 * single-word queries behave exactly as before.
 *
 * This is what the client falls back to when the in-page client-side
 * search (which only filters currently-displayed topics) yields no
 * results — and it also feeds the "More from the archive" section when
 * local results exist.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const qRaw = (sp.get('q') || '').trim()
  const q = qRaw.toLowerCase()
  const maxHits = Math.min(60, Math.max(5, Number(sp.get('limit') || '20')))
  const tokens = queryTokens(qRaw)

  const t0 = Date.now()

  // ── Premium archive gate ──
  // Archive stories older than 3 months: still LISTED in search results
  // (title, date, summary) but `premiumLocked` tells the UI to open the
  // upgrade prompt instead of the story when the visitor isn't Premium.
  // Lives ONLY here — direct /story/<id> links (notifications, Google,
  // old shares) remain fully open for everyone, per the spec.
  const requester = await getRequesterTier(req)
  const archiveUnlocked = requester.allUnlocked || requester.tier !== 'free'
  const ARCHIVE_LOCK_MS = 91 * 24 * 60 * 60 * 1000 // ~3 months
  const lockIfOld = (iso: number, fromArchive: boolean): boolean =>
    !archiveUnlocked && fromArchive && iso > 0 && Date.now() - iso > ARCHIVE_LOCK_MS

  if (!q || q.length < 2) {
    // Useless query — still nudge the index toward convergence.
    void backfillSearchIndex(40).catch(() => {})
    return NextResponse.json({
      query: q,
      hits: [],
      total: 0,
      categoriesSearched: 0,
      archiveSearched: 0,
      indexedNow: 0,
      ms: Date.now() - t0,
    } satisfies SearchResponse)
  }

  // ── Read each live category SEPARATELY instead of the entire newsCache root ──
  // Reading the entire newsCache node downloads ALL categories at once —
  // with 60 topics × 10+ categories × full article arrays, this was 17MB!
  // Now we read each category individually and only search the most common ones.
  // This reduces the download from ~17MB to ~2MB (10 categories × ~200KB each).
  const searchCategories = [
    'relevant__GB', 'relevant__US', 'relevant__INT',
    'mycountry__GB', 'top', 'world', 'politics',
    'business', 'technology', 'science', 'health', 'sports',
  ]

  const hits: SearchHit[] = []
  const seenTopicIds = new Set<string>()
  let categoriesSearched = 0

  // ── Layer 1: live cache ──
  for (const catKey of searchCategories) {
    let payload: CategoryCachePayload | null
    try {
      payload = await firebaseRead<CategoryCachePayload>(`newsCache/${catKey}`)
    } catch {
      continue
    }
    if (!payload || !Array.isArray(payload.topics)) continue

    categoriesSearched++

    for (const topic of payload.topics) {
      if (!topic) continue
      collectLiveHit(topic, catKey)
      if (hits.length >= maxHits) break
    }
    if (hits.length >= maxHits) break
  }

  function collectLiveHit(topic: TopicArticle, catKey: string) {
    if (seenTopicIds.has(topic.topicId)) return
    // Null-safe: GDELT/AI-filled topics can carry missing titles — a bare
    // .toLowerCase() on those 500'd the whole search endpoint.
    const articles = topic.articles || []
    const m = scoreCandidate(tokens, qRaw, {
      title: topic.title || '',
      summary: topic.summary || '',
      articleTitles: articles.map((a) => a.title || ''),
      descriptions: articles.map((a) => a.description || ''),
    })
    if (!m) return
    seenTopicIds.add(topic.topicId)

    // Which article matched best? (the cross-source path: the pasted
    // headline belongs to ONE outlet — surface that outlet's link.)
    let bestArticle: FeedArticle | null = null
    let bestArticleHits = -1
    for (const article of articles) {
      let hitsN = 0
      for (const tok of tokens) {
        if ((article.title || '').toLowerCase().includes(tok)) hitsN++
      }
      if (hitsN > bestArticleHits) {
        bestArticleHits = hitsN
        bestArticle = article
      }
    }

    hits.push({
      topic: { ...topic, articles: [] },
      article:
        bestArticle ||
        {
          id: topic.topicId,
          title: topic.title,
          link: '',
          description: topic.summary || '',
          pubDate: null,
          iso: topic.latestSeen || 0,
          imageUrl: topic.imageUrl,
          sourceId: '',
          sourceName: '',
          sourceHomepage: '',
          leaning: 'center',
          country: '',
          category: catKey,
        },
      matchedField: m.titleMatched > 0 || m.articleMatched > 0 ? 'title' : 'summary',
      snippet:
        m.titleMatched > 0
          ? topic.title || ''
          : bestArticle && bestArticleHits > 0
            ? bestArticle.title
            : snippetAroundTokens(topic.summary || bestArticle?.description || '', tokens),
      fromArchive: false,
      // score rides along for the final sort (stripped before responding)
      ...(m as object),
    } as SearchHit)
  }

  // ── Layer 2: permanent archive (every story EVER) ──
  // Backfill missing entries first (usually 0, instant), then scan the
  // flat index. Live-cache hits win duplicates (fresher copy).
  let archiveSearched = 0
  let indexedNow = 0
  try {
    indexedNow = await backfillSearchIndex(80)
    const index = await readSearchIndex()
    for (const [topicId, entry] of Object.entries(index)) {
        if (!entry || !entry.t) continue // tombstones / junk
        archiveSearched++
        if (seenTopicIds.has(topicId)) continue // already found live
        const articleTitles = entry.at || []
        const m = scoreCandidate(tokens, qRaw, {
          title: entry.t,
          summary: entry.s || '',
          articleTitles,
        })
        if (!m) continue

        seenTopicIds.add(topicId)
        const archiveTopic: TopicArticle = {
          topicId,
          title: entry.t,
          summary: entry.s || '',
          imageUrl: entry.i ?? null,
          coverage: entry.c || 1,
          leanLeft: entry.ll || 0,
          leanCenter: entry.lc || 0,
          leanRight: entry.lr || 0,
          firstSeen: entry.d || 0,
          latestSeen: entry.d || 0,
          articles: [],
        }
        // The pasted headline usually belongs to one archived outlet —
        // surface that outlet's own headline as the snippet.
        let bestAt = ''
        let bestAtHits = -1
        for (const at of articleTitles) {
          let hitsN = 0
          for (const tok of tokens) {
            if (at.toLowerCase().includes(tok)) hitsN++
          }
          if (hitsN > bestAtHits) {
            bestAtHits = hitsN
            bestAt = at
          }
        }
        hits.push({
          topic: archiveTopic,
          article: {
            id: topicId,
            title: entry.t,
            link: '',
            description: entry.s || '',
            pubDate: null,
            iso: entry.d || 0,
            imageUrl: entry.i ?? null,
            sourceId: '',
            sourceName: '',
            sourceHomepage: '',
            leaning: 'center',
            country: '',
            category: 'archive',
          },
          matchedField: m.titleMatched > 0 || m.articleMatched > 0 ? 'title' : 'summary',
          snippet:
            m.titleMatched > 0
              ? entry.t
              : bestAtHits > 0
                ? bestAt
                : snippetAroundTokens(entry.s || '', tokens),
          fromArchive: true,
          ...(m as object),
        } as SearchHit)
        if (hits.length >= maxHits) break
    }
  } catch {
    // archive layer is best-effort — live results still return
  }

  // Sort: relevance score first (exact substring + token coverage), then
  // title-matched over summary-matched, then recency.
  hits.sort((a, b) => {
    const sa = (a as SearchHit & { score?: number }).score || 0
    const sb = (b as SearchHit & { score?: number }).score || 0
    if (sa !== sb) return sb - sa
    if (a.matchedField === 'title' && b.matchedField !== 'title') return -1
    if (b.matchedField === 'title' && a.matchedField !== 'title') return 1
    return b.article.iso - a.article.iso
  })

  // Stamp the premium lock AFTER sorting so it can't change ranking —
  // and strip the private score fields from the payload.
  const cleanHits = hits.slice(0, maxHits).map((hit) => {
    const { coverage, matched, total, titleMatched, articleMatched, exact, score, ...clean } =
      hit as SearchHit & {
        coverage?: number
        matched?: number
        total?: number
        titleMatched?: number
        articleMatched?: number
        exact?: boolean
        score?: number
      }
    clean.premiumLocked = lockIfOld(
      clean.article.iso || clean.topic.latestSeen || 0,
      clean.fromArchive === true,
    )
    return clean
  })

  return NextResponse.json({
    query: q,
    hits: cleanHits,
    total: hits.length,
    categoriesSearched,
    archiveSearched,
    indexedNow,
    premiumTier: requester.tier,
    ms: Date.now() - t0,
  } satisfies SearchResponse)
}
