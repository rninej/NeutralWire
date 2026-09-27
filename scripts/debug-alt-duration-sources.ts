/**
 * debug-alt-duration-sources.ts — checks whether youtube.com/embed/ID or
 * m.youtube.com/watch (or the channel RSS) expose video duration from a
 * server IP where the desktop watch page is 429-blocked.
 *
 * Run: bun scripts/debug-alt-duration-sources.ts [videoId]
 */

const videoId = process.argv[2] || 'eicBUu3reuo'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

async function probe(name: string, url: string) {
  try {
    const c = new AbortController()
    const t = setTimeout(() => c.abort(), 10000)
    const res = await fetch(url, {
      signal: c.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-GB,en;q=0.9' },
    })
    clearTimeout(t)
    const html = await res.text()
    const len = html.match(/"lengthSeconds"\s*:\s*"?(\d+)"?/)
    const chan = html.match(/"(?:channelId|externalChannelId)"\s*:\s*"(UC[\w-]{20,})"/)
    const title = html.match(/<title>([^<]{0,80})/)
    console.log(
      `${name}: status=${res.status} bytes=${html.length} lengthSeconds=${len?.[1] ?? '-'} channel=${chan?.[1] ?? '-'} title=${title?.[1] ?? '-'}`,
    )
  } catch (e) {
    console.log(`${name}: FAILED ${String(e).slice(0, 80)}`)
  }
}

await probe('embed page', `https://www.youtube.com/embed/${videoId}?hl=en`)
await probe('m.watch', `https://m.youtube.com/watch?v=${videoId}&hl=en`)
await probe('www.watch (control)', `https://www.youtube.com/watch?v=${videoId}&hl=en`)
await probe('shorts', `https://www.youtube.com/shorts/${videoId}?hl=en`)

// Channel RSS for BBC News (UC16niRr50-MSBwiO3YAt3SQ)
try {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), 10000)
  const res = await fetch(
    'https://www.youtube.com/feeds/videos.xml?channel_id=UC16niRr50-MSBwiO3YAt3SQ',
    { signal: c.signal, headers: { 'User-Agent': UA } },
  )
  clearTimeout(t)
  const xml = await res.text()
  console.log(
    `channel RSS: status=${res.status} bytes=${xml.length} hasDuration=${xml.includes('duration')} hasOurVideo=${xml.includes(videoId)}`,
  )
  const durMatch = xml.match(/<yt:duration seconds="(\d+)"\/>/)
  console.log(`  first yt:duration: ${durMatch?.[1] ?? 'none'}`)
} catch (e) {
  console.log(`channel RSS: FAILED ${String(e).slice(0, 80)}`)
}

export {}
