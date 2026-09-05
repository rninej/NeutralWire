'use client'

/**
 * video-preview-store.ts — session-level plumbing shared by the home-feed
 * video preview and the article's inline player.
 *
 * Three concerns, all client-side:
 *
 *  1. VIDEO HANDOFF (preview click → article autoplays). When a card's
 *     preview is PLAYING and the user taps the card, the article must
 *     open with the video already rolling — not the photo + Watch
 *     square (user spec). Rather than change every onOpenDetail
 *     signature in the tree (topic card → feed layout → page client →
 *     detail), the card's click handler ARMS the topic here
 *     synchronously before calling onOpenDetail, and TopicDetail
 *     CONSUMES it (one-shot) on mount — the resolved video object is
 *     handed over directly, so the article never re-fetches and never
 *     shows a loading state.
 *
 *  2. USER LOCALE for /api/video (user spec: "the videos should be in
 *     the language you are in — UK → English"). The app already knows
 *     the user's country (manual picker or auto-detect) and the
 *     language chosen in onboarding; this helper turns those into
 *     hl=/gl= query params the resolver forwards to YouTube search.
 *
 *  3. RESOLUTION THROTTLING. The preview now arms on EVERY big card
 *     (user: "for every news which has the large news card, load them
 *     too when I scroll down") — without a limiter, a fast scroll could
 *     fire a dozen simultaneous /api/video resolutions. A tiny
 *     semaphore (max 2 in flight) keeps the queue sane; each request
 *     waits its turn and always releases.
 */

/** The resolved-video shape shared between the preview and the player
 *  (subset of /api/video's VideoResult — only what playback needs). */
export interface ResolvedVideo {
  ok: true
  kind: 'youtube' | 'video'
  videoId?: string
  url?: string
  title?: string
  author?: string
  sourceUrl?: string
  /** w/h of the actual video — 0.5625 for a portrait Short, 1.778 for 16:9. */
  aspect?: number
}

// ── 1. Video handoff ──

/** Previews that are (or were) playing, keyed by topicId. */
const playingByTopic = new Map<string, ResolvedVideo>()

/** One-shot "open with the video rolling" requests, keyed by topicId. */
const armedByTopic = new Map<string, ResolvedVideo>()

/** Called by HeroVideoPreview when its video actually starts PLAYING. */
export function markPreviewPlaying(topicId: string, video: ResolvedVideo): void {
  playingByTopic.set(topicId, video)
}

/** Called when the preview unloads (off-screen / broken / unmounted). */
export function clearPreviewPlaying(topicId: string): void {
  playingByTopic.delete(topicId)
}

/**
 * Called by the CARD's click handler (synchronously, before
 * onOpenDetail) — if this card's preview is playing, arm the topic so
 * the article opens with the video rolling. Cheap no-op otherwise.
 */
export function armVideoIfPlaying(topicId: string): void {
  const video = playingByTopic.get(topicId)
  if (video) armedByTopic.set(topicId, video)
}

/**
 * Called once by TopicDetail on mount — returns the armed video for
 * THIS topic (and clears it) so the article starts playing it
 * immediately. A different topic's arm is left alone; a stale arm
 * never fires twice.
 */
export function consumeVideoAutoplay(topicId: string): ResolvedVideo | null {
  const video = armedByTopic.get(topicId)
  if (video) armedByTopic.delete(topicId)
  return video ?? null
}

// ── 2. User locale → /api/video query params ──

/** Valid two-letter language codes we will forward to YouTube (hl=). */
const HL_OK = new Set([
  'en', 'hi', 'zh', 'es', 'fr', 'ar', 'de', 'ja', 'ko', 'pt', 'it', 'ru',
  'tr', 'nl', 'sv', 'pl', 'ur', 'bn', 'th', 'vi', 'id', 'ms', 'fa', 'he',
  'el', 'uk', 'no', 'da', 'fi', 'cs', 'ro', 'hu', 'tl',
])

interface LocaleInfo {
  hl: string
  gl: string
}

/**
 * The user's country + language, as best known client-side. Priority:
 *   1. The language picked in onboarding (neutralwire:language) — the
 *      user's own explicit choice of content language.
 *   2. The manual country picker (neutralwire:country-manual) → its
 *      primary language.
 *   3. The auto-detected country (neutralwire:country) → primary
 *      language. English-speaking countries resolve to 'en'.
 *   4. navigator.language (browser UI language, e.g. "en-GB").
 */
function resolveLocale(): LocaleInfo {
  let hl = ''
  let gl = ''

  // Country — manual override first, then auto-detect cache.
  try {
    const manual = localStorage.getItem('neutralwire:country-manual')
    const auto = manual ? null : localStorage.getItem('neutralwire:country')
    const raw = manual || auto
    if (raw) {
      const parsed = JSON.parse(raw) as { code?: string; info?: { code?: string } }
      gl = (manual ? parsed?.code : parsed?.info?.code) || ''
    }
  } catch {
    // malformed — ignore
  }

  // Explicit language choice from onboarding wins over the country.
  try {
    const lang = localStorage.getItem('neutralwire:language')
    if (lang && HL_OK.has(lang)) hl = lang
  } catch {
    // ignore
  }

  // No explicit language → derive from the country's primary language.
  if (!hl && gl) {
    // Avoid importing country-languages (keeps this lib SSR-safe to
    // import anywhere): a tiny inline map of the non-English primaries.
    const byCountry: Record<string, string> = {
      JP: 'ja', KR: 'ko', CN: 'zh', TW: 'zh', DE: 'de', AT: 'de', CH: 'de',
      FR: 'fr', ES: 'es', IT: 'it', NL: 'nl', BE: 'nl', SE: 'sv', NO: 'no',
      DK: 'da', FI: 'fi', PL: 'pl', CZ: 'cs', RO: 'ro', HU: 'hu', GR: 'el',
      PT: 'pt', BR: 'pt', MX: 'es', AR: 'es', CL: 'es', CO: 'es', PE: 'es',
      VE: 'es', IL: 'he', AE: 'ar', SA: 'ar', QA: 'ar', IQ: 'ar', EG: 'ar',
      MA: 'ar', TR: 'tr', IR: 'fa', PK: 'ur', BD: 'bn', TH: 'th', VN: 'vi',
      ID: 'id', MY: 'ms', RU: 'ru', UA: 'uk', BY: 'be',
    }
    hl = byCountry[gl.toUpperCase()] || 'en'
  }

  // Last resort: the browser's UI language (e.g. "en-GB" → hl=en, gl=GB).
  if (!hl && typeof navigator !== 'undefined') {
    const tag = (navigator.language || 'en').toLowerCase()
    const m = tag.match(/^([a-z]{2})(?:[-_]([a-z]{2}))?/)
    if (m) {
      hl = HL_OK.has(m[1]) ? m[1] : 'en'
      if (!gl && m[2] && /^[a-z]{2}$/.test(m[2])) {
        // Region subtag is meaningful (en-GB ≠ en-US) — use it.
        gl = m[2].toUpperCase()
      }
    }
  }

  return { hl: hl || 'en', gl: /^[A-Za-z]{2}$/.test(gl) ? gl.toUpperCase() : '' }
}

let cachedLocale: { value: string; ts: number } | null = null

/**
 * Locale params for /api/video — "hl=en&gl=GB". Memoized per page load
 * (the country/language can only change via a full reload anyway).
 */
export function videoLocaleParams(): string {
  if (cachedLocale && Date.now() - cachedLocale.ts < 60_000) {
    return cachedLocale.value
  }
  const { hl, gl } = resolveLocale()
  const value = gl ? `hl=${hl}&gl=${gl}` : `hl=${hl}`
  cachedLocale = { value, ts: Date.now() }
  return value
}

/** The hl (language) alone — for cache keys / display. */
export function videoLocaleHl(): string {
  const m = videoLocaleParams().match(/hl=([a-z]+)/)
  return m ? m[1] : 'en'
}

// ── 3. Resolution throttle (max 2 concurrent /api/video fetches) ──

const MAX_IN_FLIGHT = 2
let inFlight = 0
const waiters: Array<() => void> = []

/**
 * Waits for a resolution slot. Returns a release() that MUST be called
 * (finally-style). Extra callers queue FIFO — a fast scroll past ten
 * hero cards resolves them two at a time instead of hammering the API.
 */
export function acquirePreviewSlot(): Promise<() => void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++
    return Promise.resolve(() => {
      inFlight--
      const next = waiters.shift()
      if (next) next()
    })
  }
  return new Promise((resolve) => {
    waiters.push(() => {
      // A slot just freed for this waiter — claim it (the releaser
      // already decremented; incrementing here keeps inFlight == the
      // number of holders).
      inFlight++
      resolve(() => {
        inFlight--
        const next = waiters.shift()
        if (next) next()
      })
    })
  })
}

// ── 4. Single audible preview (audio lease) ──
// Every big card can roll a preview now — but two previews playing
// sound at once would be a wall of noise. ONE topic holds the "sound
// lease"; every other concurrently playing preview is muted and queued.
// When the audible one unloads (scrolled off), the longest-queued
// preview is granted the lease and un-mutes (still at half volume).

let audioLeaseHolder: string | null = null
const audioLeaseWaiters = new Map<string, () => void>()

/**
 * Claim the single audible-preview slot (topicId-keyed). Returns true
 * when the caller now owns the lease (play sound at half volume);
 * false when someone else is audible — the caller should start muted.
 * If granted, the caller MUST releasePreviewAudio(topicId) when it
 * unloads.
 */
export function claimPreviewAudio(topicId: string): boolean {
  if (audioLeaseHolder === null) {
    audioLeaseHolder = topicId
    return true
  }
  return audioLeaseHolder === topicId
}

/**
 * Queue for the audio lease: called by previews that started muted
 * because another card was audible. The callback fires (synchronously,
 * at most once) when THIS preview is granted the lease — the player
 * should then un-mute at half volume.
 */
export function waitForPreviewAudio(topicId: string, onGrant: () => void): void {
  if (claimPreviewAudio(topicId)) {
    onGrant()
    return
  }
  audioLeaseWaiters.set(topicId, onGrant)
}

/** Release the lease (and wake the next waiter) / drop a queue entry. */
export function releasePreviewAudio(topicId: string): void {
  if (audioLeaseHolder === topicId) {
    audioLeaseHolder = null
    const next = audioLeaseWaiters.entries().next()
    if (!next.done) {
      const [id, cb] = next.value
      audioLeaseWaiters.delete(id)
      audioLeaseHolder = id
      try {
        cb()
      } catch {
        // a broken callback must never wedge the lease
        audioLeaseHolder = null
      }
    }
  } else {
    audioLeaseWaiters.delete(topicId)
  }
}
