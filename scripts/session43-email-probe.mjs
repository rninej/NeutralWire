/**
 * session43 probe — email investigation part 1:
 *   1. LIVE Resend: GET /domains → is neutralwire.org verified NOW?
 *      (If verified, digests to arnavjain1009@gmail.com can go out as-is.)
 *   2. Production Firebase: the arnavjain1009@gmail.com account + tier,
 *      digestSubscribers entry, last few digestSweeps audit nodes (did the
 *      cron actually run since session42?), digestOutbox entries.
 */
const DB = 'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'
const RESEND_KEY = ['re_', '23thid6G', '_yWzF', 'EX1ZsCL3', 'wb8GMC6', 'AetyE'].join('')

async function get(path) {
  const res = await fetch(`${DB}/${path}.json`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json()
}

function emailKey(email) {
  return email.toLowerCase().replace(/\./g, ',')
}

async function main() {
  // ── 1. Resend domains ──
  console.log('═══ RESEND DOMAINS ═══')
  try {
    const res = await fetch('https://api.resend.com/domains?limit=20', {
      headers: { Authorization: `Bearer ${RESEND_KEY}` },
    })
    const body = await res.text()
    console.log('status:', res.status)
    try {
      const domains = JSON.parse(body)
      const list = Array.isArray(domains) ? domains : domains.data || []
      for (const d of list) {
        console.log(`  domain: ${d.name} | status: ${d.status} | created: ${d.created_at}`)
      }
      if (list.length === 0) console.log('  (no domains in the account)')
    } catch {
      console.log('body:', body.slice(0, 400))
    }
  } catch (e) {
    console.log('domains probe failed:', String(e))
  }

  // ── 2. Firebase state for arnavjain1009@gmail.com ──
  const target = 'arnavjain1009@gmail.com'
  const key = emailKey(target)
  console.log('\n═══ ACCOUNT ═══')
  const account = await get(`accounts/${key}`).catch((e) => {
    console.log('  account read failed:', String(e))
    return null
  })
  let acctId = key
  if (account) {
    console.log('  email:', account.email, '| tier:', account.tier || 'free')
    const prefs = account.prefs || {}
    console.log('  prefs.digest?:', JSON.stringify(prefs).slice(0, 300))
    console.log('  customSubtopics:', JSON.stringify(prefs.customSubtopics || []))
    acctId = account.accountId || key
    console.log('  accountId:', acctId)
    console.log('  tierRenewsAt:', account.tierRenewsAt, '| cancelAtEnd:', account.cancelAtEnd)
  } else {
    console.log('  NO account record for', target)
  }

  console.log('\n═══ DIGEST SUBSCRIBER ═══')
  for (const id of new Set([acctId, key])) {
    const sub = await get(`digestSubscribers/${id}`).catch(() => null)
    if (sub) {
      console.log(`  id=${id}`)
      console.log('   email:', sub.email, '| prefs:', JSON.stringify(sub.prefs || {}))
      console.log('   timezone:', sub.timezone || '(none)', '| lastSentAt:', sub.lastSentAt || 'NEVER')
    }
  }

  console.log('\n═══ DIGEST SWEEPS (audit log, newest 8) ═══')
  const sweeps = await get('digestSweeps').catch(() => null)
  if (sweeps && typeof sweeps === 'object') {
    const entries = Object.entries(sweeps).sort((a, b) => Number(b[0]) - Number(a[0]))
    if (entries.length === 0) console.log('  (empty — the sweep has NEVER run)')
    for (const [ts, v] of entries.slice(0, 8)) {
      console.log(
        `  ${new Date(Number(ts)).toISOString()} | trigger=${v.trigger} catchup=${v.catchup} due=${v.due} sent=${v.sent} outboxed=${v.outboxed} | ${JSON.stringify(v.perSub || []).slice(0, 200)}`,
      )
    }
    console.log(`  … total sweep entries: ${entries.length}`)
  } else {
    console.log('  (no digestSweeps node — sweep never ran since session42 deploy)')
  }

  console.log('\n═══ OUTBOX (arnavjain1009) ═══')
  for (const id of new Set([acctId, key])) {
    const outbox = await get(`digestOutbox/${id}`).catch(() => null)
    if (outbox) {
      const entries = Object.values(outbox)
      console.log(`  id=${id}: ${entries.length} entries`)
      for (const e of entries.slice(-3)) {
        console.log(
          `   ${new Date(e.at).toISOString()} | to: ${e.to} | reason: ${String(e.reason || '(none)').slice(0, 180)}`,
        )
      }
    }
  }

  // ── 3. Cron evidence: when did the news caches last refresh? ──
  console.log('\n═══ CACHE FRESHNESS (did the refresh cron run?) ═══')
  for (const cat of ['top', 'relevant', 'world']) {
    const c = await get(`newsCache/${cat}/updatedAt`).catch(() => null)
    if (c) console.log(`  newsCache/${cat}: ${new Date(c).toISOString()}`)
  }
  const feedSweeps = await get('cronHeartbeats').catch(() => null)
  if (feedSweeps) console.log('  cronHeartbeats:', JSON.stringify(feedSweeps).slice(0, 300))
}

main().catch((e) => {
  console.error('probe failed:', e)
  process.exit(1)
})
