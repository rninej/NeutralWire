import { trackRequest } from '@/lib/usage-meter'
import { NextResponse } from 'next/server'
import { VAPID_PUBLIC_KEY } from '@/lib/vapid'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Returns the VAPID public key. The client uses this to subscribe to
 * push notifications via the Push API.
 */
async function GET$() {
  return NextResponse.json({ publicKey: VAPID_PUBLIC_KEY })
}

// ── usage-meter (Nov 16, 2026 emergency CPU attribution) ──
export const GET = trackRequest(
  'api/push/vapid',
  GET$,
)
