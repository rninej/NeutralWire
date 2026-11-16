// Session65 smoke: the extended bot-diet + the home-ISR rewrite rules.
// Part 1 mirrors session64's UA gate matrix (still must hold).
// Part 2 exercises the EXACT middleware rewrite predicate against a
// faithful reimplementation of the middleware conditions, covering every
// navigation class that must keep hitting the dynamic '/' vs the ones
// that must be rewritten to the ISR /home shell.
const cases = [
  ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', true],
  ['Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', true],
  ['Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)', true],
  ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', true],
  ['Twitterbot/1.0', true],
  ['LinkedInBot/1.0 (compatible; LinkedIn/1.0)', true],
  ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot-News) Chrome/95.0', true],
  ['HeadlessChrome/120.0.0.0', true],
  ['cron-job.org/1.0 (+https://cron-job.org/)', false],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', false],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', false],
  ['Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36', false],
  ['', false],
]

const BOT_GATE_UA =
  /googlebot|google-inspectiontool|apis-google|bingbot|slurp|duckduckbot|yandexbot|baiduspider|facebookexternalhit|facebookbot|twitterbot|linkedinbot|semrushbot|ahrefsbot|mj12bot|petalbot|dotbot|applebot|applebot-extended|gptbot|chatgpt-user|claudebot|claude-web|ccbot|perplexitybot|bytespider|amazonbot|discordbot|discordapp|slackbot|slack-url-probe|telegrambot|whatsapp|embedly|vkshare|skypeuripreview|jetbot|headlesschrome|lighthouse|puppeteer|playwright|phantomjs|screaming frog|sitebulb|seobility|zgrab|whatweb|serpstatbot|dataforseo|ionico|spider|crawl/i

let fails = 0
for (const [ua, expectedGate] of cases) {
  const gated = ua ? BOT_GATE_UA.test(ua) : false
  const ok = gated === expectedGate
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  gate=${gated}  ua="${ua.slice(0, 60)}"`)
}

// ── Part 2: the middleware '/'→'/home' rewrite predicate ──
// (method GET && pathname '/' && no searchParams && no nw_nav cookie)
function shouldRewriteHome({ method, pathname, query, cookies }) {
  return (
    method === 'GET' &&
    pathname === '/' &&
    query === '' &&
    !(cookies || {}).nw_nav
  )
}

const navCases = [
  // MUST rewrite (plain crawls + cookie-less first-time users)
  { name: 'googlebot plain GET /', method: 'GET', pathname: '/', query: '', cookies: {}, expect: true },
  { name: 'first-time user GET / (no cookies)', method: 'GET', pathname: '/', query: '', cookies: {}, expect: true },
  { name: 'returning user, only irrelevant cookie', method: 'GET', pathname: '/', query: '', cookies: { theme: 'x' }, expect: true },
  // MUST NOT rewrite (dynamic '/' behaviour preserved)
  { name: '?topic= OG share link', method: 'GET', pathname: '/', query: '?topic=abc', cookies: {}, expect: false },
  { name: '?ref= referral link', method: 'GET', pathname: '/', query: '?ref=CODE', cookies: {}, expect: false },
  { name: '?category=top deep link', method: 'GET', pathname: '/', query: '?category=top', cookies: {}, expect: false },
  { name: 'nw_nav personal header cookie', method: 'GET', pathname: '/', query: '', cookies: { nw_nav: 'tabs' }, expect: false },
  { name: 'POST / (never a navigation)', method: 'POST', pathname: '/', query: '', cookies: {}, expect: false },
  { name: 'story page /story/x', method: 'GET', pathname: '/story/x', query: '', cookies: {}, expect: false },
  { name: 'privacy page', method: 'GET', pathname: '/privacy', query: '', cookies: {}, expect: false },
  { name: 'RSC-style GET / with ?_rsc', method: 'GET', pathname: '/', query: '?_rsc=1', cookies: {}, expect: false },
]

for (const c of navCases) {
  const rewrote = shouldRewriteHome(c)
  const ok = rewrote === c.expect
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  rewrite=${rewrote}  ${c.name}`)
}

// ── Part 3: gated-route inventory (all five bot-facing cut surfaces) ──
const fs = await import('node:fs')
const checks = [
  ['src/app/api/session/route.ts', 'botGate(POST$)'],
  ['src/app/api/referral/track/route.ts', 'botGate(POST$)'],
  ['src/app/api/engagement/route.ts', 'botGate(POST$)'],
  ['src/app/api/summary/route.ts', 'isBotRequest(req)'],
  ['src/app/api/news/route.ts', 'x-nw-bot-gate'],
  ['src/app/api/refresh/route.ts', 'botGate('],
  ['src/app/api/video/[topicId]/route.ts', 'botGate('],
  ['src/app/home/page.tsx', 'revalidate = 900'],
  ['src/app/story/[id]/page.tsx', 'revalidate = 86400'],
  ['src/middleware.ts', "NextResponse.rewrite(new URL('/home'"],
]
for (const [file, needle] of checks) {
  const src = fs.readFileSync(file, 'utf8')
  const ok = src.includes(needle)
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${file} contains ${JSON.stringify(needle)}`)
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL PASS')
process.exit(fails ? 1 : 0)
