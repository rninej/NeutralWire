/**
 * video-quality.ts — the YouTube resolution + quality gate for the
 * experimental Watch feature (/api/video/[topicId]).
 *
 * Split out of the route so the parsers (ytInitialData walker, channel
 * subscriber scraper, duration parsers) are unit-testable in isolation —
 * they are the riskiest part of the feature (YouTube's HTML shapes drift
 * over time, and a broken parser must never silently let a junk video
 * through).
 *
 * QUALITY REQUIREMENTS (user spec): every YouTube video must
 *   - run LONGER THAN 10 SECONDS (the search result's lengthText — the
 *     only keyless server-side duration source: watch pages 429-block
 *     datacenter IPs and channel RSS carries no durations), and
 *   - come from a channel with AT LEAST 10,000 SUBSCRIBERS (scraped from
 *     the channel page).
 * checkYouTubeVideo() enforces both + liveness; searchYouTubeForStory()
 * applies them to search results, preferring uploads from the story's
 * own outlets ("the source's video").
 *
 * Everything here is server-side and keyless (no YouTube Data API):
 * the search results page, the oEmbed endpoint and the channel page are
 * all fetched with a browser User-Agent — the three YouTube surfaces
 * that reliably serve full content to datacenter IPs.
 */

// ── Quality requirements (user spec) ──
export const MIN_SUBSCRIBERS = 10_000
export const MIN_DURATION_SECONDS = 10 // must be strictly MORE than 10s

// ── Fetch helper ──

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'en-GB,en;q=0.9',
}

/** Timed GET → text (null on any failure/timeout/non-200). */
export async function fetchText(
  url: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        cache: 'no-store',
        headers: BROWSER_HEADERS,
      })
      if (!res.ok) return null
      return await res.text()
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

// ── YouTube URL / oEmbed helpers ──

/** Extract a YouTube videoId from any watch/short/youtu.be URL shape. */
export function youTubeIdFromUrl(url: string): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '').toLowerCase()
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0]
      return /^[\w-]{11}$/.test(id) ? id : null
    }
    if (host.endsWith('youtube.com')) {
      if (u.pathname === '/watch') {
        const v = u.searchParams.get('v')
        return v && /^[\w-]{11}$/.test(v) ? v : null
      }
      const shortMatch = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/)
      return shortMatch ? shortMatch[1] : null
    }
    return null
  } catch {
    const m = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/)
    return m ? m[1] : null
  }
}

/** oEmbed-verify a YouTube video and return its title + channel. */
export async function verifyYouTubeVideo(videoId: string): Promise<{
  title: string
  author: string
} | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${videoId}`,
      )}&format=json`,
      { signal: controller.signal, cache: 'no-store' },
    )
    clearTimeout(timer)
    if (!res.ok) return null
    const data = (await res.json()) as { title?: string; author_name?: string }
    if (!data?.title) return null
    return { title: data.title, author: data.author_name || 'YouTube' }
  } catch {
    return null
  }
}

// ── Requirement: duration (> 10 seconds) ──

/** "12:34" / "1:02:03" → seconds (null when not a duration). */
export function parseClockToSeconds(text: string): number | null {
  const parts = text.trim().split(':')
  if (parts.length < 2 || parts.length > 3) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null
  if (parts.length === 2) return nums[0] * 60 + nums[1]
  return nums[0] * 3600 + nums[1] * 60 + nums[2]
}

// ── Requirement: channel size (>= 10k subscribers) ──

/** "3.95M" / "12.4K" / "9,432" → a number (null when unparseable). */
export function parseCountText(raw: string): number | null {
  const m = raw.trim().match(/^([\d.,]+)\s*([KMBkmb])?$/)
  if (!m) return null
  const num = Number.parseFloat(m[1].replace(/,/g, ''))
  if (!Number.isFinite(num)) return null
  const mult = m[2]
    ? ({ k: 1e3, m: 1e6, b: 1e9 } as Record<string, number>)[m[2].toLowerCase()] ?? 1
    : 1
  return Math.round(num * mult)
}

/**
 * The subscriber count from a channel page's HTML. The count ships as
 * quoted text ("3.95M subscribers") in several renderer shapes across
 * the years — patterns are tried in order and the first that parses
 * wins (the channel's own header data appears before any related
 * channels' data in the page).
 */
export function subscribersFromChannelHtml(html: string): number | null {
  const patterns = [
    /"([\d.,]+\s*[KMBkmb]?)\s+subscribers?"/,
    />([\d.,]+\s*[KMBkmb]?)\s+subscribers?</,
    /([\d.,]+\s*[KMBkmb]?)\s+subscribers?/,
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m) {
      const n = parseCountText(m[1])
      if (n !== null) return n
    }
  }
  return null
}

export async function getChannelSubscribers(
  channelUrl: string,
): Promise<number | null> {
  const html = await fetchText(channelUrl, 6000)
  if (!html) return null
  return subscribersFromChannelHtml(html)
}

// ── The full quality gate for one YouTube video ──

export interface QualifiedVideo {
  videoId: string
  title: string
  author: string
}

/**
 * Check ONE YouTube video against ALL the requirements:
 *   1. duration KNOWN and strictly longer than 10 seconds — from the
 *      search result's lengthText. There is no other keyless server-
 *      side duration source for a bare videoId (the watch page 429-
 *      blocks datacenter IPs, and YouTube's channel RSS carries no
 *      durations), so a video with no duration hint NEVER plays —
 *      an unverifiable video is a rejected video.
 *   2. alive + embeddable — oEmbed resolves (dead/private/embed-disabled
 *      videos fail), also giving the canonical title + channel.
 *   3. channel size — at least 10k subscribers (channel page scrape).
 * Returns null when ANY check fails — the caller moves to the next
 * candidate, which is exactly the "skip junk" behaviour the user asked
 * for.
 */
export async function checkYouTubeVideo(
  videoId: string,
  opts: {
    channelUrlHint?: string | null
    durationHint?: number | null
  } | null,
  deadline: number,
): Promise<QualifiedVideo | null> {
  const o = opts || {}
  // 1. Duration must be known and strictly > 10s (no fetch needed).
  const seconds = typeof o.durationHint === 'number' ? o.durationHint : null
  if (seconds === null || !(seconds > MIN_DURATION_SECONDS)) return null
  if (!o.channelUrlHint) return null

  // 2. Alive/embeddable (oEmbed also gives canonical title + author).
  const embed = await verifyYouTubeVideo(videoId)
  if (!embed) return null
  if (Date.now() > deadline) return null

  // 3. Channel size.
  const subs = await getChannelSubscribers(o.channelUrlHint)
  if (subs === null || subs < MIN_SUBSCRIBERS) return null

  return { videoId, title: embed.title, author: embed.author }
}

// ── Relevance (search) ──

const YT_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'from', 'by', 'is', 'was', 'are', 'were', 'be', 'as', 'it', 'its',
  'this', 'that', 'new', 'news', 'video', 'watch', 'live', 'update', 'says',
  'said', 'after', 'amid', 'over', 'into', 'up', 'down', 'out', 'off',
])

function keywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !YT_STOPWORDS.has(w))
}

/** Count shared significant keywords between the story and a video title. */
function sharedKeywords(a: string, b: string): number {
  const ka = new Set(keywords(a))
  const kb = new Set(keywords(b))
  let shared = 0
  for (const w of ka) if (kb.has(w)) shared++
  return shared
}

export const NEWS_CHANNEL_HINTS = [
  'news', 'tv', 'times', 'bbc', 'cnn', 'guardian', 'reuters', 'sky', 'itv',
  'channel', 'abc', 'nbc', 'cbs', 'al jazeera', 'independent', 'telegraph',
  'post', 'express', 'mail', 'mirror', 'sun', 'press', 'journal', 'daily',
  'herald', 'agency', 'radio', 'media', 'group', 'broadcast', 'now', 'world',
]

export interface SearchCandidate {
  videoId: string
  title: string
  author: string
  channelUrl: string | null
  durationSec: number | null
}

// ── ytInitialData parsing ──

/**
 * Parse the JSON object starting at the '{' at `start` — brace-walking,
 * string/escape-aware (ytInitialData's JSON contains braces inside
 * strings, so a naive depth counter would desync).
 */
export function parseBraceJson(html: string, start: number): unknown | null {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < html.length; i++) {
    const c = html[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
    } else if (c === '{') {
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** Find + parse the ytInitialData blob (tries every assignment site). */
export function extractYtInitialData(html: string): unknown | null {
  // Matches "ytInitialData = {" (var assignment), 'ytInitialData"] = {'
  // and "ytInitialData'] = {" (window[...] assignments) — the quote /
  // bracket run after the identifier is optional and variable-length.
  const re = /ytInitialData["'\]]*\s*=\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const start = m.index + m[0].length - 1 // position of '{'
    const parsed = parseBraceJson(html, start)
    if (parsed !== null) return parsed
  }
  return null
}

/** Flatten a runs/simpleText YouTube text object. */
export function textOfRuns(node: Record<string, unknown> | undefined): string {
  if (!node) return ''
  if (typeof node.simpleText === 'string') return node.simpleText
  const runs = node.runs
  if (Array.isArray(runs)) {
    return runs
      .map((x) =>
        typeof (x as Record<string, unknown>)?.text === 'string'
          ? ((x as Record<string, unknown>).text as string)
          : '',
      )
      .join('')
  }
  return ''
}

/** One search result → a candidate (with duration + channel URL). */
export function candidateFromVideoRenderer(
  r: Record<string, unknown>,
): SearchCandidate | null {
  const videoId =
    typeof r.videoId === 'string' && /^[\w-]{11}$/.test(r.videoId)
      ? r.videoId
      : null
  if (!videoId) return null
  const title = textOfRuns(r.title as Record<string, unknown> | undefined)
  const ownerText = r.ownerText as Record<string, unknown> | undefined
  const author = textOfRuns(ownerText) || ''
  // Channel URL: the owner's browse endpoint carries a canonicalBaseUrl
  // ("/@handle") or a browseId ("UC…"); either works for the subs scrape.
  let channelUrl: string | null = null
  const runs = ownerText?.runs
  if (Array.isArray(runs) && runs.length > 0) {
    const endpoint = (runs[0] as Record<string, unknown>)?.navigationEndpoint as
      | Record<string, unknown>
      | undefined
    const browse = endpoint?.browseEndpoint as Record<string, unknown> | undefined
    const canonical =
      typeof browse?.canonicalBaseUrl === 'string' ? (browse.canonicalBaseUrl as string) : null
    if (canonical && canonical.startsWith('/')) {
      channelUrl = `https://www.youtube.com${canonical}`
    } else if (canonical && /^https?:/i.test(canonical)) {
      channelUrl = canonical
    } else if (typeof browse?.browseId === 'string') {
      channelUrl = `https://www.youtube.com/channel/${browse.browseId as string}`
    }
  }
  // Duration: lengthText.simpleText ("12:34"). Live streams carry none —
  // they fall through to the watch-page check, where lengthSeconds is 0.
  const lengthText = r.lengthText as Record<string, unknown> | undefined
  const durationSec =
    typeof lengthText?.simpleText === 'string'
      ? parseClockToSeconds(lengthText.simpleText as string)
      : null
  return { videoId, title, author, channelUrl, durationSec }
}

/** Depth-limited walk collecting videoRenderer objects in result order. */
export function collectSearchCandidates(
  node: unknown,
  out: SearchCandidate[],
  limit: number,
  depth = 0,
): void {
  if (out.length >= limit || depth > 14 || node === null || typeof node !== 'object') {
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      if (out.length >= limit) return
      collectSearchCandidates(item, out, limit, depth + 1)
    }
    return
  }
  const obj = node as Record<string, unknown>
  const renderer = obj.videoRenderer
  if (renderer && typeof renderer === 'object') {
    const c = candidateFromVideoRenderer(renderer as Record<string, unknown>)
    if (c) out.push(c)
  }
  for (const key of Object.keys(obj)) {
    if (out.length >= limit) return
    collectSearchCandidates(obj[key], out, limit, depth + 1)
  }
}

/**
 * Search YouTube for a video about the story that meets ALL the
 * requirements. Server-side scrape of the public results page: the HTML
 * embeds ytInitialData JSON whose videoRenderer entries carry the
 * videoId, title, channel, channel URL and duration.
 *
 * Candidates whose channel matches one of the story's OWN sources
 * (sourceNames, from the topic's articles) are tried FIRST — that's the
 * "uses the source's video" preference; a YouTube-shaped RSS videoUrl
 * or link can't be quality-checked directly (no keyless duration source
 * for a bare videoId), so finding the outlet's own upload in the search
 * results is how the source's video gets played.
 *
 * Every candidate — preferred or not — must be relevant (>=2 shared
 * significant keywords, >=1 for a source match, or >=1 + a news-y
 * channel) AND pass the full quality gate (>10s, alive, >=10k subs).
 * A news-y channel is kept as a weaker fallback, but it must pass the
 * same gate — nothing under 10k subs or 10 seconds ever plays.
 */
export async function searchYouTubeForStory(
  storyTitle: string,
  deadline: number,
  sourceNames: string[] = [],
): Promise<QualifiedVideo | null> {
  const query = storyTitle.replace(/["?&/\\]/g, ' ').slice(0, 70).trim() + ' news'
  if (!query.trim()) return null

  const html = await fetchText(
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`,
    8000,
  )
  if (!html) return null

  // Only metadata-bearing candidates can ever pass the gate (duration +
  // channel URL are mandatory hints) — candidates come exclusively from
  // ytInitialData's videoRenderer entries.
  const candidates: SearchCandidate[] = []
  const data = extractYtInitialData(html)
  if (data) collectSearchCandidates(data, candidates, 12)
  if (candidates.length === 0) return null

  // Source matching: normalized containment either way ("ABC News" vs
  // "ABC News (Australia)", "BBC" vs "BBC News"). Keys shorter than 3
  // chars are too fuzzy to match on.
  const normalizeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const sourceKeys = [...new Set(sourceNames.map(normalizeName))].filter(
    (k) => k.length >= 3,
  )
  const matchesSource = (author: string) => {
    const a = normalizeName(author)
    if (!a) return false
    return sourceKeys.some((k) => a.includes(k) || k.includes(a))
  }

  // Source's own uploads first, then plain result order.
  const preferred = candidates.filter((c) => c.title && matchesSource(c.author))
  const rest = candidates.filter((c) => !c.title || !matchesSource(c.author))
  const ordered = [...preferred, ...rest]

  let fallback: SearchCandidate | null = null
  for (const c of ordered.slice(0, 7)) {
    if (Date.now() > deadline) return null
    // A declared duration of <=10s (or none — live streams) disqualifies
    // immediately; the lengthText is the ONLY duration source.
    if (c.durationSec === null || !(c.durationSec > MIN_DURATION_SECONDS)) {
      continue
    }
    if (!c.title) continue
    const shared = sharedKeywords(storyTitle, c.title)
    const authorLower = c.author.toLowerCase()
    const looksLikeNews = NEWS_CHANNEL_HINTS.some((h) => authorLower.includes(h))
    const isSource = matchesSource(c.author)
    // A source's own video: weaker keyword bar (>=1 shared word) — the
    // channel already matches one of the story's outlets.
    if ((isSource && shared >= 1) || shared >= 2 || (shared >= 1 && looksLikeNews)) {
      const hit = await checkYouTubeVideo(
        c.videoId,
        { channelUrlHint: c.channelUrl, durationHint: c.durationSec },
        deadline,
      )
      if (hit) return hit
    } else if (!fallback && looksLikeNews) {
      fallback = c
    }
  }
  // Nothing matched by keywords — fall back to a news-y channel result
  // only if it ALSO passes the full quality gate.
  if (fallback && Date.now() < deadline) {
    const hit = await checkYouTubeVideo(
      fallback.videoId,
      { channelUrlHint: fallback.channelUrl, durationHint: fallback.durationSec },
      deadline,
    )
    if (hit) return hit
  }
  return null
}
