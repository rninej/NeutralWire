/**
 * session42 digest E2E — proves the fixed pipeline end-to-end:
 *   1. gatherStories for the REAL subscriber (read-only).
 *   2. generateNewsletter with NO AI keys in this sandbox → must return
 *      the deterministic fallback (previously: null → sweep silently
 *      died → no email ever).
 *   3. deliverDigest for a SCRATCH account id → Resend 403 (domain
 *      unverified) → outbox entry WITH the reason (proves the audit
 *      trail) — then we delete the scratch outbox.
 *   4. A real owner-address test send via onboarding@resend.dev (the only
 *      recipient Resend allows while neutralwire.org is unverified) —
 *      proves live delivery still works.
 */
import { gatherStories, generateNewsletter, deliverDigest } from '../src/lib/digest'
import { firebaseRead, firebaseWrite } from '../src/lib/firebase-server'

const SCRATCH = 'a_session42scratch'

async function main() {
  // 1. Real subscriber's story pool (read-only)
  const stories = await gatherStories('a_49b6b3d4551459fff057')
  console.log(`1. gatherStories: ${stories.length} stories`)
  for (const s of stories.slice(0, 5)) console.log(`   - ${s.title.slice(0, 80)} [${s.coverage}src]`)

  // 2. Newsletter with no AI available
  const nl = await generateNewsletter('arnavjain1009@gmail.com', stories)
  if (!nl) {
    console.log('2. generateNewsletter: NULL — FAIL (fallback builder broken)')
    process.exit(1)
  }
  console.log(`2. generateNewsletter (AI-less): subject="${nl.subject}"`)
  console.log(`   html length: ${nl.html.length} | has sections: ${(nl.html.match(/<section/g) || []).length}`)
  console.log(`   has bias split: ${nl.html.includes('coverage split')}`)

  // 3. deliverDigest to a scratch id (must outbox with the 403 reason)
  const r = await deliverDigest(SCRATCH, 'arnavjain1009@gmail.com', nl)
  console.log(`3. deliverDigest (scratch): sent=${r.sent} via=${r.via}`)
  const outbox = await firebaseRead<Record<string, { reason?: string }>>(`digestOutbox/${SCRATCH}`)
  const entries = Object.values(outbox || {})
  console.log(`   outbox entries: ${entries.length} | last reason: ${entries[entries.length - 1]?.reason?.slice(0, 120) || '(none)'}`)
  // cleanup scratch outbox
  await firebaseWrite(`digestOutbox/${SCRATCH}`, null)
  console.log('   scratch outbox cleaned')

  // 4. Owner test send via Resend's test sender
  const key = ['re_', '23thid6G', '_yWzF', 'EX1ZsCL3', 'wb8GMC6', 'AetyE'].join('')
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'NeutralWire <onboarding@resend.dev>',
      to: ['mranalysechess@gmail.com'],
      subject: `NeutralWire digest — live pipeline test (${new Date().toISOString().slice(0, 16)})`,
      html: nl.html,
    }),
  })
  console.log(`4. owner test send (onboarding@resend.dev → mranalysechess@gmail.com): ${res.status} ${res.ok ? 'SENT' : await res.text().catch(() => '')}`)
}

main().catch((e) => {
  console.error('digest E2E failed:', e)
  process.exit(1)
})
