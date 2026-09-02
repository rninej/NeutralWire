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
 * This module fixes it structurally:
 *   1. It lists the newsCache keys LIVE (`?shallow=true` — key names only,
 *      ~200 bytes) so new country/category keys are always covered.
 *      No hardcoded key list to go stale again.
 *   2. It ARCHIVES the topic the moment any server finds it
 *      (archive/<topicId>), so the topic becomes permanently findable —
 *      even after it rotates out of the live cache. "Prevent it from ever
 *      happening again" = once seen, never lost.
 *   3. Every consumer imports this one function, so lookups can never
 *      drift apart again.
 */

import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import type { TopicArticle } from '@/lib/news-aggregator'

const DB_URL =
  'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'

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

/**
 * List ALL newsCache keys (shallow — returns key names only, tiny).
 * Falls back to a static seed list when Firebase is unreachable.
 */
async function listCacheKeys(): Promise<string[]> {
  if (keyListMemo && Date.now() - keyListMemo.ts < KEY_LIST_TTL_MS) {
    return keyListMemo.keys ?? PRIORITY_KEYS
  }
  let keys: string[] | null = null
  try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), 6000)
    const res = await fetch(`${DB_URL}/newsCache.json?shallow=true`, {
      cache: 'no-store',
      signal: controller.signal,
    })
    clearTimeout(t)
    if (res.ok) {
      const text = await res.text()
      if (text && text !== 'null') {
        keys = Object.keys(JSON.parse(text) as Record<string, unknown>)
      }
    }
  } catch {
    // fall through to static seed
  }
  keyListMemo = { keys, ts: Date.now() }
  return keys ?? PRIORITY_KEYS
}

/** Order keys so priority + plain categories are searched before country
 *  variants (same hit-rate, fewer reads on average). */
function orderKeys(keys: string[]): string[] {
  const priority = [...PRIORITY_KEYS]
  const plain = keys.filter((k) => !k.includes('__'))
  const country = keys.filter((k) => k.includes('__'))
  return [...priority.filter((p) => keys.includes(p) || plain.includes(p)), ...plain, ...country]
}

/**
 * Find a topic by id ANYWHERE it can exist:
 *   1. archive/<topicId>          (permanent — check first, it's tiny)
 *   2. newsCache/<key>/topics[]   for EVERY live key (dynamically listed)
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

  // 2. Hinted key first (caller's known category — 1 read, fastest path).
  const hint = opts.hint?.replace(/^newsCache\//, '').replace(/\.json$/, '')
  if (hint) {
    const found = await searchKey(hint, topicId)
    if (found) {
      if (alsoArchive) void archiveTopic(found)
      return found
    }
  }

  // 3. Full live search over EVERY key.
  const keys = orderKeys(await listCacheKeys())
  for (const key of keys) {
    if (key === hint) continue // already searched
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
    const ok = await firebaseWrite(`archive/${id}`, {
      ...topic,
      articles: topic.articles ?? [],
      archivedAt: Date.now(),
    })
    if (ok) archivedKnown.add(id)
  } catch {
    // archival is best-effort — never fail a lookup because of it
  }
}
