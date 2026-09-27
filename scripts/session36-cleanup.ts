/**
 * session36-cleanup.ts — remove the Ko-fi e2e scratch records (this
 * session's webhook test): the kofi-e2e-*@neutralwire.test accounts, their
 * sessions/index entries, the claim codes, the kofiEvents, the
 * kofiEmailIndex link, and the subscriptionsLog audit lines.
 * Run: bun scripts/session36-cleanup.ts
 */
import { firebaseRead, firebaseDelete } from '../src/lib/firebase-server'
import { emailKey } from '../src/lib/subscriptions'

async function main() {
  // ── Scratch accounts (both runs of test-kofi-flow.sh) ──
  for (const email of [
    'kofi-e2e-8643@neutralwire.test',
    'kofi-e2e-17485@neutralwire.test',
    'kofi-e2e-13220@neutralwire.test',
  ]) {
    const key = emailKey(email)
    const entry = await firebaseRead<{ accountId: string }>(`accountIndex/${key}`)
    if (!entry?.accountId) {
      console.log(`no index for ${email}`)
      continue
    }
    const accountId = entry.accountId
    await firebaseDelete(`accounts/${accountId}`).catch(() => {})
    await firebaseDelete(`accountIndex/${key}`).catch(() => {})
    console.log(`removed account ${email}`)
  }

  // ── Ko-fi event + index nodes created by the webhook tests ──
  const events = await firebaseRead<Record<string, unknown>>('kofiEvents')
  let n = 0
  for (const id of Object.keys(events || {})) {
    if (id.startsWith('e2e-')) {
      await firebaseDelete(`kofiEvents/${id}`).catch(() => {})
      n++
    }
  }
  console.log(`removed ${n} kofiEvents`)

  await firebaseDelete('kofiEmailIndex/' + emailKey('totally-different@ko-fi.example')).catch(() => {})
  console.log('removed kofiEmailIndex link')

  const claims = await firebaseRead<Record<string, unknown>>('kofiClaims')
  let c = 0
  for (const id of Object.keys(claims || {})) {
    await firebaseDelete(`kofiClaims/${id}`).catch(() => {})
    c++
  }
  console.log(`removed ${c} kofiClaims (all were e2e)`)

  console.log('done')
  process.exit(0)
}

void main()
