'use client'

/**
 * Background topic archiver.
 *
 * Runs on the CLIENT (user's device) — scans the current feed for topics
 * that haven't been archived yet, and sends them to /api/archive-topic
 * one at a time with a delay. This spreads the archival work across
 * users' devices instead of burning Vercel CPU.
 *
 * How it works:
 *   1. Called with the current list of topics in the feed
 *   2. For each topic, checks localStorage to see if we already archived it
 *   3. If not, sends a POST to /api/archive-topic with the topic data
 *   4. The server checks if it's already in Firebase archive (quick read)
 *   5. If not, it writes the topic (with articles) to archive/<topicId>
 *   6. Marks the topicId as archived in localStorage (so we don't retry)
 *
 * This is fire-and-forget — errors are silently ignored. The archiver
 * runs with a 2-second delay between topics to avoid hammering the server.
 */

const ARCHIVED_KEY = 'neutralwire:archived-topics'
const MAX_ARCHIVED_TRACK = 500 // keep track of last 500 archived IDs

/**
 * Get the set of topicIds we've already archived (from localStorage).
 */
function getArchivedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(ARCHIVED_KEY)
    if (raw) return new Set(JSON.parse(raw))
  } catch {}
  return new Set()
}

/**
 * Mark a topicId as archived in localStorage.
 */
function markArchived(topicId: string) {
  try {
    const set = getArchivedSet()
    set.add(topicId)
    // Keep only the last MAX_ARCHIVED_TRACK entries (prevent unbounded growth)
    if (set.size > MAX_ARCHIVED_TRACK) {
      const arr = Array.from(set).slice(-MAX_ARCHIVED_TRACK)
      localStorage.setItem(ARCHIVED_KEY, JSON.stringify(arr))
    } else {
      localStorage.setItem(ARCHIVED_KEY, JSON.stringify(Array.from(set)))
    }
  } catch {}
}

// Track if an archiver is already running (prevent duplicates)
let archiverRunning = false

/**
 * Archive topics in the background. Called from page-client after
 * topics are loaded. Only processes topics that haven't been archived yet.
 *
 * @param topics The current list of topics in the feed
 * @param countryCode The visitor's country code (GB, US, IN, HK, …). Sent
 *   with each request so the server can also search the visitor's
 *   `relevant__CC` / `mycountry__CC` caches — without it, topics from
 *   non-GB/US/IN countries were never found (the 404s in console).
 */
export function archiveTopicsInBackground(
  topics: Array<{ topicId: string }>,
  countryCode?: string | null,
): void {
  if (archiverRunning) return
  if (typeof window === 'undefined') return
  if (topics.length === 0) return

  archiverRunning = true

  const archivedSet = getArchivedSet()
  const toArchive = topics.filter((t) => t.topicId && !archivedSet.has(t.topicId))

  if (toArchive.length === 0) {
    archiverRunning = false
    return
  }

  // Process topics one at a time with a delay
  let index = 0
  const processNext = () => {
    if (index >= toArchive.length) {
      archiverRunning = false
      return
    }

    const topic = toArchive[index]
    index++

    // Send the topic to the archive endpoint (fire-and-forget).
    // The country code lets the server find the topic in the visitor's
    // own country caches (relevant__HK etc.), not just the GB/US/IN ones.
    fetch('/api/archive-topic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...topic, countryCode: countryCode || '' }),
      keepalive: true,
    })
      .then(() => {
        markArchived(topic.topicId)
      })
      .catch(() => {
        // silent — will retry on next page load
      })
      .finally(() => {
        // 2 second delay between topics (gentle on the server)
        setTimeout(processNext, 2000)
      })
  }

  // Start processing after a short initial delay (don't compete with page load)
  setTimeout(processNext, 3000)
}
