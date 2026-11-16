// Session64 smoke: bot-gate UA classification must gate crawlers and pass
// everything the site legitimately depends on (crons, real browsers,
// API clients, the mesh, service workers carry the browser UA).
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
process.exit(fails ? 1 : 0)
