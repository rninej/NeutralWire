/**
 * session33-cleanup.ts — remove the e2e test account created while
 * verifying the mobile subscription flows (mobile-test@neutralwire.test
 * + its premium grant + index + device mirror). Production data only
 * touches these test records. Run: bun scripts/session33-cleanup.ts
 */
import { firebaseRead, firebaseWrite, firebaseDelete } from '../src/lib/firebase-server'
import { emailKey } from '../src/lib/subscriptions'

const TEST_EMAIL = 'mobile-test@neutralwire.test'

async function main() {
  const key = emailKey(TEST_EMAIL)
  const entry = await firebaseRead<{ accountId: string }>(`accountIndex/${key}`)
  if (!entry?.accountId) {
    console.log('No test account found — nothing to clean.')
    return
  }
  const accountId = entry.accountId
  const account = await firebaseRead<{ email?: string; deviceId?: string; tier?: string }>(
    `accounts/${accountId}`,
  )
  console.log('cleaning account:', JSON.stringify(account))

  // subscription tier record + log
  await firebaseDelete(`subscriptions/${accountId}`).catch(() => {})
  await firebaseDelete(`subscriptionsLog/${accountId}`).catch(() => {})
  // digest prefs
  await firebaseDelete(`digestSubscribers/${accountId}`).catch(() => {})
  // custom subtopic subscriptions pinned by the account
  await firebaseDelete(`customSubscriptions/${accountId}`).catch(() => {})

  // device mirror (checkout granted via the browser's device id)
  if (account?.deviceId) {
    const dev = await firebaseRead<{ tier?: string; accountId?: string }>(`devices/${account.deviceId}`)
    console.log('device record before clean:', JSON.stringify(dev))
    if (dev && dev.accountId === accountId) {
      await firebaseWrite(`devices/${account.deviceId}`, { tier: 'free', accountId: null })
    }
  }

  // the account + index entry
  await firebaseDelete(`accounts/${accountId}`).catch(() => {})
  await firebaseDelete(`accountIndex/${key}`).catch(() => {})

  console.log('✅ cleanup done — account, subscription, digest, device mirror, index removed.')
}

main().catch((e) => {
  console.error('cleanup failed:', e)
  process.exit(1)
})
