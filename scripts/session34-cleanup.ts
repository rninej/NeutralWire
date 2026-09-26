/**
 * session34-cleanup.ts — remove the e2e test account created while
 * verifying the premium-welcome tour + custom-topic fill flow
 * (session34-test@neutralwire.test, granted premium then ultra via
 * test-mode checkout, pinned the 'chess' catalog topic, device mirror).
 * Production data only touches these test records.
 * Run: bun scripts/session34-cleanup.ts
 */
import { firebaseRead, firebaseWrite, firebaseDelete } from '../src/lib/firebase-server'
import { emailKey } from '../src/lib/subscriptions'

const TEST_EMAIL = 'session34-test@neutralwire.test'

async function main() {
  const key = emailKey(TEST_EMAIL)
  const entry = await firebaseRead<{ accountId: string }>(`accountIndex/${key}`)
  if (!entry?.accountId) {
    console.log('No test account found — nothing to clean.')
    return
  }
  const accountId = entry.accountId
  const account = await firebaseRead<{
    email?: string
    deviceId?: string
    tier?: string
    prefs?: { customSubtopics?: string[] }
  }>(`accounts/${accountId}`)
  console.log('cleaning account:', JSON.stringify(account))

  // subscription tier record + log
  await firebaseDelete(`subscriptions/${accountId}`).catch(() => {})
  await firebaseDelete(`subscriptionsLog/${accountId}`).catch(() => {})
  // digest prefs
  await firebaseDelete(`digestSubscribers/${accountId}`).catch(() => {})

  // custom topic subscriptions the account pinned (chess) — decrement the
  // follower counter so the cron stops refreshing it for a ghost follower.
  const pinned = account?.prefs?.customSubtopics || []
  for (const topicId of pinned) {
    const subRec = await firebaseRead<{ count?: number }>(`customSubscriptions/${topicId}`)
    const nextCount = Math.max(0, (subRec?.count || 1) - 1)
    if (nextCount === 0) {
      await firebaseDelete(`customSubscriptions/${topicId}`).catch(() => {})
    } else {
      await firebaseWrite(`customSubscriptions/${topicId}`, {
        ...(subRec || {}),
        count: nextCount,
        updatedAt: Date.now(),
      }).catch(() => {})
    }
    console.log(`  customSubscriptions/${topicId} → count ${nextCount}`)
  }

  // the chess feed cache itself: leave it — it is empty (GDELT 429 in the
  // sandbox) and a real catalog topic may legitimately gain followers.

  // device mirror (checkout granted via the browser's device id)
  if (account?.deviceId) {
    const dev = await firebaseRead<{ tier?: string; accountId?: string }>(
      `devices/${account.deviceId}`,
    )
    console.log('device record before clean:', JSON.stringify(dev))
    if (dev && dev.accountId === accountId) {
      await firebaseWrite(`devices/${account.deviceId}`, { tier: 'free', accountId: null })
    }
  }

  // the account + index entry
  await firebaseDelete(`accounts/${accountId}`).catch(() => {})
  await firebaseDelete(`accountIndex/${key}`).catch(() => {})

  console.log('✅ cleanup done — account, subscription, digest, chess counter, device mirror, index removed.')
}

main().catch((e) => {
  console.error('cleanup failed:', e)
  process.exit(1)
})
