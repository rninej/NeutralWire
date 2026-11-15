import { trackRequest } from '@/lib/usage-meter'
import { NextRequest, NextResponse } from 'next/server'
import { destroySession, clearSessionCookie } from '@/lib/subscriptions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * POST /api/auth/logout — destroy the session server-side + clear cookie.
 */
async function POST$(req: NextRequest) {
  await destroySession(req)
  return clearSessionCookie(NextResponse.json({ ok: true }))
}

// ── usage-meter (Nov 16, 2026 emergency CPU attribution) ──
export const POST = trackRequest(
  'api/auth/logout',
  POST$,
)
