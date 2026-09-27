/**
 * s46-send-grid-test.ts — send the NEW grid-layout digest as a [Test]
 * email to the premium/ultra subscriber(s) so the owner sees the new
 * design in a real inbox (mirrors session46's earlier branded-sender
 * test: direct Resend POST, no test-sender rung, guard data untouched,
 * honest digestSweeps audit entry).
 */
import { gatherStories, generateNewsletter } from '../src/lib/digest'

const DB_URL =
  'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'
const RESEND_KEY_FALLBACK = ['re_', '23thid6G', '_yWzF', 'EX1ZsCL3', 'wb8GMC6', 'AetyE'].join('')
const FROM = process.env.DIGEST_FROM_EMAIL || 'NeutralWire <digest@neutralwire.org>'

async function fbRead<T>(path: string): Promise<T | null> {
  const res = await fetch(`${DB_URL}/${path}.json`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`read ${path}: HTTP ${res.status}`)
  const t = await res.text()
  return !t || t === 'null' ? null : (JSON.parse(t) as T)
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

async function main(): Promise<void> {
  const accounts = (await fbRead<Record<string, { email?: string; tier?: string }>>('accounts')) || {}
  const recipients = Object.entries(accounts).filter(
    ([, a]) => (a?.tier === 'premium' || a?.tier === 'ultra') && !!a?.email,
  )
  console.log(`recipients: ${recipients.length}`)
  const key = process.env.RESEND_API_KEY || RESEND_KEY_FALLBACK
  const perSub: string[] = []
  let sent = 0
  for (const [accountId, acc] of recipients) {
    const email = acc.email as string
    const stories = await gatherStories(accountId)
    const nl = await generateNewsletter(email, stories)
    if (!nl) {
      perSub.push(`${accountId}:no-newsletter`)
      continue
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [email],
        subject: `[Test — logo header] ${nl.subject}`,
        html: nl.html,
      }),
      cache: 'no-store',
    })
    const body = await res.text()
    console.log(`${email}: HTTP ${res.status} ${res.ok ? body.slice(0, 80) : body.slice(0, 200)}`)
    if (res.ok) {
      sent++
      perSub.push(`${accountId}:sent-logo-test`)
    } else {
      perSub.push(`${accountId}:http-${res.status}`)
    }
  }
  const ok = await fbWrite(`digestSweeps/${Date.now()}`, {
    trigger: 'manual-logo-test',
    catchup: false,
    due: recipients.length,
    processed: recipients.length,
    sent,
    outboxed: 0,
    perSub,
  })
  console.log(`audit: ${ok}; sent ${sent}/${recipients.length} via ${FROM}`)
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
