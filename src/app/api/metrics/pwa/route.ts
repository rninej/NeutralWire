import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import { createHash } from 'crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 15

/**
 * PWA growth metrics — unique-IP counting.
 *
 * POST /api/metrics/pwa   body: { type: 'install' | 'active' | 'app-open' }
 *   Records ONE event, deduplicated by the caller's IP address:
 *     install   → pwaMetrics/installs/<YYYY-MM-DD>/<ipHash> = 1
 *     active    → pwaMetrics/dau/<YYYY-MM-DD>/<ipHash>      = 1
 *     app-open  → pwaMetrics/appDau/<YYYY-MM-DD>/<ipHash>   = 1
 *
 *   Because the ipHash is the KEY, the same IP firing twice the same day
 *   simply overwrites the same key — "downloads" and "daily active users"
 *   therefore only ever count DISTINCT IP addresses per day, exactly as
 *   the /debug dashboard expects.
 *
 *   Privacy: the raw IP is never stored — only a salted SHA-256 hash
 *   (first 24 hex chars). The salt is non-secret, it exists purely so
 *   the stored value is not a reversible dictionary target.
 *
 *   Consent: 'active' / 'app-open' pings are non-necessary analytics —
 *   the client only sends them after the visitor accepted cookies (same
 *   rule as the page-view tracker). 'install' is a functional event
 *   (the app WAS installed) and follows the same precedent as the
 *   existing /api/pwa-installed reporting.
 *
 * GET /api/metrics/pwa  (public, no password)
 *   Returns ONLY the aggregate total install count:
 *     { installs: <number of distinct ipHashes, all-time> }
 *   Used by the install sheet as honest social proof ("join N readers
 *   who added NeutralWire to their home screen"). No per-IP data, no
 *   daily breakdown, nothing sensitive — just one number.
 */

const SALT = 'nw-ip-v1'
const ROOT = 'pwaMetrics'

function hashIp(ip: string): string {
  return createHash('sha256').update(SALT + '|' + ip).digest('hex').slice(0, 24)
}

function extractIp(req: NextRequest): string {
  // Vercel: x-forwarded-for = "client-ip, proxy1, proxy2" — first entry.
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0].trim()
    if (first) return first
  }
  return req.headers.get('x-real-ip') || 'unknown'
}

function todayKey(ts?: number): string {
  return new Date(ts || Date.now()).toISOString().slice(0, 10)
}

const VALID_TYPES = new Set(['install', 'active', 'app-open'])

// ── Public aggregate count (in-memory memo, 5 min) ──
// Bounded Firebase reads when many install sheets hit a warm instance.
let installsMemo: { value: number; ts: number } | null = null
const MEMO_TTL_MS = 5 * 60 * 1000

async function countAllTimeInstalls(): Promise<number> {
  if (installsMemo && Date.now() - installsMemo.ts < MEMO_TTL_MS) {
    return installsMemo.value
  }
  const days = await firebaseRead<Record<string, Record<string, number>>>(
    `${ROOT}/installs`,
  )
  // Union of distinct ipHash keys across every day — an IP that installed
  // on two devices (two days) still counts once, all-time.
  const unique = new Set<string>()
  if (days) {
    for (const day of Object.values(days)) {
      if (day) for (const key of Object.keys(day)) unique.add(key)
    }
  }
  const value = unique.size
  installsMemo = { value, ts: Date.now() }
  return value
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { type?: string; ts?: number }
    const type = body.type
    if (!type || !VALID_TYPES.has(type)) {
      return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
    }

    const ipHash = hashIp(extractIp(req))
    const day = todayKey(body.ts)

    const bucket =
      type === 'install' ? 'installs' : type === 'active' ? 'dau' : 'appDau'

    // Idempotent write: same IP + same day → same key → overwrite, no
    // double count.
    const ok = await firebaseWrite(`${ROOT}/${bucket}/${day}/${ipHash}`, 1)

    if (!ok) {
      return NextResponse.json({ error: 'Write failed' }, { status: 502 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.warn('[metrics/pwa] error:', err)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}

export async function GET() {
  try {
    const installs = await countAllTimeInstalls()
    return NextResponse.json(
      { installs },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch {
    return NextResponse.json({ installs: 0 })
  }
}
