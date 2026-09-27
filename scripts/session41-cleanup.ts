/**
 * session41-cleanup.ts — removes the E2E scratch records from Firebase:
 * the test account (+ its sessions + prefs), the runtime test topic, and
 * restores the customSubscriptions counts the E2E bumped (the real user's
 * artificial-intelligence subscription stays at 1; the chess entry the
 * test account created is removed). The ~60 customFeeds cache entries for
 * REAL catalog topics stay — they are legitimate warm caches produced by
 * the production pipeline.
 */
import { firebaseRead, firebaseWrite, firebaseDelete } from '../src/lib/firebase-server'

const ACCOUNT_ID = 'a_7493d0239b259f8ef88b'
const EMAIL_KEY = 'e_7493d0239b259f8ef88b'

async function main() {
  // 1. Delete the test account's sessions (find by accountId scan).
  const sessions = (await firebaseRead<Record<string, { accountId?: string }>>('sessions')) || {}
  let n = 0
  for (const [sid, s] of Object.entries(sessions)) {
    if (s?.accountId === ACCOUNT_ID) {
      await firebaseDelete(`sessions/${sid}`)
      n++
    }
  }
  console.log(`deleted ${n} sessions`)

  // 2. Delete account + index entry.
  await firebaseDelete(`accounts/${ACCOUNT_ID}`)
  await firebaseDelete(`accountIndex/${EMAIL_KEY}`)
  console.log('account + index deleted')

  // 3. Remove the runtime test topic (def + feed).
  await firebaseDelete('customSubtopics/test-runtime-topic')
  await firebaseDelete('customFeeds/test-runtime-topic')
  console.log('runtime test topic removed')

  // 4. Restore subscription counts: AI back to 1 (the real user), chess to 0.
  const subs =
    (await firebaseRead<Record<string, { count?: number; updatedAt?: number }>>('customSubscriptions')) || {}
  await firebaseWrite('customSubscriptions/artificial-intelligence', {
    count: Math.max(0, (subs['artificial-intelligence']?.count || 1) - 1),
    updatedAt: Date.now(),
  })
  await firebaseDelete('customSubscriptions/chess')
  console.log('subscription counts restored (AI=1, chess removed)')

  console.log('CLEANUP DONE')
  process.exit(0)
}

void main()
