import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead } from '@/lib/firebase-server'
import {
  searchCatalog,
  SUBTOPIC_CATALOG,
  CATALOG_SIZE,
  type CatalogTopic,
} from '@/lib/subtopic-catalog'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * GET /api/subtopics?q=…&limit=…
 *
 * The searchable Premium subtopic catalog: the 550+ static entries PLUS
 * any AI-created runtime topics (Firebase `customSubtopics/`). Without a
 * query, returns the group headers + a default browsing page (first N
 * entries per group).
 */
interface RuntimeTopic {
  id: string
  label: string
  keywords: string[]
  group?: string
  createdAt?: number
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const q = (sp.get('q') || '').trim()
  const limit = Math.min(200, Math.max(10, Number(sp.get('limit') || '60')))

  // Runtime (AI-created) topics — one read, ETag-cached server-side.
  const runtime = (await firebaseRead<Record<string, RuntimeTopic>>('customSubtopics')) || {}
  const runtimeTopics: CatalogTopic[] = Object.values(runtime)
    .filter((t) => t?.label)
    .map((t) => ({
      id: t.id,
      label: t.label,
      keywords: Array.isArray(t.keywords) ? t.keywords : [],
      group: t.group || 'AI-Created',
    }))

  if (!q) {
    // Browse mode: a spread of entries across every group + all runtime.
    const byGroup = new Map<string, CatalogTopic[]>()
    for (const t of [...SUBTOPIC_CATALOG, ...runtimeTopics]) {
      const list = byGroup.get(t.group) || []
      if (list.length < Math.floor(limit / 4)) list.push(t)
      byGroup.set(t.group, list)
    }
    return NextResponse.json({
      query: '',
      catalogSize: CATALOG_SIZE + runtimeTopics.length,
      runtimeCount: runtimeTopics.length,
      groups: Object.fromEntries(byGroup),
      total: [...byGroup.values()].reduce((n, l) => n + l.length, 0),
    })
  }

  // Search mode: static + runtime matches.
  const staticHits = searchCatalog(q, limit)
  const seen = new Set(staticHits.map((t) => t.id))
  const ql = q.toLowerCase()
  const runtimeHits = runtimeTopics
    .filter(
      (t) =>
        !seen.has(t.id) &&
        (t.label.toLowerCase().includes(ql) ||
          t.keywords.some((k) => k.toLowerCase().includes(ql))),
    )
    .slice(0, limit)

  return NextResponse.json({
    query: q,
    catalogSize: CATALOG_SIZE + runtimeTopics.length,
    runtimeCount: runtimeTopics.length,
    hits: [...staticHits, ...runtimeHits],
    total: staticHits.length + runtimeHits.length,
    canCreate: staticHits.length + runtimeHits.length === 0,
  })
}
