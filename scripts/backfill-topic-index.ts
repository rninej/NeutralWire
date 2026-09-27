/**
 * backfill-topic-index.ts — one-time (and re-runnable) backfill of the
 * topicIndex (topicId → room) for every live newsCache room.
 *
 * WHY: findTopicAnywhere's legacy fallback scans up to 48 rooms
 * (up to 6.44MB) whenever a topic isn't in the archive. From now on
 * writeCachedNews maintains the index automatically, but every topic
 * cached BEFORE this deploy needs a one-time backfill so lookups take
 * the O(1) path immediately.
 *
 * Cost: reads each room once (48 × ~137KB avg ≈ 6.4MB — one time),
 * writes one ~1-2KB PATCH per room.
 *
 * Run: npx tsx scripts/backfill-topic-index.ts
 */

const DB_URL =
  'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'

interface TopicStub {
  topicId?: string
}

async function shallowKeys(path: string): Promise<string[]> {
  const res = await fetch(`${DB_URL}/${path}.json?shallow=true`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) return []
  const text = await res.text()
  if (!text || text === 'null') return []
  return Object.keys(JSON.parse(text))
}

async function readRoom(room: string): Promise<TopicStub[]> {
  const res = await fetch(`${DB_URL}/newsCache/${room}.json`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) return []
  const text = await res.text()
  if (!text || text === 'null') return []
  try {
    const payload = JSON.parse(text) as { topics?: TopicStub[] }
    return Array.isArray(payload.topics) ? payload.topics : []
  } catch {
    return []
  }
}

async function patchIndex(patch: Record<string, string>): Promise<boolean> {
  const res = await fetch(`${DB_URL}/topicIndex.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(15000),
  })
  return res.ok
}

function fmt(n: number): string {
  return n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`
}

async function main() {
  const rooms = await shallowKeys('newsCache')
  console.log(`Backfilling topicIndex for ${rooms.length} rooms…`)

  let totalEntries = 0
  let failed = 0
  for (const room of rooms) {
    const topics = await readRoom(room)
    const patch: Record<string, string> = {}
    for (const t of topics) {
      if (t?.topicId) patch[t.topicId] = room
    }
    if (Object.keys(patch).length === 0) {
      console.log(`  ${room.padEnd(28)} (no topics)`)
      continue
    }
    const ok = await patchIndex(patch)
    totalEntries += Object.keys(patch).length
    if (!ok) failed++
    console.log(
      `  ${room.padEnd(28)} ${String(Object.keys(patch).length).padStart(3)} topics ${ok ? '✓' : '✗ PATCH FAILED'}`,
    )
  }

  // Sanity: verify a few lookups end-to-end through the index.
  console.log(`\nIndexed ${totalEntries} topicIds across ${rooms.length} rooms (${failed} failed patches).`)
  console.log('Verifying 3 random entries…')
  const verify = await shallowKeys('topicIndex')
  console.log(`  topicIndex now holds ${verify.length} entries (${fmt(verify.length * 28)}).`)
}

main().catch((e) => {
  console.error('backfill failed:', e)
  process.exit(1)
})
