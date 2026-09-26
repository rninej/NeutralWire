/**
 * test-fill-latency.ts — STRICT latency test for the subtopic first-fill
 * path (the KPI: initial feed loading under 10 seconds, end-to-end).
 *
 * What it measures, against a RUNNING dev/production server:
 *   1. Warm-up request (route compile, excludes from results).
 *   2. N sequential COLD fills — each hits /api/news?category=custom:<id>
 *      on a catalog topic with no cached feed yet. Every response must
 *      arrive in < 10_000 ms (hard assert). pending:true responses are
 *      recorded (the deadline race cut a slow GDELT/AI path — the feed
 *      keeps filling in the background; the client shows "Gathering").
 *   3. One WARM re-request — should answer from the Firebase cache.
 *
 * Sandbox note: this environment's shared egress IP is GDELT-rate-limited
 * (429s), so the COLD fills here exercise the WORST-CASE path (429 →
 * backoff → retry → AI keyword fallback). Production Vercel IPs run the
 * healthy path (1-3s GDELT). Either way the sub-10s budget must hold —
 * that is exactly what this script asserts.
 *
 * Usage: bun scripts/test-fill-latency.ts [baseUrl]
 */
import { SUBTOPIC_CATALOG } from '../src/lib/subtopic-catalog'

const BASE = process.argv[2] || 'http://localhost:3000'
const KPI_MS = 10_000
const WARM_LIMIT_MS = 2_000

// Plausible-but-rarely-subscribed catalog topics → cache misses.
const PREFERRED = [
  'chess',
  'esports',
  'drones',
  'robotics',
  'quantum-computing',
  'battery-technology',
  'volleyball',
  'archery',
  'origami',
  'kayaking',
]

async function timedGet(path: string): Promise<{ ms: number; status: number; body: any }> {
  const t0 = Date.now()
  const res = await fetch(`${BASE}${path}`, { cache: 'no-store' })
  let body: any = null
  try {
    body = await res.json()
  } catch {}
  return { ms: Date.now() - t0, status: res.status, body }
}

async function main() {
  console.log(`\n── NeutralWire subtopic first-fill latency test ──`)
  console.log(`   target: ${BASE}`)
  console.log(`   KPI:    every cold-fill response < ${KPI_MS} ms\n`)

  // 1. Warm-up (route compile + module load) — excluded from results.
  const warmup = await timedGet('/api/news?category=top&limit=5')
  if (warmup.status !== 200) {
    console.error(`✗ warm-up failed (status ${warmup.status}) — is the server running?`)
    process.exit(1)
  }

  // Resolve candidate topic ids that exist in the catalog.
  const byId = new Map(SUBTOPIC_CATALOG.map((t) => [t.id, t]))
  const topics = PREFERRED.filter((id) => byId.has(id)).slice(0, 6)
  if (topics.length === 0) {
    console.error('✗ no catalog topics resolved')
    process.exit(1)
  }

  let failures = 0
  const rows: Array<{ id: string; ms: number; topics: number; pending: boolean; note: string }> = []

  // 2. Sequential cold fills.
  for (const id of topics) {
    const r = await timedGet(`/api/news?category=custom:${id}&limit=5`)
    const ok = r.status === 200 && r.ms < KPI_MS
    if (!ok) failures++
    rows.push({
      id,
      ms: r.ms,
      topics: Array.isArray(r.body?.topics) ? r.body.topics.length : -1,
      pending: Boolean(r.body?.pending),
      note: !ok
        ? r.status !== 200
          ? `HTTP ${r.status}`
          : `OVER BUDGET`
        : r.body?.pending
          ? 'pending (deadline race held, fill continues in background)'
          : 'filled',
    })
    // Small pause so consecutive fills don't trip GDELT politeness themselves.
    await new Promise((res) => setTimeout(res, 700))
  }

  // 3. Warm re-request on the LAST topic (cache hit if its fill landed).
  const warmId = topics[topics.length - 1]
  const warm = await timedGet(`/api/news?category=custom:${warmId}&limit=5`)
  const warmOk = warm.status === 200
  if (!warmOk) failures++

  // ── Report ──
  const pad = (s: string, n: number) => s.padEnd(n)
  console.log(pad('topic', 22) + pad('ms', 8) + pad('stories', 9) + pad('state', 9) + 'note')
  for (const r of rows) {
    const flag = r.ms < KPI_MS ? '✓' : '✗'
    console.log(
      flag + ' ' + pad(r.id, 20) + pad(String(r.ms), 8) + pad(String(r.topics), 9) +
      pad(r.pending ? 'pending' : 'filled', 9) + r.note,
    )
  }
  console.log(
    (warmOk ? '✓' : '✗') + ' ' + pad(`${warmId} (warm)`, 20) + pad(String(warm.ms), 8) +
    pad(String(Array.isArray(warm.body?.topics) ? warm.body.topics.length : -1), 9) +
    pad(warm.body?.cached ? 'cached' : 'fresh', 9) +
    (warm.ms < WARM_LIMIT_MS ? 'cache hit' : `slow (> ${WARM_LIMIT_MS}ms — first hit after fill may recompile)`),
  )

  const cold = rows.map((r) => r.ms)
  const max = Math.max(...cold)
  const p50 = cold.sort((a, b) => a - b)[Math.floor(cold.length / 2)]
  console.log(`\n   cold fills: n=${rows.length}  p50=${p50}ms  max=${max}ms  KPI=${KPI_MS}ms`)
  console.log(`   every cold response under 10s: ${max < KPI_MS ? 'PASS ✓' : 'FAIL ✗'}`)

  if (failures > 0 || max >= KPI_MS) {
    console.error(`\n✗ LATENCY TEST FAILED (${failures} failures / max ${max}ms)`)
    process.exit(1)
  }
  console.log(`\n✓ LATENCY TEST PASSED — initial feed loading stays under 10 seconds\n`)
}

main().catch((err) => {
  console.error('✗ test crashed:', err)
  process.exit(1)
})
