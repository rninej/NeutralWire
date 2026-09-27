/**
 * test-digest-e2e.ts — prove the Resend newsletter delivery works
 * end-to-end (the new from-address ladder in digest.ts):
 *
 *   1. Calls deliverDigest directly with a synthetic newsletter aimed at
 *      the Resend account owner (the only address Resend's test sender
 *      may deliver to while neutralwire.org is unverified).
 *   2. Expects: { sent: true, via: 'resend' } — the branded from fails
 *      (domain not verified) → the ladder falls back to
 *      onboarding@resend.dev → real send.
 *   3. Verifies NO outbox entry was written (a send means no outbox).
 *   4. Cleans up.
 *
 * (The AI newsletter-writing half of the cron runs on Vercel where the
 * GEMINI/GROQ/OPENROUTER keys live — this sandbox has none, so the cron
 * path is verified via the route's auth/floor + this direct send test.)
 *
 * Run: bun scripts/test-digest-e2e.ts
 */
import { firebaseRead, firebaseDelete } from '../src/lib/firebase-server'
import { deliverDigest } from '../src/lib/digest'

const TEST_ID = 'e2e-digest-test'
const OWNER_EMAIL = 'mranalysechess@gmail.com'

async function main() {
  const newsletter = {
    subject: 'Your NeutralWire digest — pipeline test',
    html: `<h2>NeutralWire digest — E2E pipeline test</h2>
      <p>This email proves the full delivery ladder: the branded sender
      falls back to Resend's test sender while the domain is unverified,
      and the send lands for real.</p>
      <p>— The NeutralWire Editor</p>`,
  }

  console.log('calling deliverDigest →', OWNER_EMAIL)
  const result = await deliverDigest(TEST_ID, OWNER_EMAIL, newsletter)
  console.log('result:', JSON.stringify(result))

  const outbox = await firebaseRead<Record<string, unknown>>(`digestOutbox/${TEST_ID}`)
  console.log('outbox entries for test account:', outbox ? Object.keys(outbox).length : 0)

  await firebaseDelete(`digestOutbox/${TEST_ID}`).catch(() => {})
  console.log('cleaned up')

  const pass = result.sent && result.via === 'resend' && !outbox
  console.log(pass ? 'PASS — real Resend send, no outbox' : 'FAIL — see reason above')
  process.exit(pass ? 0 : 2)
}

void main()
