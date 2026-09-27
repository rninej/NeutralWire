import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import { verifyAdminPassword } from '@/lib/admin-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 15

/**
 * Mesh observability for /debug (admin-gated).
 *
 * GET /api/mesh/logs?password=<admin>
 *   → the last 100 mesh events visitors recorded in Firebase
 *     (fallbacks, verification failures, malformed payloads, relay
 *     switches, cron triggers — the "keep all bugs and unwanted
 *     switches as a record" requirement). Push-id keys sort
 *     chronologically; entries carry Firebase server timestamps.
 *
 * DELETE /api/mesh/logs?password=<admin>
 *   → clears the shared log (the local per-browser ring in localStorage
 *     is untouched).
 */

interface MeshLogEntry {
  ts?: number
  type?: string
  room?: string
  peerId?: string
  detail?: string
}

export async function GET(req: NextRequest) {
  const password = req.nextUrl.searchParams.get('password') || ''
  if (!password || !verifyAdminPassword(password)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const raw = await firebaseRead<Record<string, MeshLogEntry | null>>('meshLogs')
  if (!raw) {
    return NextResponse.json({ events: [], total: 0 })
  }

  // Push ids sort chronologically → newest last; newest-first output.
  const keys = Object.keys(raw).sort()
  const events = keys
    .map((id) => {
      const e = raw[id]
      return {
        id,
        ts: typeof e?.ts === 'number' ? e.ts : 0,
        type: typeof e?.type === 'string' ? e.type : 'unknown',
        room: typeof e?.room === 'string' ? e.room : '',
        peerId: typeof e?.peerId === 'string' ? e.peerId : '',
        detail: typeof e?.detail === 'string' ? e.detail.slice(0, 200) : '',
      }
    })
    .filter((e) => e.type !== 'unknown' || e.room !== '')
    .slice(-100)
    .reverse()

  return NextResponse.json({ events, total: keys.length })
}

export async function DELETE(req: NextRequest) {
  const password = req.nextUrl.searchParams.get('password') || ''
  if (!password || !verifyAdminPassword(password)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // PUT null removes the node.
  const ok = await firebaseWrite('meshLogs', null)
  if (!ok) {
    return NextResponse.json({ error: 'Firebase write failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, cleared: true })
}
