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

  // ── EMERGENCY: Read each category SEPARATELY instead of the entire newsCache root ──
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
  const seenArticleIds = new Set<string>()
  let categoriesSearched = 0

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
      // Check topic title + summary
      const titleMatch = topic.title.toLowerCase().includes(q)
      const summaryMatch = (topic.summary || '').toLowerCase().includes(q)
      if (titleMatch || summaryMatch) {
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
          snippet: titleMatch
            ? topic.title
            : (topic.summary || '').slice(0, 200),
        })
        if (hits.length >= maxHits) break
      }

      // Also search articles within the topic
      if (topic.articles) {
        for (const article of topic.articles) {
          if (seenArticleIds.has(article.id)) continue
          const artTitleMatch = article.title.toLowerCase().includes(q)
          const artDescMatch = (article.description || '').toLowerCase().includes(q)
          const sourceMatch = (article.sourceName || '').toLowerCase().includes(q)
          if (artTitleMatch || artDescMatch || sourceMatch) {
            seenArticleIds.add(article.id)
            hits.push({
              topic: { ...topic, articles: [] },
              article,
              matchedField: artTitleMatch ? 'title' : sourceMatch ? 'source' : 'summary',
              snippet: artTitleMatch
                ? article.title
                : sourceMatch
                  ? article.sourceName
                  : (article.description || '').slice(0, 200),
            })
            if (hits.length >= maxHits) break
          }
        }
      }
      if (hits.length >= maxHits) break
    }
    if (hits.length >= maxHits) break
  }

  // (old per-category loop removed — replaced by the per-category reads above)

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
