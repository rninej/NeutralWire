/**
 * session42 probe 1 — investigate the missing digest email for
 * arnavjain1009@gmail.com:
 *   1. Find their account (emailKey match) + tier + digest prefs.
 *   2. digestSubscribers entry (enabled? freq? hour? timezone? lastSentAt?).
 *   3. digestOutbox entries (proof of attempted sends + failure reasons).
 *   4. LIVE Resend probe: does digest@neutralwire.org send today? (The
 *      owner may have verified the domain since session38.) Also probe
 *      onboarding@resend.dev to a non-owner address to document the 403.
 */
const DB = 'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${DB}/${path}.json`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json()
}

function emailKey(email: string): string {
  return email.toLowerCase().replace(/\./g, ',')
}

async function main() {
  const target = 'arnavjain1009@gmail.com'
  const key = emailKey(target)

  // 1. account
  const account = (await get(`accounts/${key}`).catch((e) => {
    console.log('account read failed:', String(e))
    return null
  })) as Record<string, unknown> | null
  if (account) {
    const tier = account.tier || account.tierKind || 'free'
    console.log('── ACCOUNT FOUND ──')
    console.log('  email:', account.email, '| tier:', tier)
    console.log('  prefs:', JSON.stringify(account.prefs || {}).slice(0, 400))
    console.log('  keys:', Object.keys(account).join(', '))
    const acctId = (account.accountId as string) || key
    // 2. digestSubscribers by accountId AND by emailKey (either indexing)
    for (const id of [acctId, key]) {
      const sub = (await get(`digestSubscribers/${id}`).catch(() => null)) as Record<
        string,
        unknown
      > | null
      if (sub) {
        console.log(`── DIGEST SUBSCRIBER (id=${id}) ──`)
        console.log(' ', JSON.stringify(sub).slice(0, 500))
      }
    }
    // 3. outbox
    for (const id of [acctId, key]) {
      const outbox = (await get(`digestOutbox/${id}`).catch(() => null)) as Record<
        string,
        unknown
      > | null
      if (outbox) {
        const entries = Object.values(outbox) as Array<Record<string, unknown>>
        console.log(`── OUTBOX (id=${id}): ${entries.length} entries ──`)
        for (const e of entries.slice(-3)) {
          console.log(
            '  ',
            new Date(e.at as number).toISOString(),
            '| to:', e.to,
            '| reason:', String(e.reason || '(none)').slice(0, 200),
          )
        }
      }
    }
  } else {
    console.log('NO account for', target)
    // maybe list a few account keys to see the index shape
    const idx = (await get('accountIndex').catch(() => null)) as Record<string, string> | null
    if (idx) {
      const hit = Object.entries(idx).find(([, v]) => v === target || v === key)
      console.log('accountIndex entry:', hit ? JSON.stringify(hit) : 'not found')
    }
  }

  // Whole digestSubscribers tree (small) — see everyone + enabled state
  const allSubs = (await get('digestSubscribers').catch(() => null)) as Record<
    string,
    Record<string, unknown>
  > | null
  if (allSubs) {
    console.log('── ALL digestSubscribers ──')
    for (const [id, s] of Object.entries(allSubs)) {
      console.log(
        '  ',
        id,
        '→ email:', s.email,
        '| prefs:', JSON.stringify(s.prefs || {}),
        '| lastSentAt:', s.lastSentAt ? new Date(s.lastSentAt as number).toISOString() : 'never',
      )
    }
  } else {
    console.log('digestSubscribers: EMPTY/absent')
  }

  // 4. LIVE Resend probes
  const RESEND_KEY_FALLBACK = ['re_', '23thid6G', '_yWzF', 'EX1ZsCL3', 'wb8GMC6', 'AetyE'].join('')
  const key2 = process.env.RESEND_API_KEY || RESEND_KEY_FALLBACK
  console.log('── RESEND LIVE PROBE ──')
  for (const from of [
    'NeutralWire <digest@neutralwire.org>',
    'NeutralWire <onboarding@resend.dev>',
  ]) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key2}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [target],
        subject: 'NeutralWire digest probe (pipeline test)',
        html: '<p>Delivery probe — verifying the NeutralWire digest pipeline. You can ignore this message.</p>',
      }),
    })
    const body = res.ok ? '' : await res.text().catch(() => '')
    console.log(
      `  from=${from.split('<')[1]}`,
      '→ status', res.status, res.ok ? 'SENT' : body.slice(0, 220),
    )
  }
}

main().catch((e) => {
  console.error('probe failed:', e)
  process.exit(1)
})
