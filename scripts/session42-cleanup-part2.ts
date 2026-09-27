/**
 * session42-cleanup-part2.ts — sweep the E2E scratch:
 *   • test account (accounts/<id>, accountIndex entry, sessions)
 *   • customSubscriptions counts (the picker's add incremented chess and
 *     artificial-intelligence — restore both by 1)
 * Kept deliberately: the refilled customFeeds (legit warm caches), the
 * archived chess topics (real stories), topicIndex entries (real rooms),
 * and the digestSweeps log nodes (audit trail).
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
  const TEST_EMAIL = 'session42test@neutralwire.dev'
  const TEST_ID = 'a_1d9d69297e7d24f37956'
  const emailKey = TEST_EMAIL.toLowerCase().replace(/\./g, ',')

  // 1. account + index + sessions
  await del(`accounts/${TEST_ID}`)
  console.log('deleted account')
  const idx = (await get('accountIndex').catch(() => null)) as Record<string, string> | null
  const idxKey = Object.entries(idx || {}).find(([, v]) => v === TEST_EMAIL || v === TEST_ID)
  if (idxKey) {
    await del(`accountIndex/${encodeURIComponent(idxKey[0])}`)
    console.log('deleted accountIndex entry', idxKey[0])
  }
  const sessions = (await get('sessions').catch(() => null)) as Record<string, unknown> | null
  let sweptSessions = 0
  for (const [sid, s] of Object.entries(sessions || {})) {
    const acct = (s as { accountId?: string; account?: string })?.accountId ||
      (s as { account?: string })?.account
    if (acct === TEST_ID || JSON.stringify(s).includes(TEST_EMAIL)) {
      await del(`sessions/${encodeURIComponent(sid)}`)
      sweptSessions++
    }
  }
  console.log(`swept ${sweptSessions} sessions`)

  // 2. subscription counts
  for (const topic of ['chess', 'artificial-intelligence']) {
    const sub = (await get(`customSubscriptions/${topic}`).catch(() => null)) as {
      count?: number
    } | null
    const current = sub?.count || 0
    await patch(`customSubscriptions`, {
      [topic]: { count: Math.max(0, current - 1), updatedAt: Date.now() },
    })
    console.log(`${topic} count: ${current} → ${Math.max(0, current - 1)}`)
  }

  // 3. final state print
  const subs = (await get('customSubscriptions').catch(() => null)) as Record<
    string,
    { count?: number }
  > | null
  const chessCount = subs?.chess?.count
  const aiCount = subs?.['artificial-intelligence']?.count
  console.log(`final: chess=${chessCount} artificial-intelligence=${aiCount}`)
}

main().catch((e) => {
  console.error('cleanup failed:', e)
  process.exit(1)
})
