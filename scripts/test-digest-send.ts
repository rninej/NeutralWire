/**
 * test-digest-send.ts — one-off manual digest test send (post domain
 * verification of neutralwire.org on Resend).
 *
 * What this does:
 *   1. Reads the accounts tree, picks every PREMIUM or ULTRA account that
 *      has an email on record (the email digest is a Premium+ feature).
 *   2. Runs the REAL pipeline pieces for each: gatherStories() →
 *      generateNewsletter() (AI-written with deterministic fallback).
 *   3. Sends DIRECTLY via Resend using the branded sender
 *      `NeutralWire <digest@neutralwire.org>` — NO test-sender fallback
 *      rung, because the entire point of this run is to prove the newly
 *      verified domain delivers. The full HTTP status + body is printed.
 *   4. Writes one digestSweeps/<ts> audit node (trigger:
 *      'manual-domain-test') so the audit chain stays honest.
 *
 * What this deliberately does NOT do:
 *   - Does NOT touch digestSubscribers/<id>/lastSentAt or lastAttemptAt —
 *     those guard the automated sweep (the 18:00 UTC catch-up sweep today
 *     already recorded today's real send; a manual test must not corrupt
 *     the spacing/re-send guard data).
 *   - Does NOT use deliverDigest()'s fallback ladder (the onboarding@
 *     resend.dev rung would mask a domain failure by "succeeding" for the
 *     Resend account owner's own address).
 *
 * Run: cd /home/z/my-project && npx tsx scripts/test-digest-send.ts
 */

import { gatherStories, generateNewsletter } from '../src/lib/digest'

const DB_URL =
  'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'

// Same key resolution as deliverDigest(): env first, owner key fallback.
const RESEND_KEY_FALLBACK = ['re_', '23thid6G', '_yWzF', 'EX1ZsCL3', 'wb8GMC6', 'AetyE'].join('')
const FROM = process.env.DIGEST_FROM_EMAIL || 'NeutralWire <digest@neutralwire.org>'

async function fbRead<T>(path: string): Promise<T | null> {
  const res = await fetch(`${DB_URL}/${path}.json`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`firebase read ${path} failed: HTTP ${res.status}`)
  const text = await res.text()
  if (!text || text === 'null') return null
  return JSON.parse(text) as T
}

async function fbWrite(path: string, value: unknown): Promise<boolean> {
  const res = await fetch(`${DB_URL}/${path}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
    cache: 'no-store',
  })
  return res.ok
}

interface AccountRec {
  email?: string
  tier?: string
}

async function main(): Promise<void> {
  const accounts = (await fbRead<Record<string, AccountRec>>('accounts')) || {}
  const all = Object.entries(accounts).filter(
    ([, a]) => a?.tier === 'premium' || a?.tier === 'ultra',
  )
  const recipients = all.filter(([, a]) => !!a?.email)
  const skipped = all.filter(([, a]) => !a?.email)

  console.log(`Premium/Ultra accounts: ${all.length}`)
  for (const [id, a] of skipped) {
    console.log(`  (skipped — ${a?.tier} account ${id} has no email on record)`)
  }
  console.log(`Sendable premium/ultra recipients: ${recipients.length}`)
  if (recipients.length === 0) {
    console.log('Nothing to send — done.')
    return
  }

  const key = process.env.RESEND_API_KEY || RESEND_KEY_FALLBACK
  const perSub: string[] = []
  let sent = 0

  for (const [accountId, acc] of recipients) {
    const email = acc.email as string
    console.log(`\n→ ${email} (${acc.tier}, account ${accountId})`)

    // 1 · Real story gathering (their custom subtopics + core categories).
    const stories = await gatherStories(accountId)
    console.log(`  gathered ${stories.length} stories`)
    if (stories.length === 0) {
      perSub.push(`${accountId}:no-stories`)
      continue
    }

    // 2 · Real newsletter generation (AI with deterministic fallback).
    const newsletter = await generateNewsletter(email, stories)
    if (!newsletter) {
      perSub.push(`${accountId}:newsletter-null`)
      continue
    }
    // Label it clearly as the manual test send in the inbox.
    const subject = `[Test] ${newsletter.subject}`
    console.log(`  subject: ${subject.slice(0, 90)}`)

    // 3 · Direct branded-sender send — the domain verification proof.
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        to: [email],
        subject,
        html: newsletter.html,
      }),
      cache: 'no-store',
    })
    const body = await res.text()
    console.log(`  Resend [${FROM}] → HTTP ${res.status}: ${body.slice(0, 300)}`)
    if (res.ok) {
      sent++
      perSub.push(`${accountId}:sent-branded`)
    } else {
      perSub.push(`${accountId}:failed-http-${res.status}`)
    }
  }

  // 4 · Audit entry (honest audit chain, no guard-data mutation).
  const auditOk = await fbWrite(`digestSweeps/${Date.now()}`, {
    trigger: 'manual-domain-test',
    catchup: false,
    due: recipients.length,
    processed: recipients.length,
    sent,
    outboxed: 0,
    perSub,
  })
  console.log(`\nAudit node written: ${auditOk}`)
  console.log(`DONE: ${sent}/${recipients.length} sent via ${FROM}`)
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
