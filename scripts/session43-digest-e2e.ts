/**
 * session43-digest-e2e.ts — live E2E of the NEW digest sweep logic:
 *   1. First sweep: the real subscriber (arnavjain1009@gmail.com, whose
 *      false lastSentAt was just deleted) is due → newsletter builds →
 *      Resend attempt 403s (domain still unverified) → OUTBOXED with the
 *      new failure slug, lastAttemptAt + lastFailure written, lastSentAt
 *      NOT written (the session43 fix).
 *   2. Second immediate sweep: spacing guard holds the subscriber back
 *      (due=0) — no outbox spam.
 */
import { digestSweep } from '../src/lib/digest'
import { firebaseRead } from '../src/lib/firebase-server'

async function main() {
  const ACCT = 'a_49b6b3d4551459fff057'

  console.log('── sweep 1 (catch-up) ──')
  const t0 = Date.now()
  const r1 = await digestSweep({ catchup: true, cap: 3, trigger: 'session43-local-e2e' })
  console.log(`result: due=${r1.due} sent=${r1.sent} outboxed=${r1.outboxed} (${Date.now() - t0}ms)`)

  const sub = await firebaseRead<{
    email: string
    lastSentAt?: number
    lastAttemptAt?: number
    lastFailure?: { slug?: string; status?: number }
  }>(`digestSubscribers/${ACCT}`)
  console.log('subscriber after sweep 1:')
  console.log('  email:', sub?.email)
  console.log('  lastSentAt:', sub?.lastSentAt ?? 'NOT SET (correct for a failed send)')
  console.log('  lastAttemptAt:', sub?.lastAttemptAt ? new Date(sub.lastAttemptAt).toISOString() : 'MISSING')
  console.log('  lastFailure:', JSON.stringify(sub?.lastFailure || null))

  console.log('\n── sweep 2 (immediately after — spacing guard) ──')
  const r2 = await digestSweep({ catchup: true, cap: 3, trigger: 'session43-local-e2e-2' })
  console.log(`result: due=${r2.due} sent=${r2.sent} outboxed=${r2.outboxed}`)
  console.log(
    r2.due === 0
      ? '  ✓ spacing guard held the subscriber back (due=0)'
      : '  ✗ SPACING GUARD FAILED — subscriber re-processed immediately',
  )

  // Latest audit node
  const sweeps = await firebaseRead<Record<string, { trigger: string; due: number; sent: number; outboxed: number; perSub?: string[] }>>('digestSweeps')
  const latest = Object.entries(sweeps || {})
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .slice(0, 2)
  console.log('\nlatest audit nodes:')
  for (const [ts, v] of latest) {
    console.log(`  ${new Date(Number(ts)).toISOString()} | ${v.trigger} | due=${v.due} sent=${v.sent} outboxed=${v.outboxed} | ${JSON.stringify(v.perSub || [])}`)
  }
}

main().catch((e) => {
  console.error('digest e2e failed:', e)
  process.exit(1)
})
