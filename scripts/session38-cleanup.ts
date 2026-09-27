/**
 * session38-cleanup.ts — remove this session's E2E scratch records:
 * the digest/panel test accounts (digest-e2e-* / panel-e2e-*), their
 * sessions, index entries, claim codes, and the simulated kofiEvents.
 * Run: bun scripts/session38-cleanup.ts
 */
import { firebaseRead, firebaseDelete } from '../src/lib/firebase-server'
import { emailKey } from '../src/lib/subscriptions'

async function main() {
  // ── Scratch accounts (register flows from the curl + browser E2E) ──
  // accountIndex keys are sha256 hashes, so scan the accounts tree for
  // the E2E email prefixes instead.
  const accounts = (await firebaseRead<Record<string, { email?: string }>>('accounts')) || {}
  let removedAccounts = 0
  const scratchIds = new Set<string>()
  for (const [accountId, rec] of Object.entries(accounts)) {
    const email = String(rec?.email || '').toLowerCase()
    if (!/^(digest-e2e|panel-e2e)-/.test(email)) continue
    scratchIds.add(accountId)
    await firebaseDelete(`accounts/${accountId}`).catch(() => {})
    const { emailKey: ek } = await import('../src/lib/subscriptions')
    await firebaseDelete(`accountIndex/${ek(email)}`).catch(() => {})
    // Their sessions (best-effort: scan the session store for the id).
    const sessions = (await firebaseRead<Record<string, { accountId?: string }>>('sessions')) || {}
    for (const [token, sr] of Object.entries(sessions)) {
      if (sr?.accountId === accountId) await firebaseDelete(`sessions/${token}`).catch(() => {})
    }
    console.log(`removed account ${email}`)
    removedAccounts++
  }
  console.log(`accounts removed: ${removedAccounts}`)

  // ── Claim codes bound to the SCRATCH accounts only (kofiClaims is
  //    production-shared — never blanket-delete real users' codes) ──
  const claims =
    (await firebaseRead<Record<string, { accountId?: string }>>('kofiClaims')) || {}
  let n = 0
  for (const [code, rec] of Object.entries(claims)) {
    if (rec?.accountId && scratchIds.has(rec.accountId)) {
      await firebaseDelete(`kofiClaims/${code}`).catch(() => {})
      n++
    }
  }
  console.log(`claim codes removed: ${n}`)

  // ── Simulated webhook events ──
  const events = (await firebaseRead<Record<string, unknown>>('kofiEvents')) || {}
  let e = 0
  for (const id of Object.keys(events)) {
    if (id.startsWith('e2e-')) {
      await firebaseDelete(`kofiEvents/${id}`).catch(() => {})
      e++
    }
  }
  console.log(`kofiEvents removed: ${e}`)

  // ── Outbox leftovers from the delivery test (defensive) ──
  await firebaseDelete('digestOutbox/e2e-digest-test').catch(() => {})
  await firebaseDelete('digestSubscribers/e2e-digest-test').catch(() => {})
  console.log('digest scratch nodes removed')
}

void main()
