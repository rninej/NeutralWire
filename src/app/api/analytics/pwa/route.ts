import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead } from '@/lib/firebase-server'
import { verifyAdminPassword } from '@/lib/admin-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 15

/**
 * PWA growth metrics — aggregation endpoint for the /debug dashboard.
 *
 * POST /api/analytics/pwa   body: { password, days? }
 *   Password-gated (same admin password as /api/analytics/query).
 *
 * Returns unique-IP metrics (every count = DISTINCT IP addresses):
 *   {
 *     installsTotal,    // all-time distinct IPs that installed
 *     installsToday,    // distinct IPs that installed today (UTC)
 *     installsByDay,    // [{ date, count }] — last N days
 *     dauToday,         // distinct IPs active today (site OR app)
 *     dauByDay,         // [{ date, count }]
 *     appDauToday,      // distinct IPs that opened the installed PWA today
 *     appDauByDay,      // [{ date, count }]
 *     installRate7d,    // installs ÷ DAU over the last 7 days
 *     ts
 *   }
 */

const ROOT = 'pwaMetrics'
const DAY_MS = 24 * 60 * 60 * 1000

function todayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

function lastNDays(n: number): string[] {
  const out: string[] = []
  const now = Date.now()
  for (let i = n - 1; i >= 0; i--) {
    out.push(todayKey(now - i * DAY_MS))
  }
  return out
}

interface DayMap {
  [date: string]: number
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { password?: string; days?: number }
    if (!body.password || !verifyAdminPassword(body.password || '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const days = Math.min(Math.max(body.days || 14, 1), 90)
    const dates = lastNDays(days)

    // Parallel reads: 3 buckets × N day-nodes.
    const [installsAll, dauAll, appDauAll] = await Promise.all([
      firebaseRead<Record<string, Record<string, number>>>(`${ROOT}/installs`),
      firebaseRead<Record<string, Record<string, number>>>(`${ROOT}/dau`),
      firebaseRead<Record<string, Record<string, number>>>(`${ROOT}/appDau`),
    ])

    // All-time distinct install IPs (union of keys across all days).
    const installsUnion = new Set<string>()
    if (installsAll) {
      for (const day of Object.values(installsAll)) {
        if (day) for (const key of Object.keys(day)) installsUnion.add(key)
      }
    }

    const today = todayKey(Date.now())
    const countKeys = (day: Record<string, number> | undefined): number =>
      day ? Object.keys(day).length : 0

    const installsByDay: DayMap = {}
    const dauByDay: DayMap = {}
    const appDauByDay: DayMap = {}
    let dau7 = 0
    let installs7 = 0
    const sevenDaysAgo = todayKey(Date.now() - 6 * DAY_MS)

    for (const d of dates) {
      const i = countKeys(installsAll?.[d])
      const w = countKeys(dauAll?.[d])
      const a = countKeys(appDauAll?.[d])
      installsByDay[d] = i
      dauByDay[d] = w
      appDauByDay[d] = a
      if (d >= sevenDaysAgo) {
        dau7 += w
        installs7 += i
      }
    }

    return NextResponse.json({
      installsTotal: installsUnion.size,
      installsToday: countKeys(installsAll?.[today]),
      installsByDay,
      dauToday: countKeys(dauAll?.[today]),
      dauByDay,
      appDauToday: countKeys(appDauAll?.[today]),
      appDauByDay,
      // How many engaged visitors convert to an install (7-day window).
      installRate7d: dau7 > 0 ? +(installs7 / dau7).toFixed(3) : 0,
      days,
      ts: Date.now(),
    })
  } catch (err) {
    console.error('[analytics/pwa] error:', err)
    return NextResponse.json(
      { error: 'Query failed', detail: String(err) },
      { status: 500 },
    )
  }
}
