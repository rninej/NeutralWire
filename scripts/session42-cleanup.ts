/**
 * session42-cleanup.ts — production data repair + one-time backfill.
 *
 * 1. DELETE the poisoned newsCache/custom:* rooms. Before the
 *    /api/refresh fix, the stale-feed heal hit
 *    /api/refresh?category=custom:<id>, the route aggregated a bogus
 *    category and wrote garbage rooms (newsCache/custom:chess and
 *    newsCache/custom:artificial-intelligence are live in production)
 *    which then got SERVED BACK to every rate-limited refresh — that's
 *    the wipe that showed "No topics found" seconds after a feed loaded.
 * 2. BACKFILL topicIndex entries for every existing customFeed: one read
 *    per feed (one-time ~2.2MB total), writing topicId → 'custom:<feedId>'
 *    so /api/topic resolves premium-subtopic stories in O(1) — this is
 *    what makes the Sources popup work for topics cached BEFORE the
 *    code started writing index entries itself.
 */
const DB = 'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${DB}/${path}.json`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
  return res.json()
}

async function del(path: string): Promise<void> {
  const res = await fetch(`${DB}/${path}.json`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`DELETE ${path} → ${res.status}`)
}

async function patch(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${DB}/${path}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`PATCH ${path} → ${res.status}`)
}

async function main() {
  // ── 1. Poisoned rooms ──
  const cache = (await get('newsCache').catch(() => null)) as Record<string, unknown> | null
  const poisoned = Object.keys(cache || {}).filter((k) => k.startsWith('custom:'))
  for (const key of poisoned) {
    await del(`newsCache/${encodeURIComponent(key)}`)
    console.log(`deleted poisoned room: newsCache/${key}`)
  }
  if (poisoned.length === 0) console.log('no poisoned newsCache/custom:* rooms found')

  // ── 2. topicIndex backfill for custom feeds ──
  const feeds = (await get('customFeeds').catch(() => null)) as Record<
    string,
    { topics?: Array<{ topicId?: string }> }
  > | null
  if (!feeds) {
    console.log('customFeeds empty — nothing to backfill')
    return
  }
  let feedsIndexed = 0
  let topicsIndexed = 0
  for (const [feedId, feed] of Object.entries(feeds)) {
    const topics = feed?.topics || []
    const patchBody: Record<string, string> = {}
    for (const t of topics) {
      if (t?.topicId) patchBody[t.topicId] = `custom:${feedId}`
    }
    if (Object.keys(patchBody).length === 0) continue
    await patch('topicIndex', patchBody)
    feedsIndexed++
    topicsIndexed += Object.keys(patchBody).length
    console.log(`indexed ${feedId}: ${Object.keys(patchBody).length} topics`)
  }
  console.log(`\nbackfill done — ${feedsIndexed} feeds, ${topicsIndexed} topics indexed`)
}

main().catch((e) => {
  console.error('cleanup failed:', e)
  process.exit(1)
})
