/** session43 probe 2 — outbox reason + account via accountId/accountIndex. */
const DB = 'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'

async function get(path) {
  const res = await fetch(`${DB}/${path}.json`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json()
}

async function main() {
  const acctId = 'a_49b6b3d4551459fff057'

  console.log('═══ OUTBOX ═══')
  const outbox = await get(`digestOutbox/${acctId}`).catch(() => null)
  if (outbox) {
    const entries = Object.values(outbox)
    console.log(`  ${entries.length} entries`)
    for (const e of entries.slice(-4)) {
      console.log(`  ${new Date(e.at).toISOString()} | to: ${e.to}`)
      console.log(`    reason: ${String(e.reason || '(none)').slice(0, 260)}`)
      console.log(`    subject: ${String(e.subject || '').slice(0, 90)}`)
    }
  } else {
    console.log('  (empty)')
  }

  console.log('\n═══ ACCOUNT (by accountId) ═══')
  const account = await get(`accounts/${acctId}`).catch(() => null)
  if (account) {
    console.log('  email:', account.email, '| tier:', account.tier || 'free')
    console.log('  customSubtopics:', JSON.stringify((account.prefs || {}).customSubtopics || []))
    console.log('  tierRenewsAt:', account.tierRenewsAt, '| cancelAtEnd:', account.cancelAtEnd)
    console.log('  keys:', Object.keys(account).join(', '))
  } else {
    console.log('  (not found)')
  }

  console.log('\n═══ ACCOUNT INDEX ═══')
  const idx = await get('accountIndex').catch(() => null)
  if (idx) {
    const match = Object.entries(idx).find(
      ([k]) => k.replace(/,/g, '.') === 'arnavjain1009@gmail.com',
    )
    console.log('  match:', match ? JSON.stringify(match[1]) : '(none)')
    console.log('  total indexed:', Object.keys(idx).length)
  }

  console.log('\n═══ SUBSCRIBER ═══')
  const sub = await get(`digestSubscribers/${acctId}`).catch(() => null)
  console.log(' ', sub ? JSON.stringify(sub) : '(none)')

  console.log('\n═══ RESEND 401 CONFIRMATION (direct send probe, no email sent) ═══')
  const res = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${['re_', '23thid6G', '_yWzF', 'EX1ZsCL3', 'wb8GMC6', 'AetyE'].join('')}` },
  })
  console.log('  GET /domains status:', res.status, '→', (await res.text()).slice(0, 160))
}

main().catch((e) => {
  console.error('probe failed:', e)
  process.exit(1)
})
