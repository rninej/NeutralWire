/**
 * topic-lookup.ts — ONE shared, complete topic finder (server-side).
 *
 * WHY THIS EXISTS:
 * The same "find a topic by id" search was copy-pasted into 5 different
 * places (page.tsx generateMetadata, /api/og-image, /api/summary,
 * /api/archive-topic, /api/topic/[id]) — and EVERY copy hardcoded its own
 * list of newsCache keys. The live cache actually contains personalized
 * keys like `relevant__GB`, `relevant__UK`, `relevant__INT`,
 * `mycountry__JP` … that none of those lists fully covered, so a shared
 * link whose topic lived in an unchecked key produced NO og:title and NO
 * og:image card (the exact bug reported for ?topic=a7ocn3u).
 *
 * This module fixes it structurally — and (Sep 2026, the 6.2GB/month
 * bandwidth fix) CHEAPLY:
 *   1. It checks the topic ARCHIVE first (`archive/<topicId>` — tiny).
 *   2. It checks the TOPIC INDEX (`topicIndex/<topicId> = room` — ~30
 *      bytes) written at every cache refresh, then reads that ONE room
 *      (usually an ETag 304 → zero bytes). Previously this step was a
 *      FULL SCAN of up to 48 rooms × 130-330KB = up to 6.44MB PER
 *      LOOKUP — paid by page.tsx generateMetadata, /api/og-image (every
 *      social-bot crawl of a shared link), /api/summary and /api/video.
 *   3. It ARCHIVES the topic the moment any server finds it
 *      (archive/<topicId>), so the topic becomes permanently findable —
 *      even after it rotates out of the live cache.
 *   4. The legacy full scan remains as the fallback for pre-index
 *      topics — and self-heals the index for every room it touches.
 * Every consumer imports this one function, so lookups can never drift
 * apart again.
 */

import { firebaseRead, firebaseReadShallow, firebaseWrite, firebasePatch } from '@/lib/firebase-server'
import { writeSearchIndexEntry } from '@/lib/search-index'
import { trimTopicForArchive } from '@/lib/topic-archive'
import type { TopicArticle } from '@/lib/news-aggregator'

/** Keys we check FIRST (cheapest + most likely), before the live listing. */
const PRIORITY_KEYS = ['top', 'relevant', 'world', 'politics', 'relevant__INT']

/** Memoized live key listing (shallow query). TTL keeps Firebase cheap. */
let keyListMemo: { keys: string[] | null; ts: number } | null = null
const KEY_LIST_TTL_MS = 60 * 1000

/** Recently archived ids — avoids repeated archive existence checks. */
const archivedKnown = new Set<string>()
/** Topics we know don't exist (negative cache, short TTL). */
const knownMissing = new Map<string, number>()
const MISSING_TTL_MS = 30 * 1000

// ── topicIndex: topicId → room (written at refresh; heals lookups) ──
const TOPIC_INDEX = 'topicIndex'

/**
 * Which live room holds this topic? ONE ~30-byte read.
 * Returns null for unknown/pre-index topics (caller falls back).
 */
async function roomForTopic(topicId: string): Promise<string | null> {
  try {
    const room = await firebaseRead<string>(`${TOPIC_INDEX}/${topicId}`)
    // A stale index entry can point at a room string we can trust
    // structurally (letters/digits/underscore only — never a path
    // traversal; it is only ever interpolated under newsCache/).
    if (typeof room === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(room)) return room
    return null
  } catch {
    return null
  }
}

/**
 * Record topicId→room for a whole room's topics (one small PATCH).
 * Called at cache-write time (news-cache.ts) and opportunistically when
 * a legacy scan touches a room — the index converges to complete.
 */
export async function writeTopicIndex(
  room: string,
  topics: Array<{ topicId?: string }>,
): Promise<void> {
  try {
    const patch: Record<string, string> = {}
    for (const t of topics) {
      if (t?.topicId) patch[t.topicId] = room
    }
    if (Object.keys(patch).length === 0) return
    await firebasePatch(TOPIC_INDEX, patch)
  } catch {
    // best-effort — lookups just fall back to the scan
  }
}

/**
 * List ALL newsCache keys (shallow — returns key names only, tiny).
 * ETag-cached in firebaseReadShallow: repeat listings are zero-byte 304s.
 * Falls back to a static seed list when Firebase is unreachable.
 */
async function listCacheKeys(): Promise<string[]> {
  if (keyListMemo && Date.now() - keyListMemo.ts < KEY_LIST_TTL_MS) {
    return keyListMemo.keys ?? PRIORITY_KEYS
  }
  const keys = await firebaseReadShallow('newsCache')
  keyListMemo = { keys: keys.length > 0 ? keys : null, ts: Date.now() }
  return keys.length > 0 ? keys : PRIORITY_KEYS
}

/** Order keys so priority + plain categories are searched before country
 * variants (same hit-rate, fewer reads on average). */
function orderKeys(keys: string[]): string[] {
  const priority = [...PRIORITY_KEYS]
  const plain = keys.filter((k) => !k.includes('__'))
  const country = keys.filter((k) => k.includes('__'))
  return [...priority.filter((p) => keys.includes(p) || plain.includes(p)), ...plain, ...country]
}

/**
 * Find a topic by id ANYWHERE it can exist — CHEAPLY:
 *   1. archive/<topicId>          (permanent — check first, it's tiny)
 *   2. topicIndex/<topicId>       (~30B pointer to the live room)
 *      → newsCache/<room>         (ONE room read, usually ETag 304)
 *   3. hint key                   (caller's category — 1 read)
 *   4. newsCache/<key>/topics[]   for EVERY live key (legacy fallback,
 *                                 self-heals the topicIndex)
 *
 * When found in the live cache, the topic is ARCHIVED immediately (fire
 * and forget) so it is permanent from that moment on — links shared later
 * keep working even after the cache rotates.
 *
 * @param opts.alsoArchive  default true — write found topics to archive/.
 * @param opts.hint         optional key hint (e.g. "relevant__GB" or
 *                          "world") checked before the full search.
 */
export async function findTopicAnywhere(
  topicId: string,
  opts: { alsoArchive?: boolean; hint?: string } = {},
): Promise<(TopicArticle & { archivedAt?: number }) | null> {
  if (!topicId) return null
  const alsoArchive = opts.alsoArchive !== false

  // Negative cache — repeated lookups for a just-missing id don't re-scan.
  const missingTs = knownMissing.get(topicId)
  if (missingTs && Date.now() - missingTs < MISSING_TTL_MS) return null

  // 1. Archive (permanent storage — tiny read).
  if (!archivedKnown.has(topicId)) {
    try {
      const archived = await firebaseRead<TopicArticle & { archivedAt?: number }>(
        `archive/${topicId}`,
      )
      if (archived && (archived.topicId || archived.title)) {
        archivedKnown.add(topicId)
        return archived
      }
    } catch {
      // silent — continue to live cache
    }
  }

  // 2. Topic index — the O(1) path for every topic cached since the
  //    index shipped (and backfilled for all 48 live rooms by
  //    scripts/backfill-topic-index.ts). One ~30B read + one room read.
  const indexedRoom = await roomForTopic(topicId)
  if (indexedRoom) {
    const found = await searchKey(indexedRoom, topicId)
    if (found) {
      if (alsoArchive) void archiveTopic(found)
      return found
    }
    // Stale entry (topic rotated out of that room) — fall through.
  }

  // 3. Hinted key first (caller's known category — 1 read, fastest path).
  const hint = opts.hint?.replace(/^newsCache\//, '').replace(/\.json$/, '')
  if (hint) {
    const found = await searchKey(hint, topicId)
    if (found) {
      if (alsoArchive) void archiveTopic(found)
      return found
    }
  }

  // 4. Full live search over EVERY key (legacy fallback — rare once the
  //    index is warm; every room it reads gets its topics indexed so the
  //    NEXT lookup for any of them takes the O(1) path).
  const keys = orderKeys(await listCacheKeys())
  for (const key of keys) {
    if (key === hint || key === indexedRoom) continue // already searched
    const found = await searchKey(key, topicId)
    if (found) {
      if (alsoArchive) void archiveTopic(found)
      return found
    }
  }

  knownMissing.set(topicId, Date.now())
  return null
}

/** Search one newsCache key for the topic. */
async function searchKey(
  key: string,
  topicId: string,
): Promise<TopicArticle | null> {
  try {
    const payload = await firebaseRead<{ topics?: TopicArticle[] }>(
      `newsCache/${key}`,
    )
    if (payload?.topics) {
      // Self-heal: index every topic in this room so future lookups
      // (ours and other instances') skip the scan for them.
      void writeTopicIndex(key, payload.topics)
      return payload.topics.find((t) => t.topicId === topicId) || null
    }
  } catch {
    // continue
  }
  return null
}

/** Write a found topic to the archive (permanent). Idempotent. */
async function archiveTopic(topic: TopicArticle): Promise<void> {
  try {
    const id = topic.topicId
    if (!id || archivedKnown.has(id)) return
    // Don't overwrite an existing archive entry (newer cache copies may
    // have FEWER articles than what was archived before).
    const existing = await firebaseRead<{ topicId?: string }>(`archive/${id}`)
    if (existing?.topicId) {
      archivedKnown.add(id)
      return
    }
    const trimmed = trimTopicForArchive(topic)
    const ok = await firebaseWrite(`archive/${id}`, {
      ...trimmed,
      archivedAt: Date.now(),
    })
    if (ok) {
      archivedKnown.add(id)
      // Searchable instantly — keep the compact searchIndex in step with
      // the archive (searches then cover every story EVER).
      void writeSearchIndexEntry(topic)
    }
  } catch {
    // archival is best-effort — never fail a lookup because of it
  }
}
