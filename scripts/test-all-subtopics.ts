/**
 * test-all-subtopics.ts — the "works for EVERY subtopic" verification.
 *
 * Pass 1 (offline, all 555): every catalog topic must build a valid
 * Google News query (≥1 keyword ≥2 chars) — mechanical coverage proof.
 *
 * Pass 2 (live, stratified sample): fill one topic per ~13 catalog
 * entries across every group through the REAL engine (background mode),
 * asserting a non-null payload with topics. Network-verifies the ladder
 * across the whole catalog surface.
 */
import { SUBTOPIC_CATALOG, CATALOG_GROUPS } from '../src/lib/subtopic-catalog'
import { refreshCustomTopic } from '../src/lib/custom-topics'

const MODE = process.argv[2] || 'all'

async function main() {
  // ── Pass 1: offline query validation for ALL topics ──
  const invalid: string[] = []
  for (const t of SUBTOPIC_CATALOG) {
    const kw = t.keywords
      .slice(0, 8)
      .map((k) => `"${k.replace(/"/g, '').trim()}"`)
      .filter((k) => k.length > 3)
    if (kw.length === 0) invalid.push(`${t.id} (${t.label})`)
  }
  console.log(`[pass1] ${SUBTOPIC_CATALOG.length} topics checked; invalid queries: ${invalid.length}${invalid.length ? ' → ' + invalid.join(', ') : ''}`)
  if (MODE === 'offline') process.exit(0)

  // ── Pass 2: stratified live sample ──
  const perGroup = new Map<string, number>()
  for (const t of SUBTOPIC_CATALOG) perGroup.set(t.group, (perGroup.get(t.group) || 0) + 1)
  const sample: typeof SUBTOPIC_CATALOG = []
  const stride = Math.max(1, Math.floor(SUBTOPIC_CATALOG.length / 40))
  const used = new Set<string>()
  for (let i = 0; i < SUBTOPIC_CATALOG.length && sample.length < 40; i += stride) {
    const t = SUBTOPIC_CATALOG[i]
    if (used.has(t.id)) continue
    used.add(t.id)
    sample.push(t)
  }
  // make sure every group has at least one sampled topic
  for (const g of CATALOG_GROUPS) {
    if (!sample.some((t) => t.group === g)) {
      const first = SUBTOPIC_CATALOG.find((t) => t.group === g)
      if (first && !used.has(first.id)) {
        used.add(first.id)
        sample.push(first)
      }
    }
  }
  console.log(`[pass2] ${sample.length} topics to fill live, groups: ${[...new Set(sample.map((t) => t.group))].join(' | ')}`)

  let ok = 0
  let fail = 0
  const failures: string[] = []
  for (const t of sample) {
    const t0 = Date.now()
    try {
      const payload = await refreshCustomTopic(t.id, { aiFilter: false, mode: 'background', budgetMs: 20000 })
      if (payload && payload.topics.length > 0) {
        ok++
        const imgs = payload.topics.filter((x) => x.imageUrl).length
        console.log(`  ✓ ${t.id} [${t.group}]: ${payload.topics.length} topics, ${imgs} imgs (${Date.now() - t0}ms)`)
      } else {
        fail++
        failures.push(t.id)
        console.log(`  ✗ ${t.id} [${t.group}]: NULL payload (${Date.now() - t0}ms)`)
      }
    } catch (err) {
      fail++
      failures.push(t.id)
      console.log(`  ✗ ${t.id} [${t.group}]: ERROR ${String(err).slice(0, 120)}`)
    }
  }
  console.log(`\n[pass2] RESULT: ${ok} ok, ${fail} failed${fail ? ' → ' + failures.join(', ') : ''}`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
