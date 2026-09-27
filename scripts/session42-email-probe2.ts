/** session42 probe 2 — why has the sweep never produced a newsletter? */
const DB = 'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${DB}/${path}.json`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json()
}

async function main() {
  const acctId = 'a_49b6b3d4551459fff057'

  // accounts/<id> — does gatherStories find their record + customSubtopics?
  const account = (await get(`accounts/${acctId}`).catch((e) => String(e))) as Record<
    string,
    unknown
  > | null
  console.log('accounts/<id>:', account ? JSON.stringify(account).slice(0, 600) : 'MISSING')

  // outbox for the real account id
  const outbox = (await get(`digestOutbox/${acctId}`).catch(() => null)) as Record<
    string,
    Record<string, unknown>
  > | null
  if (outbox && Object.keys(outbox).length > 0) {
    console.log(`digestOutbox/${acctId}: ${Object.keys(outbox).length} entries`)
    for (const [k, e] of Object.entries(outbox).slice(-5)) {
      console.log(' ', k, new Date(e.at as number).toISOString(), '| reason:', String(e.reason || '(none)').slice(0, 160))
    }
  } else {
    console.log('digestOutbox/<id>: EMPTY — deliverDigest never ran for them')
  }

  // any global sweep log?
  for (const p of ['digestSweeps', 'cronLog', 'digestRuns', 'analytics/cron']) {
    const v = await get(p).catch(() => null)
    if (v) console.log(`${p}:`, JSON.stringify(v).slice(0, 400))
  }

  // newsCache keys present? (gatherStories reads top/world/technology/…)
  const cacheKeys = (await get('newsCache').catch(() => null)) as Record<string, unknown> | null
  if (cacheKeys) {
    console.log('newsCache keys:', Object.keys(cacheKeys).join(', '))
  }

  // customFeeds for their topics?
  const customFeeds = (await get('customFeeds').catch(() => null)) as Record<string, unknown> | null
  if (customFeeds) {
    console.log(
      'customFeeds:',
      Object.entries(customFeeds)
        .map(([k, v]) => `${k}(${(v as { topics?: unknown[] })?.topics?.length ?? '?'}topics)`)
        .join(', '),
    )
  }
}

main().catch((e) => {
  console.error('probe failed:', e)
  process.exit(1)
})
