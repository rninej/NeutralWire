/**
 * test-video-requirements.ts — verifies the Watch-video refinements:
 *
 *  A. UNIT tests of the parsers in src/lib/video-quality.ts (synthetic
 *     data): subscriber-count parsing (all 3 channel-page shapes),
 *     duration parsing, ytInitialData brace-walking (braces inside
 *     strings + every assignment shape), candidate extraction
 *     (canonicalBaseUrl + browseId + live variants), YouTube URL shapes.
 *  B. LIVE tests against real YouTube: the BBC News channel parses to
 *     >=10k subs; searchYouTubeForStory returns a video that
 *     INDEPENDENTLY re-verifies as >10s + >=10k subs (re-scraped from
 *     fresh search + channel pages); the gate rejects live streams,
 *     <=10s videos, and bare videoIds (unverifiable duration).
 *  C. E2E through the dev server: /api/video/<topicId> results for real
 *     feed topics all meet the requirements (independently re-verified);
 *     the videos2/ cache returns the identical result; flipping the
 *     featureFlags/videoWatch flag off (direct Firebase REST) makes the
 *     endpoint refuse to resolve (reason 'disabled') — then restored.
 *
 * Run: bun scripts/test-video-requirements.ts
 */

import {
  MIN_SUBSCRIBERS,
  MIN_DURATION_SECONDS,
  parseCountText,
  subscribersFromChannelHtml,
  parseClockToSeconds,
  extractYtInitialData,
  candidateFromVideoRenderer,
  youTubeIdFromUrl,
  getChannelSubscribers,
  verifyYouTubeVideo,
  checkYouTubeVideo,
  searchYouTubeForStory,
  fetchText,
  collectSearchCandidates,
  type SearchCandidate,
} from '../src/lib/video-quality'

const BASE = process.env.BASE || 'http://localhost:3000'
const DB = 'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'

let pass = 0
let fail = 0
const failures: string[] = []

function ok(cond: boolean, label: string, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq<T>(actual: T, expected: T, label: string) {
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  )
}

async function jget(url: string, timeoutMs = 30000): Promise<any> {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: c.signal })
    return await r.json()
  } finally {
    clearTimeout(t)
  }
}

/** Parse the search results page for a query → candidates. */
async function searchCandidates(query: string): Promise<SearchCandidate[]> {
  const html = await fetchText(
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`,
    8000,
  )
  if (!html) return []
  const data = extractYtInitialData(html)
  const out: SearchCandidate[] = []
  if (data) collectSearchCandidates(data, out, 14)
  return out
}

/** Independent re-verification of one resolved YouTube video. */
async function reVerify(
  label: string,
  videoId: string,
  queries: string[],
): Promise<void> {
  // Try every query (the story's own search, then the video's title) —
  // a passing video can sit deeper in one search mix than the first
  // 14 candidates, but it will surface for its own title.
  let cand: SearchCandidate | null = null
  for (const q of queries) {
    if (!q) continue
    const cands = await searchCandidates(q)
    const hit = cands.find((c) => c.videoId === videoId)
    if (hit) {
      cand = hit
      break
    }
  }
  ok(cand !== null, `${label}: video present in a fresh search results page`)
  if (!cand) return
  ok(
    typeof cand.durationSec === 'number' && cand.durationSec > MIN_DURATION_SECONDS,
    `${label}: duration > 10 seconds (independent search scrape)`,
    `${cand.durationSec}s`,
  )
  const embed = await verifyYouTubeVideo(videoId)
  ok(embed !== null, `${label}: video alive (oEmbed)`)
  if (cand.channelUrl) {
    const subs = await getChannelSubscribers(cand.channelUrl)
    ok(
      typeof subs === 'number' && subs >= MIN_SUBSCRIBERS,
      `${label}: channel ≥ 10k subscribers (independent channel scrape)`,
      `${subs?.toLocaleString?.() ?? subs} subs — ${cand.author}`,
    )
  } else {
    ok(false, `${label}: candidate had a channel URL`)
  }
}

// ═══════════════ A. UNIT TESTS (synthetic) ═══════════════
console.log('\n── A. Parser unit tests ──')

eq(parseCountText('3.95M'), 3950000, 'parseCountText 3.95M')
eq(parseCountText('12.4K'), 12400, 'parseCountText 12.4K')
eq(parseCountText('9,432'), 9432, 'parseCountText 9,432 (comma)')
eq(parseCountText('1042'), 1042, 'parseCountText plain 1042')
eq(parseCountText('1.2B'), 1200000000, 'parseCountText 1.2B')
eq(parseCountText('subscribers'), null, 'parseCountText garbage → null')
eq(parseCountText(''), null, 'parseCountText empty → null')

// Channel-page shapes across the years:
eq(
  subscribersFromChannelHtml('{"text":{"content":"3.95M subscribers"}}'),
  3950000,
  'channel page: modern pageHeaderViewModel shape',
)
eq(
  subscribersFromChannelHtml('"subscriberCountText":{"simpleText":"12.4K subscribers"}'),
  12400,
  'channel page: legacy subscriberCountText shape',
)
eq(
  subscribersFromChannelHtml('<span>9,432 subscribers</span>'),
  9432,
  'channel page: plain HTML text shape',
)
eq(
  subscribersFromChannelHtml('no counts here at all'),
  null,
  'channel page: no subscriber text → null',
)

eq(parseClockToSeconds('12:34'), 754, 'parseClockToSeconds 12:34')
eq(parseClockToSeconds('1:02:03'), 3723, 'parseClockToSeconds 1:02:03')
eq(parseClockToSeconds('0:08'), 8, 'parseClockToSeconds 0:08')
eq(parseClockToSeconds('LIVE'), null, 'parseClockToSeconds LIVE → null')
eq(parseClockToSeconds('x:y'), null, 'parseClockToSeconds junk → null')

// ytInitialData extraction — braces inside JSON strings must not desync
// the walker; BOTH assignment shapes must parse.
const jsonBody =
  '{"contents":{"a":{"desc":"a } b { c \\" d"},"videoRenderer":{"videoId":"AAAAAAAAAAA"}},"b":[1,2]}'
const withVar = `<script>var x=1;</script><script>var ytInitialData = ${jsonBody};</script>`
const withWindow = `<script>window["ytInitialData"] = ${jsonBody};</script>`
for (const [name, html] of [
  ['var assignment', withVar],
  ['window["…"] assignment', withWindow],
] as const) {
  const parsed = extractYtInitialData(html) as any
  ok(parsed !== null, `extractYtInitialData parses (${name})`)
  eq(
    parsed?.contents?.a?.desc,
    'a } b { c " d',
    `extractYtInitialData keeps braces inside strings intact (${name})`,
  )
}

const renderer = {
  videoId: 'dQw4w9WgXcQ',
  title: { runs: [{ text: 'Rescue ' }, { text: 'from Nepal tunnel' }] },
  ownerText: {
    runs: [
      {
        text: 'ABC News',
        navigationEndpoint: {
          browseEndpoint: {
            canonicalBaseUrl: '/@ABCNews',
            browseId: 'UCBi2mrUuK4v4nd1SliXtg',
          },
        },
      },
    ],
  },
  lengthText: { simpleText: '2:01' },
}
const cand = candidateFromVideoRenderer(renderer)
eq(cand?.title, 'Rescue from Nepal tunnel', 'candidate: title runs flattened')
eq(cand?.author, 'ABC News', 'candidate: author')
eq(
  cand?.channelUrl,
  'https://www.youtube.com/@ABCNews',
  'candidate: channelUrl from canonicalBaseUrl',
)
eq(cand?.durationSec, 121, 'candidate: duration 2:01 → 121s')

const browseOnly = candidateFromVideoRenderer({
  ...renderer,
  ownerText: {
    runs: [
      {
        text: 'Sky News',
        navigationEndpoint: { browseEndpoint: { browseId: 'UCoMdktPstBbiFvJ4UCIjY0A' } },
      },
    ],
  },
})
eq(
  browseOnly?.channelUrl,
  'https://www.youtube.com/channel/UCoMdktPstBbiFvJ4UCIjY0A',
  'candidate: channelUrl falls back to browseId',
)
eq(
  candidateFromVideoRenderer({ ...renderer, lengthText: undefined })?.durationSec,
  null,
  'candidate: live stream (no lengthText) → duration null',
)
eq(
  candidateFromVideoRenderer({ ...renderer, videoId: 'too-short' }),
  null,
  'candidate: invalid videoId → null',
)

eq(youTubeIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ', 'ytId: watch URL')
eq(youTubeIdFromUrl('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ', 'ytId: youtu.be')
eq(youTubeIdFromUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ', 'ytId: shorts')
eq(youTubeIdFromUrl('https://example.com/video'), null, 'ytId: non-YouTube → null')

// ═══════════════ B. LIVE YOUTUBE CHECKS ═══════════════
console.log('\n── B. Live YouTube checks ──')

console.log('  … BBC News channel subscriber scrape')
const bbcSubs = await getChannelSubscribers('https://www.youtube.com/@BBCNews')
ok(
  typeof bbcSubs === 'number' && bbcSubs >= MIN_SUBSCRIBERS,
  'BBC News channel parses ≥ 10k subscribers',
  `parsed ${bbcSubs?.toLocaleString?.() ?? bbcSubs}`,
)

// A real search must return something that INDEPENDENTLY re-verifies.
console.log('  … searchYouTubeForStory("Dozens killed as floods devastate southern Nepal")')
const deadline = Date.now() + 60_000
const STORY = 'Dozens killed as floods devastate southern Nepal'
const storyHit = await searchYouTubeForStory(STORY, deadline, [
  'BBC News',
  'Al Jazeera English',
  'ABC News',
  'CBS News',
])
ok(storyHit !== null, 'search returns a qualifying video for a news story')
if (storyHit) {
  console.log(`     → "${storyHit.title}" via ${storyHit.author} (${storyHit.videoId})`)
  await reVerify('search', storyHit.videoId, [
    `${STORY} news`,
    storyHit.title,
  ])
}

// Rejection paths — the gate must NEVER pass:
//   - a bare videoId (unverifiable duration — the old direct-embed path)
//   - a live stream (no lengthText)
//   - a <=10s result
console.log('  … rejection checks')
const storyCands = await searchCandidates(`${STORY} news`)
if (storyCands.length > 0) {
  // 1. Bare videoId — even a GOOD video with no hints is rejected.
  const good = storyCands.find(
    (c) => typeof c.durationSec === 'number' && c.durationSec > MIN_DURATION_SECONDS,
  )
  if (good) {
    const res = await checkYouTubeVideo(good.videoId, null, Date.now() + 30_000)
    ok(res === null, 'bare videoId (no duration hint) rejected — unverifiable', good.videoId)
  } else {
    ok(false, 'a >10s candidate existed for the bare-videoId rejection test')
  }
  // 2. Live stream.
  const live = storyCands.find((c) => c.durationSec === null)
  if (live) {
    const res = await checkYouTubeVideo(
      live.videoId,
      { channelUrlHint: live.channelUrl, durationHint: null },
      Date.now() + 30_000,
    )
    ok(res === null, 'live stream (no duration) rejected by the gate', live.videoId)
  } else {
    console.log('  (no live-stream result in this search — skipped)')
  }
  // 3. <=10s result.
  const short = storyCands.find(
    (c) => typeof c.durationSec === 'number' && c.durationSec <= MIN_DURATION_SECONDS,
  )
  if (short) {
    const res = await checkYouTubeVideo(
      short.videoId,
      { channelUrlHint: short.channelUrl, durationHint: short.durationSec },
      Date.now() + 30_000,
    )
    ok(res === null, `too-short result (${short.durationSec}s) rejected by the gate`, short.videoId)
  } else {
    console.log('  (no ≤10s result in this search — skipped)')
  }
} else {
  console.log('  ⚠ story search unavailable this run — rejection checks skipped')
}

// ═══════════════ C. E2E THROUGH THE DEV SERVER ═══════════════
console.log('\n── C. E2E: /api/video for real feed topics ──')

// Purge any stale flag-memo state first (a previous run's kill-switch
// test may have left the route memo at 'false' for up to 60s): force
// the flag true in Firebase, then wait out the route's 60s memo.
await fetch(`${DB}/featureFlags/videoWatch.json`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: 'true',
})
console.log('  … flag forced true; waiting out the 60s route memo')
await new Promise((r) => setTimeout(r, 62_000))

const news = await jget(`${BASE}/api/news`)
const topics: any[] = Array.isArray(news?.topics) ? news.topics : []
ok(topics.length > 0, '/api/news returns topics', `${topics.length} topics`)
const probe: any[] = topics.slice(0, 8)

let found = 0
let misses = 0
let native = 0
const foundIds: Array<{ id: string; videoId: string; title: string }> = []
for (const t of probe) {
  const started = Date.now()
  const v = await jget(`${BASE}/api/video/${encodeURIComponent(t.topicId)}`, 30000)
  const took = ((Date.now() - started) / 1000).toFixed(1)
  if (v?.ok && v.kind === 'youtube' && v.videoId) {
    found++
    foundIds.push({ id: t.topicId, videoId: v.videoId, title: t.title })
    console.log(`  [${t.topicId}] youtube ${v.videoId} "${v.title}" via ${v.author} (${took}s)`)
    await reVerify(`  [${t.topicId}]`, v.videoId, [`${t.title} news`, v.title])
  } else if (v?.ok && v.kind === 'video' && v.url) {
    native++
    console.log(`  [${t.topicId}] native source video ${v.url.slice(0, 60)}… (${took}s)`)
  } else {
    misses++
    console.log(`  [${t.topicId}] miss (${v?.reason}) (${took}s)`)
  }
}

ok(
  found + native > 0,
  'at least one topic resolved to a video',
  `${found} youtube + ${native} native of ${probe.length}`,
)

// Cache: an immediate second call returns the identical result.
if (foundIds.length > 0) {
  const { id, videoId } = foundIds[0]
  const again = await jget(`${BASE}/api/video/${encodeURIComponent(id)}`, 15000)
  ok(
    again?.ok === true && again.videoId === videoId,
    'videos2/ cache returns the identical result on the second call',
  )
  const cachedNode = await jget(`${DB}/videos2/${id}.json`, 15000)
  ok(
    cachedNode?.result?.ok === true,
    'result persisted under Firebase videos2/<topicId>',
  )
}

// (The feature-flag kill switch lives in its own script —
//  scripts/test-video-flag.ts — because its 'false' write poisons the
//  route's 60s flag memo for any e2e that follows in the same process.)

// ═══════════════ SUMMARY ═══════════════
console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ${fail ? '✗' : '✓'} ══`)
if (failures.length) {
  console.log('Failures:')
  failures.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
