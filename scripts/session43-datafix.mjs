/**
 * session43-datafix.mjs — one-time production data repair:
 *   digestSubscribers/a_49b6b3d4551459fff057/lastSentAt was stamped at
 *   2026-09-27T13:00:54Z by a FAILED (outboxed) delivery — the old code
 *   called markSent() unconditionally. The subscriber has NEVER actually
 *   received an email, so the false timestamp (which throttles catch-up
 *   retries to every 5h) is deleted. The new code stamps lastAttemptAt
 *   separately and only records lastSentAt on real sends.
 */
const DB = 'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'
const ACCT = 'a_49b6b3d4551459fff057'

async function main() {
  // read before
  const before = await (await fetch(`${DB}/digestSubscribers/${ACCT}.json`)).json()
  console.log('before:', JSON.stringify(before))

  // delete the false lastSentAt (PUT null = delete in RTDB REST)
  const res = await fetch(`${DB}/digestSubscribers/${ACCT}/lastSentAt.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: 'null',
  })
  console.log('delete lastSentAt →', res.status)

  const after = await (await fetch(`${DB}/digestSubscribers/${ACCT}.json`)).json()
  console.log('after:', JSON.stringify(after))
}

main().catch((e) => {
  console.error('datafix failed:', e)
  process.exit(1)
})
