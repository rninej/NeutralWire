/**
 * session36-cleanup-part2.ts — remove the browser-e2e scratch records:
 * the session36-e2e account (ultra via webhook tests), its kofi
 * events/claims/email-index, the digest subscriber entry, the SEEDED
 * customFeeds/artificial-intelligence cache (fake stories — must go so
 * production never serves them), the customSubscriptions counter bump,
 * and the test device's stale account link.
 * Run: bun scripts/session36-cleanup-part2.ts
 */
import { firebaseRead, firebaseDelete, firebaseWrite } from '../src/lib/firebase-server'
import { emailKey } from '../src/lib/subscriptions'

async function main() {
  // ── The browser e2e account ──
  const email = 'session36-e2e@neutralwire.test'
  const entry = await firebaseRead<{ accountId: string }>(`accountIndex/${emailKey(email)}`)
  if (entry?.accountId) {
    await firebaseDelete(`accounts/${entry.accountId}`).catch(() => {})
    await firebaseDelete(`accountIndex/${emailKey(email)}`).catch(() => {})
    await firebaseDelete(`digestSubscribers/${entry.accountId}`).catch(() => {})
    console.log('removed account + digest subscriber')
  } else {
    console.log('account already gone')
  }

  // ── Ko-fi test events / claims / email links ──
  const events = await firebaseRead<Record<string, unknown>>('kofiEvents')
  let n = 0
  for (const id of Object.keys(events || {})) {
    if (id.startsWith('e2e-') || id.startsWith('browser-')) {
      await firebaseDelete(`kofiEvents/${id}`).catch(() => {})
      n++
    }
  }
  console.log(`removed ${n} kofiEvents`)

  await firebaseDelete('kofiEmailIndex/' + emailKey('browser-tester@ko-fi.example')).catch(() => {})
  await firebaseDelete('kofiEmailIndex/' + emailKey('totally-different@ko-fi.example')).catch(() => {})

  const claims = await firebaseRead<Record<string, unknown>>('kofiClaims')
  let c = 0
  for (const id of Object.keys(claims || {})) {
    await firebaseDelete(`kofiClaims/${id}`).catch(() => {})
    c++
  }
  console.log(`removed ${c} kofiClaims`)

  // ── The SEEDED fake AI feed — CRITICAL ──
  await firebaseDelete('customFeeds/artificial-intelligence').catch(() => {})
  console.log('removed seeded customFeeds/artificial-intelligence')

  // ── The customSubscriptions counter bump from adding the topic ──
  const subRec = await firebaseRead<{ count?: number }>('customSubscriptions/artificial-intelligence')
  if (subRec) {
    const next = Math.max(0, (subRec.count || 1) - 1)
    if (next === 0) {
      await firebaseDelete('customSubscriptions/artificial-intelligence').catch(() => {})
    } else {
      await firebaseWrite('customSubscriptions/artificial-intelligence', {
        ...subRec,
        count: next,
        updatedAt: Date.now(),
      }).catch(() => {})
    }
    console.log(`customSubscriptions/artificial-intelligence → ${next}`)
  }

  // ── Test device: clear the stale account link ──
  await firebaseWrite('devices/d_e10ac3717a84bccb26f15a15869cd3d5', {
    tier: null,
    tierSince: null,
    tierSource: null,
    accountId: null,
  }).catch(() => {})
  console.log('test device reset')

  console.log('done')
  process.exit(0)
}

void main()
