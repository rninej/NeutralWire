/**
 * debug-watch-page.ts — diagnoses fetchWatchPageMeta on a real watch URL:
 * response status, HTML size, presence of videoDetails / lengthSeconds /
 * channelId, and consent-page detection.
 *
 * Run: bun scripts/debug-watch-page.ts [videoId]
 */

const videoId = process.argv[2] || 'eicBUu3reuo'

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 10000)
const res = await fetch(
  `https://www.youtube.com/watch?v=${videoId}&hl=en`,
  {
    signal: controller.signal,
    redirect: 'follow',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'en-GB,en;q=0.9',
    },
  },
)
clearTimeout(timer)
console.log('status:', res.status, 'final url:', res.url.slice(0, 90))
const html = await res.text()
console.log('html length:', html.length)

const checks: Array<[string, boolean]> = [
  ['"videoDetails":', html.includes('"videoDetails":')],
  ['"lengthSeconds"', html.includes('"lengthSeconds"')],
  ['ytInitialPlayerResponse', html.includes('ytInitialPlayerResponse')],
  ['ytInitialData', html.includes('ytInitialData')],
  ['consent.youtube.com', html.includes('consent.youtube.com')],
  ['<title>', html.includes('<title>')],
]
checks.forEach(([label, present]) => console.log(`  ${label} → ${present ? 'YES' : 'no'}`))

const titleMatch = html.match(/<title>([^<]{0,120})/)
console.log('title tag:', titleMatch?.[1])

const vd = html.indexOf('"videoDetails":')
if (vd !== -1) {
  const win = html.slice(vd, vd + 1500)
  const len = win.match(/"lengthSeconds"\s*:\s*"(\d+)"/)
  const chan = win.match(/"channelId"\s*:\s*"(UC[\w-]{20,})"/)
  const title = win.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  const author = win.match(/"author"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  console.log('videoDetails window (first 300):', win.slice(0, 300))
  console.log('len:', len?.[1], 'chan:', chan?.[1], 'title:', title?.[1], 'author:', author?.[1])
} else {
  // dump what player-response-ish markers exist
  const i = html.indexOf('ytInitialPlayerResponse')
  console.log(
    'ytInitialPlayerResponse context:',
    i === -1 ? 'absent' : html.slice(i, i + 200).replace(/\s+/g, ' '),
  )
  console.log(
    'head sample:',
    html.slice(0, 400).replace(/\s+/g, ' '),
  )
}

export {}
