import { NextResponse } from 'next/server'
import { VAPID_PUBLIC_KEY } from '@/lib/vapid'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Returns the VAPID public key. The client uses this to subscribe to
 * push notifications via the Push API.
 */
export async function GET() {
  return NextResponse.json({ publicKey: VAPID_PUBLIC_KEY })
}
