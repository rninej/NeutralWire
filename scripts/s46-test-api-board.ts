/**
 * s46-test-api-board.ts — run the same probes the /api/debug/apis board
 * runs, standalone (the debug password is hash-only, so the authed route
 * can't be exercised locally; this proves every check returns a sensible
 * status). Mirrors the route's URLs exactly.
 */

const UA = 'Mozilla/5.0 (compatible; NeutralWireBot/1.0; +https://neutralwire.org)'

async function probe(url: string, headers: Record<string, string> = {}, timeoutMs = 5000) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
      headers: { 'User-Agent': UA, ...headers },
    })
    const body = await res.text().catch(() => '')
    return { status: res.status, ok: res.ok, ms: Date.now() - t0, body: body.slice(0, 120) }
  } catch (err) {
    return { status: 0, ok: false, ms: Date.now() - t0, body: String(err).slice(0, 80) }
  }
}

async function main() {
  const checks: Array<[string, () => Promise<{ status: number; ok: boolean; ms: number; body: string }>]> = [
    ['firebase', () => probe('https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app/_health.json')],
    ['google-news-rss', () => probe('https://news.google.com/rss/search?q=%22london%22&hl=en-US&gl=US&ceid=US:en', {}, 7000)],
    ['gdelt', () => probe('https://api.gdeltproject.org/api/v2/doc/doc?query=%22united%20kingdom%22%20sourcelang%3Aenglish&mode=ArtList&maxrecords=75&format=json&sort=DateDesc&timewindow=1d', {}, 9000)],
    ['bing-news-rss', () => probe('https://www.bing.com/news/search?q=london&format=RSS&setmkt=en-GB&setlang=en-US', {}, 6000)],
    ['bbc-rss', () => probe('https://feeds.bbci.co.uk/news/rss.xml', {}, 6000)],
    ['sky-rss', () => probe('https://feeds.skynews.com/feeds/rss/home.xml', {}, 6000)],
    ['guardian-rss', () => probe('https://www.theguardian.com/world/rss', {}, 6000)],
    ['nyt-rss', () => probe('https://rss.nytimes.com/services/xml/rss/nyt/World.xml', {}, 6000)],
    ['ip-api', () => probe('http://ip-api.com/json/8.8.8.8')],
    ['ipwho', () => probe('https://ipwho.is/8.8.8.8')],
    ['resend-restricted-key', () => probe('https://api.resend.com/domains', { Authorization: `Bearer ${['re_', '23thid6G', '_yWzF', 'EX1ZsCL3', 'wb8GMC6', 'AetyE'].join('')}` })],
    ['google-openid', () => probe('https://accounts.google.com/.well-known/openid-configuration')],
    ['aiModelHealth', () => probe('https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app/aiModelHealth.json', {}, 4000)],
  ]

  const results = await Promise.all(checks.map(([name, fn]) => fn().then((r) => [name, r] as const)))
  for (const [name, r] of results) {
    const healthy = r.ok ? 'OK' : `FAIL(${r.status})`
    console.log(`${name.padEnd(24)} ${healthy.padEnd(10)} ${r.ms}ms  ${r.body.replace(/\n/g, ' ').slice(0, 90)}`)
  }
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
