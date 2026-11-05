import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead } from '@/lib/firebase-server'
import { readSearchIndex } from '@/lib/search-index'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 15

/**
 * GET /api/history?deviceId=<id> — the reader for Account → History
 * (owner request Nov 2026: "in account store your liked and disliked
 * news to be able to see in history").
 *
 * Two sources, merged by topicId:
 *   devices/<deviceId>/voteHistory/<topicId> = { v, ts, t, s, i, d }
 *     — the snapshot written at vote time by /api/engagement (Nov 2026
 *       onward). Self-contained: no extra reads needed.
 *   devices/<deviceId>/topicVotes/<topicId> = 'liked' | 'disliked'
 *     — LEGACY votes (pre-Nov-2026) with no snapshot. Best-effort
 *       resolve through the search index (title/summary/image/date for
 *       every archived story); unresolvable ones still count, shown as
 *       bare titles when even the index misses them.
 *
 * Response: { liked: Entry[], disliked: Entry[] }, each sorted by the
 * vote time (newest first). Entries carry the display snapshot — the
 * account page renders straight from the response.
 */

interface VoteHistoryEntry {
  v?: 'liked' | 'disliked'
  ts?: number
  t?: string
  s?: string
  i?: string | null
  d?: number
}

export async function GET(req: NextRequest) {
  const deviceId = (req.nextUrl.searchParams.get('deviceId') || '').trim().slice(0, 64)
  if (!deviceId) {
    return NextResponse.json({ error: 'Missing deviceId' }, { status: 400 })
  }

  try {
    const [history, legacyVotes] = await Promise.all([
      firebaseRead<Record<string, VoteHistoryEntry>>(`devices/${deviceId}/voteHistory`),
      firebaseRead<Record<string, 'liked' | 'disliked' | null>>(
        `devices/${deviceId}/topicVotes`,
      ),
    ])

    type Entry = {
      topicId: string
      v: 'liked' | 'disliked'
      ts: number
      t: string
      s: string
      i: string | null
      d: number
      /** True when the entry was reconstructed from the legacy vote map
       *  (vote time unknown — the story date is used). */
      legacy?: boolean
    }

    const entries: Entry[] = []
    const seen = new Set<string>()

    // 1. Snapshot-backed entries (Nov 2026 onward).
    for (const [topicId, e] of Object.entries(history || {})) {
      if (!e || (e.v !== 'liked' && e.v !== 'disliked')) continue
      seen.add(topicId)
      entries.push({
        topicId,
        v: e.v,
        ts: typeof e.ts === 'number' ? e.ts : 0,
        t: typeof e.t === 'string' ? e.t : '',
        s: typeof e.s === 'string' ? e.s : '',
        i: typeof e.i === 'string' && e.i.length > 0 ? e.i : null,
        d: typeof e.d === 'number' ? e.d : 0,
      })
    }

    // 2. Legacy votes the snapshot store doesn't cover — resolve through
    //    the search index (one memoized read; covers every archived story).
    const legacyIds = Object.entries(legacyVotes || {})
      .filter(([, v]) => v === 'liked' || v === 'disliked')
      .filter(([id]) => !seen.has(id))
    if (legacyIds.length > 0) {
      const index = await readSearchIndex().catch(() => ({} as Record<string, never>))
      for (const [topicId, v] of legacyIds as Array<[string, 'liked' | 'disliked']>) {
        const idx = (index as Record<string, { t?: string; s?: string; i?: string | null; d?: number } | undefined>)[topicId]
        entries.push({
          topicId,
          v,
          ts: idx?.d || 0,
          t: idx?.t || '',
          s: idx?.s || '',
          i: idx?.i || null,
          d: idx?.d || 0,
          legacy: true,
        })
      }
    }

    const sortDesc = (a: Entry, b: Entry) => (b.ts || b.d || 0) - (a.ts || a.d || 0)
    return NextResponse.json(
      {
        liked: entries.filter((e) => e.v === 'liked').sort(sortDesc),
        disliked: entries.filter((e) => e.v === 'disliked').sort(sortDesc),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    console.warn('[history] error:', err)
    return NextResponse.json({ error: 'History read failed' }, { status: 500 })
  }
}
