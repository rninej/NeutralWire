'use client'

/**
 * Background topic archiver.
 *
 * Runs on the CLIENT (user's device) — sends the current feed's topic ids
 * to /api/archive-batch in ONE request. The server reads the feed room
 * once (ETag-cached), works out which topics are missing from the
 * archive, and writes trimmed permanent copies so shared links keep
 * resolving forever. Spreads the work across visitors' devices instead
 * of burning Vercel CPU.
 *
 * ── WHY BATCHED (Sep 2026, the 6.2GB/month Firebase fix) ──
 * The OLD version POSTed /api/archive-topic once per topic (2s apart).
 * Each of those calls re-read archive/<id> (~10-30KB) and — for every
 * not-yet-archived topic — ran a full-cache topic lookup that downloaded
 * the visitor's whole feed room (130-330KB). After each 30-minute feed
 * rotation the next visitor's browser paid up to ~6MB of Firebase
 * downloads. The batch endpoint turns that into ONE room read + one
 * shallow key listing (both usually zero-byte 304s on warm instances).
 *
 * localStorage still tracks what THIS device has already sent, so the
 * common case (nothing new) doesn't even fire the request. The server
 * remains the source of truth — a new visitor's first batch call
 * deduplicates against the archive itself and only writes what's
 * actually missing.
 */

const ARCHIVED_KEY = 'neutralwire:archived-topics'
const MAX_ARCHIVED_TRACK = 800 // keep track of last 800 sent IDs
// How fresh our "server confirmed" set may be before we re-send (the
// archive grows on other devices too — re-checking keeps it converging).
const LOCAL_SET_TTL_MS = 6 * 60 * 60 * 1000

/**
 * Get the set of topicIds we've already archived (from localStorage).
 */
function getArchivedSet(): { ids: Set<string>; ts: number } {
  try {
    const raw = localStorage.getItem(ARCHIVED_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { ids?: string[]; ts?: number } | string[]
      if (Array.isArray(parsed)) return { ids: new Set(parsed), ts: 0 }
      return { ids: new Set(parsed.ids || []), ts: parsed.ts || 0 }
    }
  } catch {}
  return { ids: new Set(), ts: 0 }
}

/**
 * Mark topicIds as sent (server confirmed them) in localStorage.
 */
function markArchived(topicIds: string[]): void {
  try {
    const { ids } = getArchivedSet()
    for (const id of topicIds) ids.add(id)
    // Keep only the last MAX_ARCHIVED_TRACK entries (prevent unbounded growth)
    const arr = Array.from(ids).slice(-MAX_ARCHIVED_TRACK)
    localStorage.setItem(ARCHIVED_KEY, JSON.stringify({ ids: arr, ts: Date.now() }))
  } catch {}
}

// Track if an archiver run is already in flight (prevent duplicates)
let archiverRunning = false

/** The room key for a feed the client just loaded (mirrors cachePath()). */
function roomForFeed(
  category: string | undefined,
  countryCode: string | null | undefined,
): string | undefined {
  const cat = (category || 'relevant').toLowerCase()
  if (cat === 'relevant' || cat === 'mycountry') {
    const c = (countryCode || 'INT').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'INT'
    return `${cat}__${c}`
  }
  return cat
}

/**
 * Archive topics in the background. Called from page-client after
 * topics are loaded.
 *
 * @param topics The current list of topics in the feed
 * @param countryCode The visitor's country code (GB, US, IN, HK, …).
 * @param category The feed category the topics came from ('relevant',
 *        'world', …) — lets the server read the exact room in one go.
 */
export function archiveTopicsInBackground(
  topics: Array<{ topicId: string }>,
  countryCode?: string | null,
  category?: string,
): void {
  if (archiverRunning) return
  if (typeof window === 'undefined') return
  if (topics.length === 0) return

  archiverRunning = true

  try {
    const { ids: archivedSet, ts } = getArchivedSet()
    const staleSet = Date.now() - ts > LOCAL_SET_TTL_MS
    const toSend = topics.filter(
      (t) => t.topicId && (staleSet || !archivedSet.has(t.topicId)),
    )

    if (toSend.length === 0) {
      archiverRunning = false
      return
    }

    // One batch request, sent after a short delay (never competes with
    // the page's own loading). keepalive lets it survive tab teardown.
    setTimeout(() => {
      if (archiverRunning === false) return // safety, never happens
      fetch('/api/archive-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topicIds: toSend.map((t) => t.topicId),
          room: roomForFeed(category, countryCode),
          countryCode: countryCode || '',
        }),
        keepalive: true,
      })
        .then(async (res) => {
          if (res.ok) {
            const data = (await res.json().catch(() => null)) as
              | { ok?: boolean; archived?: number; alreadyArchived?: number; notFound?: number }
              | null
            // Mark everything the server definitively resolved (archived
            // now OR already archived) — those ids never need re-sending.
            // notFound ids stay UNmarked → retried on a future load when
            // the topic has landed in a cache room.
            if (data?.ok) {
              const resolved = (data.archived || 0) + (data.alreadyArchived || 0)
              if (resolved > 0) {
                // We can't know WHICH ids resolved individually (the
                // response is aggregate by design — tiny), so mark all
                // sent ids when notFound === 0; otherwise re-derive the
                // unmarked set next time from the server's truth (the
                // 6h TTL re-sends and self-corrects).
                if ((data.notFound || 0) === 0) {
                  markArchived(toSend.map((t) => t.topicId))
                }
              }
            }
          }
        })
        .catch(() => {
          // silent — will retry on next page load
        })
        .finally(() => {
          archiverRunning = false
        })
    }, 2500)
  } catch {
    archiverRunning = false
  }
}
