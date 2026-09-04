/**
 * debug-video-search.ts — traces searchYouTubeForStory's parse of a real
 * YouTube results page: HTML size, ytInitialData extraction, candidate
 * list (videoId / title / author / channelUrl / duration), then the full
 * search call. For diagnosing search-path regressions.
 *
 * Run: bun scripts/debug-video-search.ts [query]
 */

import {
  fetchText,
  extractYtInitialData,
  candidateFromVideoRenderer,
  searchYouTubeForStory,
  getChannelSubscribers,
  checkYouTubeVideo,
  type SearchCandidate,
} from '../src/lib/video-quality'

const query = process.argv[2] || 'Nepal floods rescue tunnel'
const searchQ = encodeURIComponent(query + ' news')

const html = await fetchText(
  `https://www.youtube.com/results?search_query=${searchQ}&hl=en`,
  8000,
)
console.log('html length:', html?.length ?? 'null')
if (!html) process.exit(1)
console.log('raw videoRenderer occurrences:', (html.match(/"videoRenderer"/g) || []).length)
console.log('raw videoId occurrences:', (html.match(/"videoId":"/g) || []).length)

const data = extractYtInitialData(html)
console.log('extractYtInitialData:', data === null ? 'NULL (regex fallback path)' : 'parsed ok')

const cands: SearchCandidate[] = []
if (data) {
  const walk = (n: unknown, d = 0) => {
    if (cands.length >= 12 || d > 14 || n === null || typeof n !== 'object') return
    if (Array.isArray(n)) {
      n.forEach((x) => walk(x, d + 1))
      return
    }
    const obj = n as Record<string, unknown>
    if (obj.videoRenderer && typeof obj.videoRenderer === 'object') {
      const c = candidateFromVideoRenderer(obj.videoRenderer as Record<string, unknown>)
      if (c) cands.push(c)
    }
    Object.values(obj).forEach((v) => walk(v, d + 1))
  }
  walk(data)
}

console.log(`\ncandidates (${cands.length}):`)
for (const c of cands) {
  console.log(
    `  ${c.videoId}  ${(c.durationSec ?? 'live') + ''}s  ${c.author || '?'}  |  ${c.title.slice(0, 60)}  |  ${c.channelUrl || 'no-channel-url'}`,
  )
}

// Trace the checks on the first 3 candidates individually.
console.log('\nindividual checkYouTubeVideo traces (first 3):')
for (const c of cands.slice(0, 3)) {
  const t0 = Date.now()
  const res = await checkYouTubeVideo(
    c.videoId,
    { channelUrlHint: c.channelUrl, durationHint: c.durationSec },
    Date.now() + 30000,
  )
  const subs = c.channelUrl ? await getChannelSubscribers(c.channelUrl) : null
  console.log(
    `  ${c.videoId}: gate=${res ? 'PASS' : 'reject'} (${Date.now() - t0}ms)  duration=${c.durationSec ?? 'live'}  subs=${subs ?? 'unknown'}`,
  )
}

console.log('\nfull searchYouTubeForStory:')
const t0 = Date.now()
const hit = await searchYouTubeForStory(query, Date.now() + 60000)
console.log(
  hit
    ? `  PASS: ${hit.videoId} "${hit.title}" via ${hit.author} (${((Date.now() - t0) / 1000).toFixed(1)}s)`
    : `  NULL after ${((Date.now() - t0) / 1000).toFixed(1)}s`,
)
