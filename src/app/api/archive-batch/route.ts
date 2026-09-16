import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead, firebaseWrite, firebasePatch } from '@/lib/firebase-server'
import { writeTopicIndex } from '@/lib/topic-lookup'
import { buildSearchIndexEntry } from '@/lib/search-index'
import { trimTopicForArchive, snapshotArchived, markSnapshotArchived } from '@/lib/topic-archive'
import type { TopicArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 30

/**
 * POST /api/archive-batch
 *
 * ONE-call replacement for the per-topic /api/archive-topic loop (the
 * top driver of the 6.2GB/month Firebase download bill):
 *
 * OLD client flow (background-archiver.ts, one POST per feed topic,
 * 2s apart):
 *   24 topics × [ archive/<id> read (~10-30KB) +, for every
 *   not-yet-archived topic, findTopicAnywhere(hint) → FULL 130-330KB
 *   room read ] — up to ~6MB of Firebase downloads after every feed
 *   rotation, paid by whichever visitor's browser ran the archiver.
 *
 * NEW flow (this endpoint):
 *   1. Read the room the feed CAME FROM (the client knows it — passed
 *      as `room`) ONCE — ETag-cached, so usually a zero-byte 304.
 *   2. Write trimmed archive entries for the requested topics found in
 *      that room, plus ONE searchIndex PATCH for all of them.
 *
 * DEDUP (why no archive-membership read?): Firebase rejects shallow
 * queries combined with ETag probes (400), and the plain archive key
 * listing is ~313KB — checking membership would cost MORE than the
 * archiving it protects. Instead:
 *   - Archive PUTs are idempotent (same topicId → same trimmed data),
 *     cost upload bandwidth only (NOT the download quota the 6.2GB bill
 *     is about), and
 *   - an in-memory room→updatedAt marker makes each warm instance write
 *     each room snapshot ONCE — a second visitor on the same instance
 *     costs one zero-byte 304 room read and nothing else.
 *
 * Body: { topicIds: string[], room?: string, countryCode?: string }
 * Response: { ok, archived, alreadyArchived, notFound }
 */

const MAX_BATCH = 120 // sanity cap — one feed page is ≤ 60 topics

function sanitizeRoom(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const r = raw.replace(/^newsCache\//, '').replace(/\.json$/, '')
  return /^[A-Za-z0-9_]{1,40}$/.test(r) ? r : null
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      topicIds?: unknown
      room?: unknown
      countryCode?: unknown
    }

    const topicIds = Array.isArray(body.topicIds)
      ? body.topicIds
          .filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id))
          .slice(0, MAX_BATCH)
      : []
    if (topicIds.length === 0) {
      return NextResponse.json({ ok: true, archived: 0, alreadyArchived: 0, notFound: 0 })
    }

    // ── 1. Read the room the client's feed came from (once) ──
    // Fall back to the visitor's relevant__CC room, then a few likely
    // rooms, so a stale client without the room param still works.
    const cc =
      typeof body.countryCode === 'string'
        ? body.countryCode.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3)
        : ''
    const roomCandidates = [
      sanitizeRoom(body.room),
      cc ? `relevant__${cc}` : null,
      cc ? `mycountry__${cc}` : null,
      'top',
      'relevant__INT',
    ].filter((r): r is string => r !== null)

    const topicsById = new Map<string, TopicArticle>()
    let primarySnapshotUpdatedAt = 0
    let primaryRoom: string | null = null
    for (const room of roomCandidates) {
      // Stop early once every requested id has been located.
      if (topicIds.every((id) => topicsById.has(id))) break
      const payload = await firebaseRead<{
        topics?: TopicArticle[]
        updatedAt?: number
      }>(`newsCache/${room}`)
      if (!payload?.topics || !Array.isArray(payload.topics)) continue
      // Keep the index warm for this room (self-heal, one small PATCH).
      void writeTopicIndex(room, payload.topics)
      if (primaryRoom === null) {
        primaryRoom = room
        primarySnapshotUpdatedAt =
          typeof payload.updatedAt === 'number' ? payload.updatedAt : 0
      }
      for (const t of payload.topics) {
        if (t?.topicId && !topicsById.has(t.topicId)) topicsById.set(t.topicId, t)
      }
    }

    // ── 2. Split: found-in-room vs not-found; snapshot-dedup marker ──
    const toArchive: TopicArticle[] = []
    let alreadyArchived = 0
    let notFound = 0

    // If THIS instance already archived this exact room snapshot, every
    // requested topic in it is archived — reply without a single write.
    const snapshotAlreadyArchived =
      primaryRoom !== null && snapshotArchived(primaryRoom, primarySnapshotUpdatedAt)

    for (const id of topicIds) {
      const t = topicsById.get(id)
      if (!t) {
        notFound++
        continue
      }
      if (snapshotAlreadyArchived) {
        alreadyArchived++
        continue
      }
      toArchive.push(t)
    }

    // ── 3. Write trimmed archive entries + one searchIndex patch ──
    let archived = 0
    if (toArchive.length > 0) {
      const searchPatch: Record<string, ReturnType<typeof buildSearchIndexEntry>> = {}
      const BATCH = 8 // parallel write groups (same as /api/refresh)
      for (let i = 0; i < toArchive.length; i += BATCH) {
        const group = toArchive.slice(i, i + BATCH)
        const results = await Promise.allSettled(
          group.map(async (topic) => {
            const trimmed = trimTopicForArchive(topic)
            const ok = await firebaseWrite(`archive/${topic.topicId}`, {
              ...trimmed,
              archivedAt: Date.now(),
            })
            if (ok) {
              searchPatch[topic.topicId] = buildSearchIndexEntry(topic)
              return true
            }
            return false
          }),
        )
        archived += results.filter((r) => r.status === 'fulfilled' && r.value).length
      }
      if (Object.keys(searchPatch).length > 0) {
        await firebasePatch('searchIndex', searchPatch)
      }
    }

    if (primaryRoom !== null) {
      markSnapshotArchived(primaryRoom, primarySnapshotUpdatedAt)
    }

    return NextResponse.json({
      ok: true,
      archived,
      alreadyArchived,
      notFound,
    })
  } catch (err) {
    console.warn('[api/archive-batch] error:', err)
    return NextResponse.json({ error: 'Archive batch failed' }, { status: 500 })
  }
}
