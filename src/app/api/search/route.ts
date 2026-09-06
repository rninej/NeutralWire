import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead } from '@/lib/firebase-server'
import {
  backfillSearchIndex,
  readSearchIndex,
  type SearchIndexEntry,
} from '@/lib/search-index'
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
  ms: number
}

/**
 * Server-side search across EVERY NeutralWire article ever.
 *
 * Two layers, both case-insensitive (query + text are lowercased):
 *   1. LIVE cache — every category node under newsCache/ (the last ~48h).
 *   2. PERMANENT ARCHIVE — the searchIndex over archive/<topicId> (every
 *      story ever archived, as old as the site). The index is backfilled
 *      lazily here, so the first few searches after deploy converge the
 *      historical backlog.
 *
 * This is what the client falls back to when the in-page client-side
 * search (which only filters currently-displayed topics) yields no
 * results — and it also feeds the "More from the archive" section when
 * local results exist.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const q = (sp.get('q') || '').trim().toLowerCase()
  const maxHits = Math.min(60, Math.max(5, Number(sp.get('limit') || '20')))

  const t0 = Date.now()

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
    const titleMatch = topic.title.toLowerCase().includes(q)
    const summaryMatch = (topic.summary || '').toLowerCase().includes(q)
    if (!titleMatch && !summaryMatch) {
      // Search articles within the topic
      if (topic.articles) {
        for (const article of topic.articles) {
          const artTitleMatch = article.title.toLowerCase().includes(q)
          const artDescMatch = (article.description || '').toLowerCase().includes(q)
          const sourceMatch = (article.sourceName || '').toLowerCase().includes(q)
          if (artTitleMatch || artDescMatch || sourceMatch) {
            seenTopicIds.add(topic.topicId)
            hits.push({
              topic: { ...topic, articles: [] },
              article,
              matchedField: artTitleMatch ? 'title' : sourceMatch ? 'source' : 'summary',
              snippet: artTitleMatch
                ? article.title
                : sourceMatch
                  ? article.sourceName
                  : makeSnippet(article.description || '', q),
              fromArchive: false,
            })
            return
          }
        }
      }
      return
    }
    seenTopicIds.add(topic.topicId)
    hits.push({
      topic: { ...topic, articles: [] },
      article: {
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
      matchedField: titleMatch ? 'title' : 'summary',
      snippet: titleMatch ? topic.title : makeSnippet(topic.summary || '', q),
      fromArchive: false,
    })
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
        const t = entry.t.toLowerCase()
        const s = (entry.s || '').toLowerCase()
        const articleTitles = entry.at || []
        const titleMatch = t.includes(q)
        const summaryMatch = s.includes(q)
        const articleTitleMatch = !titleMatch && !summaryMatch &&
          articleTitles.some((at) => at.toLowerCase().includes(q))
        if (!titleMatch && !summaryMatch && !articleTitleMatch) continue

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
          matchedField: titleMatch || articleTitleMatch ? 'title' : 'summary',
          snippet: titleMatch
            ? entry.t
            : articleTitleMatch
              ? articleTitles.find((at) => at.toLowerCase().includes(q)) || entry.t
              : makeSnippet(entry.s || '', q),
          fromArchive: true,
        })
        if (hits.length >= maxHits) break
    }
  } catch {
    // archive layer is best-effort — live results still return
  }

  // Sort: title matches first, then by recency.
  hits.sort((a, b) => {
    if (a.matchedField === 'title' && b.matchedField !== 'title') return -1
    if (b.matchedField === 'title' && a.matchedField !== 'title') return 1
    return b.article.iso - a.article.iso
  })

  return NextResponse.json({
    query: q,
    hits: hits.slice(0, maxHits),
    total: hits.length,
    categoriesSearched,
    archiveSearched,
    indexedNow,
    ms: Date.now() - t0,
  } satisfies SearchResponse)
}

function makeSnippet(text: string, q: string): string {
  if (!text) return ''
  const lower = text.toLowerCase()
  const idx = lower.indexOf(q)
  if (idx < 0) return text.slice(0, 160)
  const start = Math.max(0, idx - 60)
  const end = Math.min(text.length, idx + q.length + 80)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}
