import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import { verifyAdminPassword } from '@/lib/admin-auth'
import type { TopicArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 15

/**
 * User bug-report pipeline (long-press a news card → Report).
 *
 * POST /api/report   (public)  — a reader reports a problem with a story.
 *   body: { type, note?, topic, deviceId? }
 *   The full topic SNAPSHOT travels with the report, so /debug (and the
 *   AI fixer) see exactly what the user saw even after the live cache
 *   rotates away.
 *
 *   Report types:
 *     photo | title | summary | sources | video | summary-missing | other
 *
 *   The report id is a hash of (topicId + type + deviceId) — reporting
 *   the same problem twice from the same device just refreshes it (no
 *   spam duplicates, no counter inflation).
 *
 * GET /api/report    (admin)   — list open + fixed reports, newest first.
 *   ?password=<admin pw>
 *
 * DELETE /api/report (admin)   — dismiss a report (body: { reportId, password }).
 *   Dismissed reports stay in Firebase (history) but leave /debug.
 */

export type ReportType =
  | 'photo'
  | 'title'
  | 'summary'
  | 'sources'
  | 'video'
  | 'summary-missing'
  | 'other'

const VALID_TYPES: ReportType[] = [
  'photo',
  'title',
  'summary',
  'sources',
  'video',
  'summary-missing',
  'other',
]

export interface BugReport {
  id: string
  type: ReportType
  note: string
  deviceId: string
  createdAt: number
  updatedAt: number
  status: 'open' | 'fixed' | 'dismissed'
  /** Full topic snapshot as the user saw it (with articles). */
  topic: TopicArticle
  /** Filled after /debug "Make AI Fix" runs: what the AI did. */
  fixedAt?: number
  aiNote?: string
  aiModel?: string
}

type FeedArticleLeaning = TopicArticle['articles'][number]['leaning']

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

function slimTopic(raw: unknown): TopicArticle | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Partial<TopicArticle>
  if (!t.topicId || !t.title) return null
  return {
    topicId: String(t.topicId).slice(0, 64),
    title: String(t.title).slice(0, 300),
    summary: String(t.summary || '').slice(0, 2000),
    imageUrl: typeof t.imageUrl === 'string' ? t.imageUrl.slice(0, 1000) : null,
    coverage: Number(t.coverage) || 1,
    leanLeft: Number(t.leanLeft) || 0,
    leanCenter: Number(t.leanCenter) || 0,
    leanRight: Number(t.leanRight) || 0,
    firstSeen: Number(t.firstSeen) || 0,
    latestSeen: Number(t.latestSeen) || 0,
    articles: Array.isArray(t.articles)
      ? t.articles.slice(0, 30).map((a) => ({
          id: String(a?.id || '').slice(0, 128),
          title: String(a?.title || '').slice(0, 300),
          link: String(a?.link || '').slice(0, 1000),
          description: String(a?.description || '').slice(0, 1000),
          pubDate: a?.pubDate ?? null,
          iso: Number(a?.iso) || 0,
          imageUrl: typeof a?.imageUrl === 'string' ? a.imageUrl.slice(0, 1000) : null,
          sourceId: String(a?.sourceId || '').slice(0, 64),
          sourceName: String(a?.sourceName || '').slice(0, 100),
          sourceHomepage: String(a?.sourceHomepage || '').slice(0, 500),
          leaning: (a?.leaning as FeedArticleLeaning) || 'center',
          country: String(a?.country || '').slice(0, 40),
          category: String(a?.category || '').slice(0, 64),
        }))
      : [],
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      type?: string
      note?: string
      topic?: unknown
      deviceId?: string
    }

    const type = VALID_TYPES.includes(body.type as ReportType)
      ? (body.type as ReportType)
      : null
    if (!type) {
      return NextResponse.json({ error: 'Invalid report type' }, { status: 400 })
    }

    const topic = slimTopic(body.topic)
    if (!topic) {
      return NextResponse.json({ error: 'Missing topic data' }, { status: 400 })
    }

    const deviceId = String(body.deviceId || '').slice(0, 48) || 'anon'
    const note = String(body.note || '').slice(0, 500)
    const id = hash(`${topic.topicId}|${type}|${deviceId}`)
    const now = Date.now()

    const report: BugReport = {
      id,
      type,
      note,
      deviceId,
      createdAt: now,
      updatedAt: now,
      status: 'open',
      topic,
    }

    // Preserve original createdAt + any AI fix when the same report is
    // re-sent (idempotent key) — a re-report only bumps updatedAt.
    try {
      const existing = await firebaseRead<BugReport>(`reports/${id}`)
      if (existing) {
        report.createdAt = existing.createdAt
        report.status = existing.status
        report.fixedAt = existing.fixedAt
        report.aiNote = existing.aiNote
        report.aiModel = existing.aiModel
      }
    } catch {
      // fresh write below
    }

    await firebaseWrite(`reports/${id}`, report)
    return NextResponse.json({ ok: true, reportId: id })
  } catch (err) {
    console.warn('[api/report] error:', err)
    return NextResponse.json({ error: 'Failed to save report' }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const password = req.nextUrl.searchParams.get('password') || ''
  if (!password || !verifyAdminPassword(password)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const all = await firebaseRead<Record<string, BugReport>>('reports')
    const list = Object.values(all || {})
      .filter((r) => r && r.status !== 'dismissed')
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 100)
    return NextResponse.json(
      { reports: list, total: list.length },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    console.warn('[api/report] list error:', err)
    return NextResponse.json({ error: 'Failed to list reports' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = (await req.json()) as { reportId?: string; password?: string }
    if (!body.reportId || !body.password || !verifyAdminPassword(body.password)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const reportId = String(body.reportId).replace(/[^a-z0-9]/gi, '')
    const existing = await firebaseRead<BugReport>(`reports/${reportId}`)
    if (!existing) {
      return NextResponse.json({ error: 'Report not found' }, { status: 404 })
    }
    await firebaseWrite(`reports/${reportId}`, {
      ...existing,
      status: 'dismissed',
      updatedAt: Date.now(),
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.warn('[api/report] delete error:', err)
    return NextResponse.json({ error: 'Failed to dismiss report' }, { status: 500 })
  }
}
