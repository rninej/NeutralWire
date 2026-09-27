/**
 * test-video-flag.ts — the videoWatch feature-flag kill switch, isolated
 * in its own script because the 'false' write poisons the video route's
 * 60s flag memo for any e2e that follows in the same process.
 *
 *  1. flag OFF (direct Firebase REST) → /api/video refuses to resolve
 *     (reason 'disabled') after the route memo expires
 *  2. flag ON → the endpoint resolves again
 *
 * Run: bun scripts/test-video-flag.ts
 */

const BASE = process.env.BASE || 'http://localhost:3000'
const DB = 'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'

let pass = 0
let fail = 0

function ok(cond: boolean, label: string, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function jget(url: string, timeoutMs = 20000): Promise<any> {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: c.signal })
    return await r.json()
  } finally {
    clearTimeout(t)
  }
}

async function jput(url: string, body: string): Promise<boolean> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  return res.ok
}

// A topic id to probe with (any — the flag gate runs before lookups).
const news = await jget(`${BASE}/api/news`)
const topicId: string = news?.topics?.[0]?.topicId || 'unknown'
console.log(`probing topic: ${topicId}\n`)

// 1. OFF
console.log('── flag OFF ──')
ok(await jput(`${DB}/featureFlags/videoWatch.json`, 'false'), 'flag written false to Firebase')
console.log('  … waiting out the 60s route memo')
await new Promise((r) => setTimeout(r, 62_000))
const off = await jget(`${BASE}/api/video/${encodeURIComponent(topicId)}`)
ok(
  off?.ok === false && off?.reason === 'disabled',
  '/api/video refuses to resolve while off',
  JSON.stringify(off),
)

// 2. ON
console.log('\n── flag ON ──')
ok(await jput(`${DB}/featureFlags/videoWatch.json`, 'true'), 'flag written true to Firebase')
console.log('  … waiting out the 60s route memo')
await new Promise((r) => setTimeout(r, 62_000))
const on = await jget(`${BASE}/api/video/${encodeURIComponent(topicId)}`, 40000)
ok(on?.ok === true, '/api/video resolves again while on', JSON.stringify(on).slice(0, 90))
const flags = await jget(`${BASE}/api/flags`, 20000)
ok(flags?.videoWatch === true, '/api/flags reports videoWatch true')

console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ${fail ? '✗' : '✓'} ══`)
process.exit(fail ? 1 : 0)

export {}
