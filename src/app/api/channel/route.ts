import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead, firebaseWrite, firebasePatch } from '@/lib/firebase-server'
import type { TopicArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 10

/**
 * GET /api/channel
 *
 * The WhatsApp-channel picker: returns ONE NeutralWire article link,
 * spread across ~10 picks per day (a new pick every 2.4 hours). Call it
 * whenever you want to post to the channel — everyone calling within the
 * same time slot gets the SAME article (stable via the `channelFeed/last`
 * node in Firebase), and articles served in the last ~4 days are not
 * repeated.
 *
 * How the pick is chosen:
 *   1. Reads all global news caches from Firebase (top, world, politics,
 *      business, technology, science, health, sports, relevant__INT) in
 *      parallel — same pattern as /api/top-news.
 *   2. Deduplicates by topicId + normalized title.
 *   3. Drops topics older than 48h, ranks by coverage × recency decay
 *      (big, fresh stories first).
 *   4. Excludes topics served recently (channelFeed/served map, 4-day
 *      window) — unless that would empty the pool.
 *   5. Rotates deterministically: index = (dayNumber × 10 + slot) mod
 *      pool length, so consecutive slots surface different stories.
 *   6. Records the pick in Firebase (channelFeed/last for slot stability
 *      across serverless instances + channelFeed/served for the no-repeat
 *      window).
 *
 * Query params:
 *   - format=text  → plain text ready to paste into WhatsApp
 *                    (title, one-liner, then the URL on the last line so
 *                    WhatsApp builds the link-preview card).
 *   - country=XX   → also consider that country's caches
 *                    (relevant__XX + mycountry__XX).
 *
 * Response (JSON):
 *   {
 *     ok: true,
 *     slot: { index, of, startsAt, endsAt },
 *     pick: {
 *       id, title, summary, coverage, left, center, right,
 *       url, image, publishedAt
 *     },
 *     shareText: "…",       // ready-to-post text
 *     generatedAt: "…"
 *   }
 */

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || 'https://neutralwire.org'

/** Picks per day — 24h / 10 = one new article every 2.4h. */
const SLOTS_PER_DAY = 10
const MINUTES_PER_SLOT = 1440 / SLOTS_PER_DAY // 144 min

/** How long a served topic is excluded from re-picking. */
const NO_REPEAT_MS = 4 * 24 * 60 * 60 * 1000 // 4 days

/** Topics older than this are never picked. */
const MAX_TOPIC_AGE_MS = 48 * 60 * 60 * 1000

/** In-memory memo (per warm instance): avoids hammering Firebase when the
 *  endpoint is called repeatedly within the same slot. */
let memo: { slotKey: string; country: string; payload: unknown; at: number } | null =
  null
const MEMO_TTL_MS = 60_000

const GLOBAL_CATEGORIES = [
  'top',
  'world',
  'politics',
  'business',
  'technology',
  'science',
  'health',
  'sports',
  'relevant__INT',
]

interface ChannelPick {
  id: string
  title: string
  summary: string
  coverage: number
  left: number
  center: number
  right: number
  url: string
  image: string
  publishedAt: number
}

/** UTC day + slot for a timestamp, e.g. day 20655, slot 4. */
function slotOf(now: Date) {
  const minutesSinceEpoch = Math.floor(now.getTime() / 60_000)
  const slotIndexTotal = Math.floor(minutesSinceEpoch / MINUTES_PER_SLOT)
  const day = Math.floor(slotIndexTotal / SLOTS_PER_DAY)
  const slot = slotIndexTotal % SLOTS_PER_DAY
  const startsAt = new Date(slotIndexTotal * MINUTES_PER_SLOT * 60_000)
  const endsAt = new Date((slotIndexTotal + 1) * MINUTES_PER_SLOT * 60_000)
  const slotKey = `${day}:${slot}`
  return { day, slot, startsAt, endsAt, slotKey }
}

function normalizeTitle(t: string) {
  return t.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
}

/** Build the ready-to-post WhatsApp text. URL on its own last line so
 *  WhatsApp renders the og:image + og:title link-preview card. */
function buildShareText(p: ChannelPick) {
  const oneLiner =
    p.summary && p.summary.trim()
      ? p.summary.trim().split(/\n|\.\s/)[0].slice(0, 160).trim()
      : ''
  const lines = [p.title.trim()]
  if (oneLiner && oneLiner.toLowerCase() !== p.title.trim().toLowerCase()) {
    lines.push('', oneLiner + (oneLiner.endsWith('.') ? '' : '.'))
  }
  lines.push(
    '',
    `Covered by ${p.coverage} ${p.coverage === 1 ? 'outlet' : 'outlets'} across the spectrum — left, center and right.`,
    '',
    p.url,
  )
  return lines.join('\n')
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const format = (sp.get('format') || 'json').toLowerCase()
  const country = (sp.get('country') || '').toUpperCase().replace(/[^A-Z]/g, '')

  const now = new Date()
  const { day, slot, startsAt, endsAt, slotKey } = slotOf(now)

  // Warm-instance memo (same slot + same country within 60s → same answer).
  if (
    memo &&
    memo.slotKey === slotKey &&
    memo.country === country &&
    Date.now() - memo.at < MEMO_TTL_MS
  ) {
    return respond(format, memo.payload as Record<string, unknown>)
  }

  try {
    // ── 1. Slot stability: the pick for THIS slot is pinned in Firebase. ──
    const last = await firebaseRead<{ slotKey?: string; topicId?: string; at?: number }>(
      'channelFeed/last',
    )
    if (last && last.slotKey === slotKey && last.topicId) {
      // Same slot — everyone gets the same article, no recompute needed.
      const pinned = await lookupTopic(last.topicId, country)
      if (pinned) {
        const payload = buildPayload(pinned, { day, slot, startsAt, endsAt })
        memo = { slotKey, country, payload, at: Date.now() }
        return respond(format, payload)
      }
      // Pinned topic vanished from every cache (rare) → fall through and
      // pick a fresh one below.
    }

    // ── 2. Gather + dedupe candidates. ──
    const cats = [...GLOBAL_CATEGORIES]
    if (country) {
      cats.push(`relevant__${country}`, `mycountry__${country}`)
    }
    const results = await Promise.all(
      cats.map(async (catKey) => {
        const payload = await firebaseRead<{ topics?: TopicArticle[] }>(
          `newsCache/${catKey}`,
        )
        return payload?.topics || []
      }),
    )

    const seenIds = new Set<string>()
    const seenTitles = new Set<string>()
    const candidates: TopicArticle[] = []
    for (const topics of results) {
      for (const t of topics) {
        if (!t || !t.topicId || !t.title) continue
        if (seenIds.has(t.topicId)) continue
        const normTitle = normalizeTitle(t.title)
        if (normTitle && seenTitles.has(normTitle)) continue
        seenIds.add(t.topicId)
        if (normTitle) seenTitles.add(normTitle)
        candidates.push(t)
      }
    }

    if (candidates.length === 0) {
      // Never break the channel — fall back to the homepage link.
      const payload = {
        ok: false,
        error: 'No news topics available right now.',
        slot: {
          index: slot,
          of: SLOTS_PER_DAY,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
        },
        shareText: `${SITE_URL}`,
        pick: null,
        generatedAt: now.toISOString(),
      }
      return respond(format, payload)
    }

    // ── 3. Fresh + interesting: rank by coverage × recency decay. ──
    const fresh = candidates.filter(
      (t) => now.getTime() - (t.latestSeen || 0) <= MAX_TOPIC_AGE_MS,
    )
    const pool0 = fresh.length > 0 ? fresh : candidates
    const hoursOld = (t: TopicArticle) =>
      Math.max(0, (now.getTime() - (t.latestSeen || 0)) / 3_600_000)
    const score = (t: TopicArticle) =>
      (t.coverage || 1) / (1 + hoursOld(t) / 8)
    const ranked = [...pool0].sort((a, b) => score(b) - score(a))

    // ── 4. No repeats: exclude topics served in the last 4 days. ──
    const served = await firebaseRead<Record<string, number>>('channelFeed/served')
    const servedIds = new Set(
      Object.entries(served || {})
        .filter(([, ts]) => typeof ts === 'number' && now.getTime() - ts < NO_REPEAT_MS)
        .map(([id]) => id),
    )
    let pool = ranked.filter((t) => !servedIds.has(t.topicId))
    if (pool.length === 0) pool = ranked // everything served recently → allow repeats

    // Keep the pick deterministic within the slot even before Firebase
    // confirms it (two concurrent cold calls): rotate by day + slot among
    // the top ~15 stories so posts stay high-quality while rotating.
    const top = pool.slice(0, 15)
    const idx = (day * SLOTS_PER_DAY + slot) % Math.max(1, top.length)
    const chosen = top[idx] || top[0] || pool[0]

    // ── 5. Pin the pick for this slot + record it as served. ──
    await firebaseWrite('channelFeed/last', {
      slotKey,
      topicId: chosen.topicId,
      at: now.getTime(),
    })
    await firebasePatch('channelFeed/served', {
      [chosen.topicId]: now.getTime(),
    }).catch(() => {})
    // Prune the served map when it grows (keep it cheap).
    if (served && Object.keys(served).length > 60) {
      const pruned: Record<string, number> = {}
      for (const [id, ts] of Object.entries(served)) {
        if (typeof ts === 'number' && now.getTime() - ts < NO_REPEAT_MS) pruned[id] = ts
      }
      pruned[chosen.topicId] = now.getTime()
      await firebaseWrite('channelFeed/served', pruned)
    }

    const payload = buildPayload(chosen, { day, slot, startsAt, endsAt })
    memo = { slotKey, country, payload, at: Date.now() }
    return respond(format, payload)
  } catch (err) {
    console.error('[api/channel] error:', err)
    const payload = {
      ok: false,
      error: 'Failed to pick a channel article.',
      shareText: SITE_URL,
      pick: null,
      generatedAt: now.toISOString(),
    }
    return respond(format, payload, 500)
  }
}

/** Find a topic by id across the caches (used to honor a pinned slot pick). */
async function lookupTopic(
  topicId: string,
  country: string,
): Promise<TopicArticle | null> {
  const cats = [...GLOBAL_CATEGORIES]
  if (country) {
    cats.push(`relevant__${country}`, `mycountry__${country}`)
  }
  // Pinned picks usually come from the global categories — check those
  // first, then the country ones.
  for (const catKey of cats) {
    const payload = await firebaseRead<{ topics?: TopicArticle[] }>(
      `newsCache/${catKey}`,
    )
    const t = payload?.topics?.find((x) => x && x.topicId === topicId)
    if (t) return t
  }
  return null
}

function buildPayload(
  t: TopicArticle,
  slotInfo: { day: number; slot: number; startsAt: Date; endsAt: Date },
) {
  const pick: ChannelPick = {
    id: t.topicId,
    title: (t.title || '').trim(),
    summary: (t.summary || '').trim().slice(0, 280),
    coverage: t.coverage || 0,
    left: t.leanLeft || 0,
    center: t.leanCenter || 0,
    right: t.leanRight || 0,
    url: `${SITE_URL}/?topic=${encodeURIComponent(t.topicId)}`,
    image: `${SITE_URL}/api/og-image?topicId=${encodeURIComponent(t.topicId)}`,
    publishedAt: t.latestSeen || 0,
  }
  return {
    ok: true,
    slot: {
      index: slotInfo.slot,
      of: SLOTS_PER_DAY,
      startsAt: slotInfo.startsAt.toISOString(),
      endsAt: slotInfo.endsAt.toISOString(),
    },
    pick,
    shareText: buildShareText(pick),
    generatedAt: new Date().toISOString(),
  }
}

function respond(
  format: string,
  payload: Record<string, unknown>,
  status = 200,
) {
  if (format === 'text') {
    const text = String(payload.shareText ?? '')
    return new NextResponse(text, {
      status,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
  return NextResponse.json(payload, { status })
}
