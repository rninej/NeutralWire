/**
 * topic-archive.ts — shared archive-write policy.
 *
 * WHY THIS EXISTS (Sep 2026 bandwidth/storage fix):
 * The archive (`archive/<topicId>`) had grown to 76.75MB because every
 * archive writer stored topics with their FULL article arrays — up to 20+
 * articles each carrying a ~500-char description. Archive entries exist
 * so shared links keep resolving (og-image, /api/topic/[id]) and so the
 * compact search index can be backfilled — none of which needs more
 * than a dozen articles with trimmed descriptions.
 *
 * Capping at 12 articles × 300-char descriptions cuts archive writes
 * ~50-60% (write bandwidth + storage growth + every future read of an
 * archived topic).
 */

import type { TopicArticle } from '@/lib/news-aggregator'

const MAX_ARCHIVED_ARTICLES = 12
const MAX_ARCHIVED_DESC_CHARS = 300
const MAX_ARCHIVED_TITLE_CHARS = 300
const MAX_ARCHIVED_SUMMARY_CHARS = 1200

/** Trim a topic for permanent archive storage. Pure, never throws. */
export function trimTopicForArchive<T extends TopicArticle>(topic: T): T {
  const articles = Array.isArray(topic.articles) ? topic.articles : []
  return {
    ...topic,
    summary:
      typeof topic.summary === 'string'
        ? topic.summary.slice(0, MAX_ARCHIVED_SUMMARY_CHARS)
        : topic.summary,
    articles: articles.slice(0, MAX_ARCHIVED_ARTICLES).map((a) => {
      if (!a || typeof a !== 'object') return a
      return {
        ...a,
        title: typeof a.title === 'string' ? a.title.slice(0, MAX_ARCHIVED_TITLE_CHARS) : a.title,
        description:
          typeof a.description === 'string'
            ? a.description.slice(0, MAX_ARCHIVED_DESC_CHARS)
            : a.description,
      }
    }) as T['articles'],
  }
}

// ── Room-snapshot archive markers (in-memory, per server instance) ──
//
// Archive PUTs are idempotent and cost upload bandwidth only — but why
// write the same snapshot twice? Firebase rejects shallow+ETag queries
// (400) and the plain archive key listing is ~313KB, so checking
// archive MEMBERSHIP costs more downloads than the writes it saves.
// Instead each warm instance remembers which room SNAPSHOT (updatedAt)
// it has fully archived; the next caller for the same snapshot —
// /api/refresh OR /api/archive-batch — skips straight past writing.
//
// Cross-instance, a cold instance re-writes a snapshot at most once
// (bounded, upload-only, never counted against the download quota).

const ARCHIVED_FROM_ROOM = new Map<string, number>()

/** True when this instance already archived this exact room snapshot. */
export function snapshotArchived(room: string, updatedAt: number): boolean {
  return updatedAt > 0 && ARCHIVED_FROM_ROOM.get(room) === updatedAt
}

/** Record that this instance archived this exact room snapshot. */
export function markSnapshotArchived(room: string, updatedAt: number): void {
  if (updatedAt > 0) ARCHIVED_FROM_ROOM.set(room, updatedAt)
}
