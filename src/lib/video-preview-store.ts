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
 *
 *  4. ARTICLE-OPEN SILENCING. The article sheet renders over the
 *     still-mounted feed, so any rolling preview would double up with
 *     the article's own player — the handoff pauses the tapped card,
 *     and TopicDetail pauses/resumes every live preview as it
 *     opens/closes.
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
  /** Set by the preview→article handoff: WHERE the preview had reached
   *  (seconds) when the card was tapped — the article continues from
   *  there instead of restarting the video from zero. */
  startAt?: number
}

// ── 1. Video handoff ──

/** Previews that are (or were) playing, keyed by topicId. */
const playingByTopic = new Map<string, ResolvedVideo>()

/** One-shot "open with the video rolling" requests, keyed by topicId. */
const armedByTopic = new Map<string, ResolvedVideo>()

/** Recently-consumed handoffs (topic → video + timestamp). React can
 *  RESTART a render (concurrent features discard the in-progress render
 *  when an update lands mid-render) — the first, discarded render already
 *  consumed the one-shot arm, and the committed re-render would find the
 *  map empty → the article opens with the photo + Watch square instead of
 *  the playing video (user: "the video doesn't play in the article").
 *  A short re-consume window hands the SAME video to those restarts; it
 *  expires so one-shot semantics survive (a much later open never
 *  autoplays). */
const recentlyConsumed = new Map<string, { video: ResolvedVideo; ts: number }>()

/** How long after a consume a re-render may claim the same video. */
const RECONSUME_WINDOW_MS = 5000

/** Cards the user tapped while their video was still RESOLVING (the
 *  fetch was in flight) — the handoff is "late": when the fetch lands,
 *  the already-open article is notified and starts playing it (user:
 *  "a few times when I click on a preview video it takes me to the
 *  article and the video doesn't play in the article"). */
const lateArmByTopic = new Set<string>()

/** Topics whose /api/video fetch is currently in flight (registered by
 *  HeroVideoPreview around its resolve) — lets the card's click handler
 *  know a late handoff is possible. */
const pendingFetchTopics = new Set<string>()

/** Late-handoff listeners (the open article subscribes). */
const armListeners = new Set<(topicId: string, video: ResolvedVideo) => void>()

/** Called by HeroVideoPreview when its video actually starts PLAYING. */
export function markPreviewPlaying(topicId: string, video: ResolvedVideo): void {
  playingByTopic.set(topicId, video)
}

/** Called when the preview unloads (off-screen / broken / unmounted). */
export function clearPreviewPlaying(topicId: string): void {
  playingByTopic.delete(topicId)
}

/** Imperative hooks into a mounted preview player (pause/resume/read
 *  its position) — registered by HeroVideoPreview while its player is
 *  alive, see the registry below. */
export interface PreviewControls {
  pause(): void
  resume(): void
  /** The player's current position (seconds) — arms the handoff's startAt. */
  getTime(): number
}

/** Live preview players keyed by topicId (one per card, at most). */
const previewControls = new Map<string, PreviewControls>()

/** Which topics' previews were paused because an ARTICLE opened on top
 *  of the feed — those resume when the article closes. */
const pausedByArticle = new Set<string>()

/** Register THIS card's preview player hooks. Returns an unregister
 *  function that is safe to call after a swap/unmount (token-guarded so
 *  a stale cleanup can never remove a newer player's registration). */
export function registerPreviewControls(
  topicId: string,
  controls: PreviewControls,
): () => void {
  previewControls.set(topicId, controls)
  return () => {
    if (previewControls.get(topicId) === controls) {
      previewControls.delete(topicId)
    }
    pausedByArticle.delete(topicId)
  }
}

/** Register/unregister an in-flight preview resolution (late-arm window). */
export function markPreviewFetchPending(topicId: string): void {
  pendingFetchTopics.add(topicId)
}
export function markPreviewFetchSettled(topicId: string): void {
  pendingFetchTopics.delete(topicId)
}

/**
 * Called by the CARD's click handler (synchronously, before
 * onOpenDetail) — if this card's preview is playing, arm the topic so
 * the article opens with the video rolling, carrying the preview's
 * CURRENT POSITION (the article continues instead of restarting), and
 * PAUSE the card's player so the two never play audio on top of each
 * other while the article's player spins up. If the video is still
 * RESOLVING, a LATE arm is requested instead: the moment the fetch
 * lands, the (already-open) article is notified and starts playing.
 * Cheap no-op otherwise.
 */
export function armVideoIfPlaying(topicId: string): void {
  const video = playingByTopic.get(topicId)
  if (video) {
    const controls = previewControls.get(topicId)
    const startAt = (() => {
      try {
        return controls?.getTime() ?? 0
      } catch {
        return 0
      }
    })()
    // Only attach a meaningful startAt (a second or less is a restart).
    armedByTopic.set(topicId, startAt > 1 ? { ...video, startAt } : video)
    // Silence the card immediately — the article's player takes over.
    try {
      controls?.pause()
    } catch {
      // player already gone — silent
    }
    return
  }
  // Fetch in flight → the article that is about to open gets the video
  // the moment it resolves (late handoff). Nothing to do otherwise.
  if (pendingFetchTopics.has(topicId)) {
    lateArmByTopic.add(topicId)
  }
}

/** Called by HeroVideoPreview when a fetch RESOLVES: if the user had
 *  tapped this card's article open while the fetch was in flight, arm
 *  the handoff NOW and notify the open article so it starts playing. */
export function armLateIfRequested(topicId: string, video: ResolvedVideo): void {
  if (!lateArmByTopic.has(topicId)) return
  lateArmByTopic.delete(topicId)
  armedByTopic.set(topicId, video)
  for (const cb of [...armListeners]) {
    try {
      cb(topicId, video)
    } catch {
      // a broken listener must never block the others
    }
  }
}

/** Subscribe to late handoffs (the open article). Returns unregister. */
export function onLateVideoArm(
  cb: (topicId: string, video: ResolvedVideo) => void,
): () => void {
  armListeners.add(cb)
  return () => armListeners.delete(cb)
}

/** Drop a stale late-arm request (the article closed before the video
 *  resolved — the feed preview just plays normally when it lands). */
export function cancelLateVideoArm(topicId: string): void {
  lateArmByTopic.delete(topicId)
}

/**
 * Called once by TopicDetail on mount — returns the armed video for
 * THIS topic (and clears it) so the article starts playing it
 * immediately. A different topic's arm is left alone; a stale arm
 * never fires twice.
 */
export function consumeVideoAutoplay(topicId: string): ResolvedVideo | null {
  const video = armedByTopic.get(topicId)
  if (video) {
    armedByTopic.delete(topicId)
    recentlyConsumed.set(topicId, { video, ts: Date.now() })
    return video
  }
  // Render-restart re-consume (see recentlyConsumed above): a discarded
  // render already took the one-shot arm — the committed render still
  // deserves the video it was opened with.
  const recent = recentlyConsumed.get(topicId)
  if (recent && Date.now() - recent.ts < RECONSUME_WINDOW_MS) {
    return recent.video
  }
  return null
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

// ── 4b. Article-open silencing ──
// The article sheet renders OVER the still-mounted feed — any preview
// playing underneath would keep looping (audio + bandwidth) behind the
// sheet while the article's own player runs. TopicDetail pauses EVERY
// live preview when it opens and resumes them when it closes (the ones
// that were armed for THIS article stay paused by the handoff until the
// sheet is gone, then continue right where they left off). The flag is
// also REACTIVE: a card whose video resolves only AFTER the sheet is
// already open (the click→fetch race) must never start rolling behind
// it — HeroVideoPreview gates its player on this state.

/** Whether an article sheet is currently open. */
let articleOpenState = false
const articleOpenListeners = new Set<(open: boolean) => void>()

/** Read the article-sheet state (a preview resolving while an article
 *  is open stays parked, not playing). */
export function isArticleSheetOpen(): boolean {
  return articleOpenState
}

/** Subscribe to article open/close. Returns unregister. */
export function onArticleOpenChange(cb: (open: boolean) => void): () => void {
  articleOpenListeners.add(cb)
  return () => articleOpenListeners.delete(cb)
}

function notifyArticleOpen(open: boolean): void {
  for (const cb of [...articleOpenListeners]) {
    try {
      cb(open)
    } catch {
      // a broken listener must never block the others
    }
  }
}

/** Pause every live preview player (called when an article opens). */
export function pauseAllPreviews(): void {
  articleOpenState = true
  notifyArticleOpen(true)
  for (const [id, controls] of previewControls) {
    try {
      controls.pause()
      pausedByArticle.add(id)
    } catch {
      // a broken player must never block the others
    }
  }
}

/** Resume the previews that pauseAllPreviews() paused (article closed). */
export function resumeAllPreviews(): void {
  articleOpenState = false
  notifyArticleOpen(false)
  for (const id of [...pausedByArticle]) {
    const controls = previewControls.get(id)
    pausedByArticle.delete(id)
    try {
      controls?.resume()
    } catch {
      // player already unmounted — nothing to resume
    }
  }
}

// ── 5. Single audible preview (audio lease) ──
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

// ── 6. User-gesture tracking (audible autoplay recovery) ──
// Browsers refuse AUDIBLE autoplay until the user has interacted with
// the page (a tap/keypress — scrolling does NOT count). A preview that
// started before the first gesture therefore falls back to muted — but
// that used to be PERMANENT for the player's lifetime, so the feed
// stayed silent even after the user had tapped around (user: "sometimes
// the sound is muted on home screen and only activates in article").
// Muted previews now recover: the first pointerdown/keydown anywhere
// un-mutes them (Chrome/Firefox honour sticky interaction; a still-
// refusing browser just pauses, which the user's next tap resumes).

let userGestured = false
const gestureWaiters: Array<() => void> = []

if (typeof document !== 'undefined') {
  const markGesture = () => {
    userGestured = true
    const waiters = gestureWaiters.splice(0)
    for (const w of waiters) {
      try {
        w()
      } catch {
        // a broken waiter must never block the others
      }
    }
  }
  // once:true — the FIRST interaction is all the autoplay policy needs.
  document.addEventListener('pointerdown', markGesture, {
    capture: true,
    once: true,
    passive: true,
  })
  document.addEventListener('keydown', markGesture, {
    capture: true,
    once: true,
    passive: true,
  })
}

/** Whether the user has interacted with the page at least once — from
 *  then on, browsers allow audible playback attempts. */
export function hasUserGestured(): boolean {
  return userGestured
}

/** Run cb once the user has interacted (immediately if they already
 *  have). Un-muting outside a gesture is what gets videos paused by
 *  the autoplay policy, so lease grants check this first. */
export function onUserGesture(cb: () => void): void {
  if (userGestured) {
    try {
      cb()
    } catch {
      // listener's own failure is not our problem
    }
    return
  }
  gestureWaiters.push(cb)
}
