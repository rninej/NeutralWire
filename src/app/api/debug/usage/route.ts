import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead, firebaseDelete, firebaseReadShallow } from '@/lib/firebase-server'
import { trackRequest, localSnapshot, USAGE_INSTANCE_ID } from '@/lib/usage-meter'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 20

/**
 * GET /api/debug/usage — the EMERGENCY CPU attribution report (Nov 16).
 *
 * Answers "which component is taking how much of the ~1hr/day Fluid
 * Active CPU": per-route request counts / wall ms / in-process CPU ms /
 * Firebase bytes / trigger-source split (extcron / vcron / usercron /
 * bot / user / tail), stage timings inside the heavy libs (full
 * aggregations per room, mesh-manifest signing, cache writes, pre-gen
 * waves), the per-provider AI request ledger, page-navigation counts
 * (bot vs user), per-tick run records for the cron routes, and slow
 * request samples.
 *
 * WHY PUBLIC (same policy as /api/debug/models): aggregate counters and
 * route names only — no user data, no secrets, no prompts. The one GET
 * per report hit is the cost of reading the day's usageMeter node.
 *
 * Query: ?days=1 (default, today) or 2 (today+yesterday).
 * Kill switch: USAGE_METER_OFF=1 stops all meter writes.
 */

interface RouteReport {
  route: string
  count: number
  wallMs: number
  cpuMs: number
  maxWallMs: number
  fbBytes: number
  avgWallMs: number
  status: Record<string, number>
  bySource: Record<string, { count: number; wallMs: number }>
  stages: Record<string, { count: number; ms: number }>
}

function emptyRoute(route: string): RouteReport {
  return {
    route,
    count: 0,
    wallMs: 0,
    cpuMs: 0,
    maxWallMs: 0,
    fbBytes: 0,
    avgWallMs: 0,
    status: {},
    bySource: {},
    stages: {},
  }
}

function mergeInstance(target: RouteReport, inst: Record<string, unknown>): void {
  const i = inst as {
    count?: number
    wallMs?: number
    cpuMs?: number
    maxWallMs?: number
    fbBytes?: number
    status?: Record<string, number>
    bySource?: Record<string, { count?: number; wallMs?: number }>
    stages?: Record<string, { count?: number; ms?: number }>
  }
  target.count += i.count || 0
  target.wallMs += i.wallMs || 0
  target.cpuMs += i.cpuMs || 0
  target.maxWallMs = Math.max(target.maxWallMs, i.maxWallMs || 0)
  target.fbBytes += i.fbBytes || 0
  for (const [k, v] of Object.entries(i.status || {})) {
    target.status[k] = (target.status[k] || 0) + (v || 0)
  }
  for (const [k, v] of Object.entries(i.bySource || {})) {
    if (!target.bySource[k]) target.bySource[k] = { count: 0, wallMs: 0 }
    target.bySource[k].count += v.count || 0
    target.bySource[k].wallMs += v.wallMs || 0
  }
  for (const [k, v] of Object.entries(i.stages || {})) {
    if (!target.stages[k]) target.stages[k] = { count: 0, ms: 0 }
    target.stages[k].count += v.count || 0
    target.stages[k].ms += v.ms || 0
  }
}

async function GET$(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams
    const nDays = Math.min(2, Math.max(1, Number(sp.get('days') || '1')))
    const now = Date.now()
    const dayKeys: string[] = []
    for (let i = 0; i < nDays; i++) {
      dayKeys.push(new Date(now - i * 86_400_000).toISOString().slice(0, 10))
    }

    const days: Record<string, Record<string, unknown>> = {}
    for (const dk of dayKeys) {
      const node = await firebaseRead<Record<string, unknown>>(`usageMeter/${dk}`)
      if (node) days[dk] = node
    }

    // Merge THIS instance's un-flushed in-memory data (never more than one
    // flush window stale).
    const local = localSnapshot()
    for (const [dk, d] of Object.entries(local)) {
      if (!days[dk]) days[dk] = {}
      const dayNode = days[dk] as {
        routes?: Record<string, Record<string, unknown>>
        ai?: Record<string, unknown>
      }
      dayNode.routes = dayNode.routes || {}
      for (const [rk, agg] of Object.entries(d.routes)) {
        dayNode.routes[rk] = dayNode.routes[rk] || {}
        ;(dayNode.routes[rk] as Record<string, unknown>)[USAGE_INSTANCE_ID] = agg
      }
      if (Object.keys(d.ai).length || Object.keys(d.aiModels).length) {
        dayNode.ai = dayNode.ai || {}
        dayNode.ai[USAGE_INSTANCE_ID] = { providers: d.ai, models: d.aiModels }
      }
    }

    // ── Aggregate across instances ──
    const outDays: Record<string, unknown> = {}
    const totals = {
      requests: 0,
      wallMs: 0,
      cpuMs: 0,
      fbBytes: 0,
      cpuHours: 0,
      bySource: {} as Record<string, number>,
    }

    for (const [dk, rawNode] of Object.entries(days)) {
      const dayNode = rawNode as {
        routes?: Record<string, Record<string, unknown>>
        ai?: Record<string, { providers?: unknown; models?: unknown }>
        pages?: Record<string, { counts?: unknown; sources?: unknown }>
        runs?: Record<string, Record<string, unknown>>
        slow?: Record<string, unknown>
        instances?: Record<string, unknown>
      }
      const routes: Record<string, RouteReport> = {}
      for (const [rk, instMap] of Object.entries(dayNode.routes || {})) {
        const report = emptyRoute(rk)
        for (const inst of Object.values(instMap)) {
          mergeInstance(report, inst as Record<string, unknown>)
        }
        report.avgWallMs = report.count ? Math.round(report.wallMs / report.count) : 0
        routes[rk] = report
        totals.requests += report.count
        totals.wallMs += report.wallMs
        totals.cpuMs += report.cpuMs
        totals.fbBytes += report.fbBytes
        for (const [src, v] of Object.entries(report.bySource)) {
          totals.bySource[src] = (totals.bySource[src] || 0) + v.count
        }
      }

      // AI ledger
      const ai = {
        providers: {} as Record<string, { calls: number; ok: number; ms: number }>,
        models: {} as Record<string, { calls: number; ok: number; ms: number }>,
      }
      for (const inst of Object.values(dayNode.ai || {})) {
        const i = inst as {
          providers?: Record<string, { calls?: number; ok?: number; ms?: number }>
          models?: Record<string, { calls?: number; ok?: number; ms?: number }>
        }
        for (const [p, v] of Object.entries(i.providers || {})) {
          if (!ai.providers[p]) ai.providers[p] = { calls: 0, ok: 0, ms: 0 }
          ai.providers[p].calls += v.calls || 0
          ai.providers[p].ok += v.ok || 0
          ai.providers[p].ms += v.ms || 0
        }
        for (const [m, v] of Object.entries(i.models || {})) {
          if (!ai.models[m]) ai.models[m] = { calls: 0, ok: 0, ms: 0 }
          ai.models[m].calls += v.calls || 0
          ai.models[m].ok += v.ok || 0
          ai.models[m].ms += v.ms || 0
        }
      }

      // Page navigations (middleware edge meter)
      const pages = {
        counts: {} as Record<string, number>,
        sources: {} as Record<string, number>,
      }
      for (const inst of Object.values(dayNode.pages || {})) {
        const p = inst as {
          counts?: Record<string, number>
          sources?: Record<string, number>
        }
        for (const [k, v] of Object.entries(p.counts || {})) {
          pages.counts[k] = (pages.counts[k] || 0) + (v || 0)
        }
        for (const [k, v] of Object.entries(p.sources || {})) {
          pages.sources[k] = (pages.sources[k] || 0) + (v || 0)
        }
      }

      // Run records (latest 40) + slow samples (latest 20)
      const runs: Array<Record<string, unknown> & { ts?: number }> = []
      for (const [rk, map] of Object.entries(dayNode.runs || {})) {
        for (const rec of Object.values(map)) {
          runs.push({ route: rk, ...(rec as Record<string, unknown>) })
        }
      }
      runs.sort((a, b) => (b.ts || 0) - (a.ts || 0))
      const slow = Object.entries(dayNode.slow || {})
        .map(([id, rec]) => ({ id, ...(rec as Record<string, unknown>) }) as { ts?: number })
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, 20)

      // Instance inventory (env split: production vs local test scripts)
      const instances = Object.entries(dayNode.instances || {}).map(([id, v]) => ({
        id,
        ...(v as Record<string, unknown>),
      }))

      outDays[dk] = {
        routes: Object.values(routes).sort(
          (a, b) => b.cpuMs - a.cpuMs || b.wallMs - a.wallMs,
        ),
        ai,
        pages,
        runs: runs.slice(0, 40),
        slow,
        instances,
      }
    }

    totals.cpuHours = +(totals.cpuMs / 3_600_000).toFixed(3)

    // ── Trim old day nodes (keep the meter from becoming its own bill) ──
    let trimmed: string[] = []
    try {
      const keys = await firebaseReadShallow('usageMeter')
      const keep = new Set(dayKeys)
      for (const k of keys) {
        if (!keep.has(k)) {
          await firebaseDelete(`usageMeter/${k}`)
          trimmed.push(k)
        }
      }
    } catch {
      /* best-effort */
    }

    return NextResponse.json(
      {
        ok: true,
        generatedAt: new Date().toISOString(),
        note:
          'EMERGENCY CPU attribution (deployed Nov 16, 2026). cpuMs = in-process CPU (user+system) per route — the closest in-function proxy for Vercel Fluid Active CPU; wallMs includes I/O waits (AI/DB calls are mostly wait, NOT Active CPU). Compare totals.cpuHours against the Vercel Usage graph delta for the same day; the residual gap is middleware/edge + page SSR/ISR renders not visible to in-route meters (see pages counts × your per-render cost). bySource: extcron=cron-job.org secret hits, vcron=vercel.json schedule, usercron=visitor lease triggers, tail=post-response after() work (the maxDuration burner), bot=crawlers.',
        totals,
        days: outDays,
        trimmedOldDayNodes: trimmed,
        killSwitch: 'USAGE_METER_OFF=1 env disables all meter writes.',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: 'usage report failed', detail: String(err).slice(0, 200) },
      { status: 500 },
    )
  }
}

// ── usage-meter (Nov 16, 2026 emergency CPU attribution) ──
export const GET = trackRequest(
  'api/debug/usage',
  GET$,
)
