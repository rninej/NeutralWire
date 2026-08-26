import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import { createHash, timingSafeEqual } from 'crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 15

/**
 * Server-side feature flags (stored in Firebase at featureFlags/<name>).
 *
 * GET  /api/flags          → { subtopicNav: 'cards' | 'classic' }   (public)
 * POST /api/flags          → set a flag for ALL users (password-protected)
 *        body: { password, subtopicNav: 'cards' | 'classic' }
 *
 * Currently managed flags:
 *   - subtopicNav: which category-header design every visitor sees.
 *       'cards'   → new CategoryNav (big icon chips, scrollable row) — DEFAULT
 *       'classic' → the old small wrapping text pills
 *
 * The flag is flipped from /debug in one click; every client fetches this
 * endpoint on load (tiny payload, per-instance 10s memo) so a flip
 * propagates to all users within seconds.
 *
 * AUTH for POST: same password gate as the analytics endpoints — SHA-256
 * hash comparison, timing-safe.
 */

// SHA-256 hash of the admin password (same one as /api/analytics/query).
const PASSWORD_HASH = '5c2113db1bd51e6e6fce4205d8eb36e41f5018d5d32d4c04b294fb02192f474a'

export type SubtopicNavMode = 'cards' | 'classic'

const VALID_MODES: SubtopicNavMode[] = ['cards', 'classic']
const FLAG_PATH = 'featureFlags/subtopicNav'

// Per-instance memo (10s) — bounds Firebase reads when many clients hit
// this endpoint simultaneously on a warm serverless instance.
let memo: { value: SubtopicNavMode; ts: number } | null = null
const MEMO_TTL_MS = 10 * 1000

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function verifyPassword(input: string): boolean {
  const inputHash = sha256(input)
  if (inputHash.length !== PASSWORD_HASH.length) return false
  try {
    return timingSafeEqual(Buffer.from(inputHash), Buffer.from(PASSWORD_HASH))
  } catch {
    return false
  }
}

function normalizeMode(v: unknown): SubtopicNavMode {
  return v === 'classic' ? 'classic' : 'cards'
}

export async function GET() {
  try {
    if (memo && Date.now() - memo.ts < MEMO_TTL_MS) {
      return NextResponse.json(
        { subtopicNav: memo.value },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }
    const stored = await firebaseRead<string>(FLAG_PATH)
    const value = normalizeMode(stored)
    memo = { value, ts: Date.now() }
    return NextResponse.json(
      { subtopicNav: value },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch {
    // Firebase unreachable → default to the new design
    return NextResponse.json(
      { subtopicNav: 'cards' as SubtopicNavMode },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }
}

export async function POST(req: NextRequest) {
  let body: { password?: string; subtopicNav?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.password || !verifyPassword(body.password)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const mode = body.subtopicNav
  if (!VALID_MODES.includes(mode as SubtopicNavMode)) {
    return NextResponse.json(
      { error: `subtopicNav must be one of: ${VALID_MODES.join(', ')}` },
      { status: 400 },
    )
  }

  const ok = await firebaseWrite(FLAG_PATH, mode)
  if (!ok) {
    return NextResponse.json({ error: 'Firebase write failed' }, { status: 500 })
  }
  memo = { value: mode as SubtopicNavMode, ts: Date.now() }
  console.log(`[flags] subtopicNav set to '${mode}' (applies to ALL users)`)
  return NextResponse.json({ ok: true, subtopicNav: mode })
}
