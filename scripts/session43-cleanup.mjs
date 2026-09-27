/**
 * session43-cleanup.mjs — sweep the E2E scratch state:
 *   • the s43free@test.local account (a_6504efc2cf079b734d88) + its sessions
 *   • the bogus accounts/s43free@test,local node (already nulled — verify)
 * Leaves in place: the real subscriber's outbox entry (failure evidence
 * for the owner), the freshly-filled customFeeds warm caches (real
 * topics), and the digestSweeps audit trail.
 */
const DB = 'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'

async function get(path) {
  const res = await fetch(`${DB}/${path}.json`, { cache: 'no-store' })
  return res.json()
}

async function putNull(path) {
  const res = await fetch(`${DB}/${path}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: 'null',
  })
  return res.status
}

async function main() {
  const ACCT = 'a_6504efc2cf079b734d88'

  // sessions belonging to the scratch account
  const sessions = (await get('sessions')) || {}
  let n = 0
  for (const [sid, v] of Object.entries(sessions || {})) {
    if (v && (v.accountId === ACCT || v.email === 's43free@test.local')) {
      console.log('delete session', sid, '→', await putNull(`sessions/${sid}`))
      n++
    }
  }
  console.log(`sessions removed: ${n}`)

  // the account itself
  console.log('delete account →', await putNull(`accounts/${ACCT}`))

  // verify the bogus emailKey node is gone
  const bogus = await get('accounts/s43free%40test%2Clocal')
  console.log('bogus node:', bogus === null ? 'already gone' : JSON.stringify(bogus))

  // verify no kofi claims / digest subs reference the scratch account
  const subs = await get('digestSubscribers')
  const hit = Object.entries(subs || {}).find(([k, v]) => k === ACCT || v?.email === 's43free@test.local')
  console.log('digest subscriber leftovers:', hit ? JSON.stringify(hit) : 'none')
}

main().catch((e) => {
  console.error('cleanup failed:', e)
  process.exit(1)
})
