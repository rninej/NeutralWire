import { trackRequest } from '@/lib/usage-meter'
import { NextRequest, NextResponse } from 'next/server'
import {
  detectCountryServer,
  DEFAULT_COUNTRY,
} from '@/lib/country-detect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Returns the detected country for the current visitor.
 *
 * The client uses this to:
 *  - Power the "My Country" tab (filter news to local sources)
 *  - Power the "Relevant" tab (mix local + world)
 *
 * If server-side detection fails (e.g. localhost, network error),
 * the client falls back to ipwho.is directly.
 */
async function GET$(req: NextRequest) {
  const info = await detectCountryServer(req.headers)
  if (info) {
    return NextResponse.json({ ...info, detected: true })
  }
  // Fall back to "International" — the client will try to detect via
  // ipwho.is as a last resort.
  return NextResponse.json({ ...DEFAULT_COUNTRY, detected: false })
}

// ── usage-meter (Nov 16, 2026 emergency CPU attribution) ──
export const GET = trackRequest(
  'api/country',
  GET$,
)
