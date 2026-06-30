import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead } from '@/lib/firebase-server'
import type { CategoryCachePayload, TopicArticle, FeedArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

interface SearchHit {
  topic: TopicArticle
  article: FeedArticle
  matchedField: 'title' | 'summary' | 'source'
  snippet: string
}

interface SearchResponse {
  query: string
  hits: SearchHit[]
  total: number
  categoriesSearched: number
  ms: number
}

const ROOT = 'newsCache'

/**
 * Server-side search across ALL cached news articles in Firebase.
 *
 * Reads every category node under newsCache/ and iterates through every
 * article in every topic. Returns matching articles grouped by topic.
 *
 * This is what the client falls back to when the in-page client-side
 * search (which only filters currently-displayed topics) yields no results.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const q = (sp.get('q') || '').trim().toLowerCase()
  const maxHits = Math.min(50, Math.max(5, Number(sp.get('limit') || '20')))

  const t0 = Date.now()

  if (!q || q.length < 2) {
    return NextResponse.json({
      query: q,
      hits: [],
      total: 0,
      categoriesSearched: 0,
      ms: Date.now() - t0,
    } satisfies SearchResponse)
  }

  // Read the entire newsCache/ root in a single request. Firebase RTDB
  // returns the whole subtree as one JSON object — one round-trip.
  // For 7 categories × 40 topics × ~6 articles ≈ 1700 articles, this is
  // ~120KB which is fast enough on Firebase free tier.
  const all = await firebaseRead<Record<string, CategoryCachePayload>>(ROOT)
  if (!all) {
    return NextResponse.json({
      query: q,
      hits: [],
      total: 0,
      categoriesSearched: 0,
      ms: Date.now() - t0,
    } satisfies SearchResponse)
  }

  const hits: SearchHit[] = []
  const seenArticleIds = new Set<string>()
  let categoriesSearched = 0

  for (const [catKey, payload] of Object.entries(all)) {
    if (!payload || !Array.isArray(payload.topics)) continue
    categoriesSearched++

    for (const topic of payload.topics) {
      // Check topic title first — if it matches, include all the topic's
      // articles as hits (since they're all about the same story).
      const titleMatch = topic.title.toLowerCase().includes(q)
      const summaryMatch = topic.summary?.toLowerCase().includes(q)

      if (titleMatch || summaryMatch) {
        for (const article of topic.articles) {
          if (seenArticleIds.has(article.id)) continue
          seenArticleIds.add(article.id)
          hits.push({
            topic,
            article,
            matchedField: titleMatch ? 'title' : 'summary',
            snippet: titleMatch
              ? topic.title
              : makeSnippet(topic.summary || article.description, q),
          })
          if (hits.length >= maxHits) break
        }
      } else {
        // Search through individual articles in the topic.
        for (const article of topic.articles) {
          if (seenArticleIds.has(article.id)) continue
          const inTitle = article.title.toLowerCase().includes(q)
          const inDesc = article.description?.toLowerCase().includes(q)
          const inSource = article.sourceName.toLowerCase().includes(q)

          if (inTitle || inDesc || inSource) {
            seenArticleIds.add(article.id)
            hits.push({
              topic,
              article,
              matchedField: inTitle ? 'title' : inDesc ? 'summary' : 'source',
              snippet: inTitle
                ? article.title
                : makeSnippet(article.description || topic.summary, q),
            })
            if (hits.length >= maxHits) break
          }
        }
      }

      if (hits.length >= maxHits) break
    }
    if (hits.length >= maxHits) break
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
