/**
 * search-index.ts — flat, compact search index over the permanent archive.
 *
 * WHY THIS EXISTS:
 * /api/search used to only scan the LIVE newsCache categories (~last 48h
 * of stories). Anything older had rotated out of the cache — even though
 * every topic ever shown is permanently stored in `archive/<topicId>`.
 * The user wants search to cover EVERY article ever, as old as possible.
 *
 * Firebase RTDB has no server-side text search, so searching the archive
 * directly would mean downloading every full topic (KBs each). Instead we
 * maintain a compact flat index:
 *
 *   searchIndex/<topicId> = {
 *     t:  topic title
 *     s:  summary (first 240 chars)
 *     at: article titles (up to 12, 120 chars each)
 *     d:  latestSeen (ms)
 *     f:  firstSeen (ms)
 *     c:  coverage (source count)
 *     ll / lc / lr: lean counts
 *     i:  imageUrl (nullable)
 *   }
 *
 * ~300 bytes/topic → a few thousand archived stories is still under 1MB.
 *
 * HOW IT STAYS FRESH:
 *  1. AT ARCHIVE TIME — every code path that writes archive/<topicId>
 *     (/api/archive-topic and topic-lookup's archiveTopic) also writes
 *     searchIndex/<topicId>. New stories are searchable instantly.
 *  2. LAZILY, ON SEARCH — /api/search shallow-lists the archive keys
 *     (~bytes), diffs them against the index, and backfills any missing
 *     entries (capped per request so a search never times out). The
 *     pre-existing archive backlog converges over the first few searches.
 *
 * All matching is LOWERCASED on both sides — case never matters.
 */

import { firebaseRead, firebasePatch, firebaseReadShallow } from '@/lib/firebase-server'
import type { TopicArticle } from '@/lib/news-aggregator'

const DB_URL =
  'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'
// (kept only for reference/backfill internals; all reads now go through
// firebase-server's ETag-cached helpers)

/** Compact index entry. Short keys keep the node small. */
export interface SearchIndexEntry {
  t: string
  s: string
  at?: string[]
  d: number
  c?: number
  ll?: number
  lc?: number
  lr?: number
  i?: string | null
}

// ── In-process index memo ──
// The whole searchIndex node (eventually a few MB over tens of thousands
// of archived topics) is read ONCE per warm server instance every 10
// minutes — not on every search. Cold instances pay one read; warm ones
// search from memory (zero Firebase bytes, ~0ms).
let indexMemo: {
  entries: Record<string, SearchIndexEntry>
  ts: number
} | null = null
const INDEX_MEMO_TTL_MS = 10 * 60 * 1000

/** Read the search index (memoized for 10 min per server instance). */
export async function readSearchIndex(): Promise<Record<string, SearchIndexEntry>> {
  if (
    indexMemo &&
    indexMemo.entries &&
    Date.now() - indexMemo.ts < INDEX_MEMO_TTL_MS &&
    Object.keys(indexMemo.entries).length > 0
  ) {
    return indexMemo.entries
  }
  const entries = (await firebaseRead<Record<string, SearchIndexEntry>>(
    'searchIndex',
  )) as Record<string, SearchIndexEntry> | null
  indexMemo = { entries: entries || {}, ts: Date.now() }
  return indexMemo.entries
}

/** Build the compact index entry from a full topic. Kept SMALL on
 *  purpose — the whole index node is read per (cold) search; a few bytes
 *  saved per entry × tens of thousands of archived topics matters. */
export function buildSearchIndexEntry(topic: TopicArticle): SearchIndexEntry {
  const articleTitles = (topic.articles || [])
    .map((a) => (a.title || '').trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 6)
  return {
    t: (topic.title || '').slice(0, 120),
    s: (topic.summary || '').slice(0, 150),
    at: articleTitles.length > 0 ? articleTitles : undefined,
    d: topic.latestSeen || topic.firstSeen || Date.now(),
    c: topic.coverage,
    ll: topic.leanLeft,
    lc: topic.leanCenter,
    lr: topic.leanRight,
    i: typeof topic.imageUrl === 'string' ? topic.imageUrl.slice(0, 300) : null,
  }
}

/** Write one index entry (fire-and-forget safe — returns success). */
export async function writeSearchIndexEntry(topic: TopicArticle): Promise<boolean> {
  if (!topic.topicId) return false
  try {
    return await firebasePatch('searchIndex', {
      [topic.topicId]: buildSearchIndexEntry(topic),
    })
  } catch {
    return false
  }
}

// ── Lazy backfill (used by /api/search) ──

let archiveKeyMemo: { ids: string[] | null; ts: number } | null = null
const ARCHIVE_KEY_TTL_MS = 2 * 60 * 1000

/** Shallow-list ALL archive topic ids (bytes, not topics; ETag-cached —
 * repeat listings of an unchanged archive are zero-byte 304s). */
export async function listArchiveIds(): Promise<string[]> {
  if (archiveKeyMemo && Date.now() - archiveKeyMemo.ts < ARCHIVE_KEY_TTL_MS) {
    return archiveKeyMemo.ids ?? []
  }
  const ids = await firebaseReadShallow('archive')
  archiveKeyMemo = { ids: ids.length > 0 ? ids : null, ts: Date.now() }
  return ids
}

/**
 * Backfill missing index entries. Reads the archive topics that are not
 * indexed yet (batched, capped) and patches their entries in one write.
 * Returns how many were indexed this call (0 = fully up to date).
 */
export async function backfillSearchIndex(maxTopics = 80): Promise<number> {
  const [archiveIds, index] = await Promise.all([
    listArchiveIds(),
    readSearchIndex(),
  ])
  if (archiveIds.length === 0) return 0

  const have = new Set<string>(Object.keys(index))
  const missing = archiveIds.filter((id) => !have.has(id))
  if (missing.length === 0) return 0

  const batch = missing.slice(0, maxTopics)
  const patch: Record<string, SearchIndexEntry> = {}
  let done = 0

  // Read in sub-batches of 20 so we never hold too many sockets open.
  for (let i = 0; i < batch.length; i += 20) {
    const group = batch.slice(i, i + 20)
    const topics = await Promise.all(
      group.map((id) =>
        firebaseRead<TopicArticle>(`archive/${id}`).catch(() => null),
      ),
    )
    for (let j = 0; j < group.length; j++) {
      const topic = topics[j]
      if (topic && (topic.title || topic.topicId)) {
        patch[topic.topicId || group[j]] = buildSearchIndexEntry(topic)
        done++
      } else {
        // Unreadable/empty archive entry — tombstone it so we don't retry
        // it on every search (a truthy-but-empty entry counts as indexed
        // above; search naturally ignores it because `t` is empty).
        patch[group[j]] = { t: '', s: '', d: 0 }
      }
    }
  }

  if (Object.keys(patch).length > 0) {
    await firebasePatch('searchIndex', patch)
    // Fold the new entries into the memo so this instance immediately
    // searches them (no stale-miss window).
    if (indexMemo?.entries) {
      Object.assign(indexMemo.entries, patch)
    } else {
      indexMemo = { entries: { ...patch }, ts: Date.now() }
    }
  }
  return done
}
