import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead } from '@/lib/firebase-server'
import { createHash, timingSafeEqual } from 'crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 15

/**
 * Analytics query endpoint (password-protected).
 *
 * Reads analytics events from Firebase for a given time range and returns
 * aggregated stats:
 *   - totalPageViews
 *   - uniqueUsers (distinct deviceIds)
 *   - uniqueSessions (distinct sessionIds)
 *   - byBrowser: { Chrome: 123, Safari: 45, ... }
 *   - byDevice: { Mobile: 100, Desktop: 50, ... }
 *   - byOS: { iOS: 80, Android: 40, Windows: 30, ... }
 *   - byCountry: { GB: 50, US: 30, IN: 20, ... }
 *   - byPath: { '/': 200, '/?topic=xxx': 10, ... }
 *   - byHour: [0, 1, 2, ... 23] — page views per hour of day
 *   - byDay: [{ date: '2025-01-01', views: 100, users: 50 }, ...]
 *   - topReferrers: { 'google.com': 30, 'twitter.com': 10, ... }
 *
 * AUTH: password is verified via SHA-256 hash comparison. The password
 * is NOT stored in plain text anywhere in the codebase — only its hash
 * is. This means even if someone reads the source code on GitHub, they
 * cannot derive the password from the hash (SHA-256 is one-way).
 *
 * The client sends the password in the request body; the server hashes
 * it with SHA-256 and compares using timing-safe comparison (prevents
 * timing attacks that could reveal the hash byte-by-byte).
 */

// SHA-256 hash of the analytics password.
// Generated with: createHash('sha256').update(PASSWORD).digest('hex')
// This is a ONE-WAY hash — the password cannot be derived from it.
// Even if this file is public on GitHub, the password stays secret.
const PASSWORD_HASH = '5c2113db1bd51e6e6fce4205d8eb36e41f5018d5d32d4c04b294fb02192f474a'

interface AnalyticsEvent {
  deviceId: string
  sessionId: string
  path: string
  referrer: string
  browser: string
  device: string
  os: string
  screen: string
  tz: string
  country: string
  countryName: string
  ts: number
}

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

/**
 * Generate all date strings (YYYY-MM-DD) between two timestamps (inclusive).
 */
function dateRange(fromTs: number, toTs: number): string[] {
  const dates: string[] = []
  const start = new Date(fromTs)
  start.setUTCHours(0, 0, 0, 0)
  const end = new Date(toTs)
  end.setUTCHours(0, 0, 0, 0)
  const cursor = new Date(start)
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
    if (dates.length > 90) break // safety cap
  }
  return dates
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      password: string
      fromTs: number
      toTs: number
    }

    if (!body.password || !verifyPassword(body.password)) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 },
      )
    }

    const fromTs = body.fromTs || (Date.now() - 7 * 24 * 60 * 60 * 1000)
    const toTs = body.toTs || Date.now()

    // Read all day-buckets in the range (parallel)
    const dates = dateRange(fromTs, toTs)
    const dayResults = await Promise.all(
      dates.map((d) => firebaseRead<Record<string, AnalyticsEvent>>(`analytics/events/${d}`)),
    )

    // Merge all events
    const allEvents: AnalyticsEvent[] = []
    for (const day of dayResults) {
      if (day) {
        for (const ev of Object.values(day)) {
          if (ev && ev.ts >= fromTs && ev.ts <= toTs) {
            allEvents.push(ev)
          }
        }
      }
    }

    // Aggregate
    const uniqueDevices = new Set<string>()
    const uniqueSessions = new Set<string>()
    const byBrowser = new Map<string, number>()
    const byDevice = new Map<string, number>()
    const byOS = new Map<string, number>()
    const byCountry = new Map<string, { count: number; name: string }>()
    const byPath = new Map<string, number>()
    const byHour = new Array(24).fill(0)
    const byDayMap = new Map<string, { views: number; users: Set<string> }>()
    const byReferrer = new Map<string, number>()

    for (const ev of allEvents) {
      uniqueDevices.add(ev.deviceId)
      uniqueSessions.add(ev.sessionId)

      byBrowser.set(ev.browser, (byBrowser.get(ev.browser) || 0) + 1)
      byDevice.set(ev.device, (byDevice.get(ev.device) || 0) + 1)
      byOS.set(ev.os, (byOS.get(ev.os) || 0) + 1)

      const country = byCountry.get(ev.country) || { count: 0, name: ev.countryName }
      country.count++
      byCountry.set(ev.country, { count: country.count, name: ev.countryName })

      byPath.set(ev.path, (byPath.get(ev.path) || 0) + 1)

      const hour = new Date(ev.ts).getUTCHours()
      byHour[hour]++

      const dayKey = new Date(ev.ts).toISOString().slice(0, 10)
      const day = byDayMap.get(dayKey) || { views: 0, users: new Set<string>() }
      day.views++
      day.users.add(ev.deviceId)
      byDayMap.set(dayKey, day)

      // Referrer: extract domain
      if (ev.referrer) {
        try {
          const refUrl = new URL(ev.referrer)
          const domain = refUrl.hostname.replace(/^www\./, '')
          byReferrer.set(domain, (byReferrer.get(domain) || 0) + 1)
        } catch {
          // invalid referrer URL — skip
        }
      }
    }

    // Convert maps to sorted arrays
    const byDay = Array.from(byDayMap.entries())
      .map(([date, d]) => ({ date, views: d.views, users: d.users.size }))
      .sort((a, b) => a.date.localeCompare(b.date))

    return NextResponse.json({
      totalPageViews: allEvents.length,
      uniqueUsers: uniqueDevices.size,
      uniqueSessions: uniqueSessions.size,
      byBrowser: Array.from(byBrowser.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      byDevice: Array.from(byDevice.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      byOS: Array.from(byOS.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      byCountry: Array.from(byCountry.entries())
        .map(([code, { count, name }]) => ({ code, name, count }))
        .sort((a, b) => b.count - a.count),
      byPath: Array.from(byPath.entries())
        .map(([path, count]) => ({ path, count }))
        .sort((a, b) => b.count - a.count),
      byHour: byHour.map((count, hour) => ({ hour, count })),
      byDay,
      topReferrers: Array.from(byReferrer.entries())
        .map(([domain, count]) => ({ domain, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      range: { fromTs, toTs, days: dates.length },
      ts: Date.now(),
    })
  } catch (err) {
    console.error('[analytics/query] error:', err)
    return NextResponse.json(
      { error: 'Query failed', detail: String(err) },
      { status: 500 },
    )
  }
}
