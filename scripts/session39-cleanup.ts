/**
 * session39-cleanup.ts — remove this session's E2E scratch records:
 * the verify39* test account, its sessions, index entry and claim code.
 * Run: bun scripts/session39-cleanup.ts
 */
import { firebaseRead, firebaseDelete } from '../src/lib/firebase-server'
import { emailKey } from '../src/lib/subscriptions'

async function main() {
  const accounts = (await firebaseRead<Record<string, { email?: string }>>('accounts')) || {}
  let removedAccounts = 0
  const scratchIds = new Set<string>()
  for (const [accountId, rec] of Object.entries(accounts)) {
    const email = String(rec?.email || '').toLowerCase()
    if (!/^verify39/.test(email)) continue
    scratchIds.add(accountId)
    await firebaseDelete(`accounts/${accountId}`).catch(() => {})
    const ek = emailKey(email)
    await firebaseDelete(`accountIndex/${ek}`).catch(() => {})
    const sessions = (await firebaseRead<Record<string, { accountId?: string }>>('sessions')) || {}
    for (const [token, sr] of Object.entries(sessions)) {
      if (sr?.accountId === accountId) await firebaseDelete(`sessions/${token}`).catch(() => {})
    }
    console.log(`removed account ${email}`)
    removedAccounts++
  }
  console.log(`accounts removed: ${removedAccounts}`)

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
}
void main()
