import { NextRequest, NextResponse } from 'next/server'
import { firebasePatch } from '@/lib/firebase-server'
import { detectCountryServer } from '@/lib/country-detect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 10

/**
 * Analytics tracking endpoint.
 *
 * Receives a page-view ping from the client and stores it in Firebase under:
 *   analytics/events/<YYYY-MM-DD>/<eventId> = { ...payload }
 *
 * Daily buckets make time-range queries efficient — to get "last 7 days"
 * we read 7 day-nodes and merge.
 *
 * Country is detected SERVER-SIDE from the request IP (more accurate than
 * client-side, and doesn't expose precise location to the client).
 *
 * The event ID is a hash of deviceId+sessionId+ts so duplicate pings
 * (from sendBeacon retries) are naturally deduplicated.
 */

interface AnalyticsPayload {
  deviceId: string
  sessionId: string
  path: string
  referrer: string
  browser: string
  device: string
  os: string
  screen: string
  tz: string
  ts: number
}

// Simple hash for event IDs (not crypto-secure, just for dedup)
function hash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as AnalyticsPayload
    if (!body.deviceId || !body.ts) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    }

    // Detect country from IP (server-side, more accurate)
    const country = await detectCountryServer(req.headers).catch(() => null)
    const countryCode = country?.code || 'UNKNOWN'
    const countryName = country?.name || 'Unknown'

    // Build the event record
    const event = {
      deviceId: body.deviceId.slice(0, 40),
      sessionId: body.sessionId.slice(0, 40),
      path: (body.path || '/').slice(0, 200),
      referrer: (body.referrer || '').slice(0, 300),
      browser: body.browser || 'Unknown',
      device: body.device || 'Unknown',
      os: body.os || 'Unknown',
      screen: body.screen || '',
      tz: body.tz || '',
      country: countryCode,
      countryName,
      ts: body.ts,
    }

    // Store under daily bucket: analytics/events/<YYYY-MM-DD>/<eventId>
    const date = new Date(body.ts).toISOString().slice(0, 10)
    const eventId = hash(body.deviceId + body.sessionId + body.ts + body.path)

    await firebasePatch(`analytics/events/${date}/${eventId}`, event)

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.warn('[analytics/track] error:', err)
    return NextResponse.json(
      { error: 'Tracking failed' },
      { status: 500 },
    )
  }
}
