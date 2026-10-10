import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import type { Category } from '@/lib/news-sources'
import { aggregateCategory, shortenLongTitles } from '@/lib/news-aggregator'
import { aggregateMyCountryViaGdelt } from '@/lib/gdelt-aggregator'
import { refreshCategory } from '@/lib/news-cache'
import { sourcesForCountry } from '@/lib/country-detect'
import { consumeLease, jobRecentlyRan, markJobRun, CRON_JOB_INTERVALS } from '@/lib/mesh/lease-server'
import { preGenerateSummaries } from '@/lib/summary-generate'
import { firebaseWrite, firebasePatch } from '@/lib/firebase-server'
import { trimTopicForArchive, snapshotArchived, markSnapshotArchived } from '@/lib/topic-archive'
import { buildSearchIndexEntry } from '@/lib/search-index'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
// 60s lets the parallel refreshes finish AFTER the response is sent (Fluid
// Compute keeps the function alive for `after()` work up to maxDuration).
// cron-job.org only waits ~30s for the HTTP RESPONSE — and we respond in
// ≤ SYNC_WAIT_MS + cold-start overhead, so it never times out. (60 is the
// max allowed on this plan — the /api/push/* routes already use it.)
export const maxDuration = 60

/**
 * Cron-triggered endpoint that refreshes the MOST IMPORTANT news
 * categories (relevant/GB + one rotating category + mycountry/GB).
 *
 * ── TIMEOUT FIX (cron-job.org 30s limit) ──
 * History of this endpoint:
 *   v1: sequential refresh of all categories → 28-30s → cron timeouts.
 *   v2: sequential + 20s deadline race → still 26-42s responses (heavy
 *       clustering/AI/image work delays the race timer and the response
 *       flush; a fresh rotation category at :00 adds ~10s of cold AI +
 *       image-validation work) → occasional 30s timeouts.
 *   v3 (THIS): start ALL refreshes IN PARALLEL, respond after at most
 *       SYNC_WAIT_MS, and let the still-running refreshes finish
 *       post-response via `after()` (same mechanism /api/refresh uses).
 *       The response always goes out in ≤ ~10s → cron-job.org always
 *       gets a fast 200 → timeouts are impossible.
 *
 * Security: hardcoded secret (URL acts as the secret) OR a one-time
 * Firebase lease (the user-powered cron — see /src/lib/mesh/lease-server.ts)
 * OR the Vercel platform cron (vercel.json → `x-vercel-cron: 1` header —
 * also floor-throttled below so a spoofed header can't force heavy
 * back-to-back runs). Lease/cron-triggered runs additionally respect a
 * 25-minute interval floor (Firebase lastRun + in-memory).
 *
 * Trigger: Vercel cron (vercel.json, daily 05:00 UTC — the OFFLINE
 *   guarantee) AND/OR cron-job.org every 30 minutes AND/OR the oldest
 *   live visitor (experimental userCron feature, default ON).
 *   URL: https://neutralwire.org/api/cron/refresh-all?secret=965977e5d9adca4f90aa6f23b6f95371964ed8793bc735cd
 *   Lease: /api/cron/refresh-all?lease=<id>&peer=<peerId>
 *
 * The after() tail ALSO runs the DIGEST email sweep (catch-up mode) —
 * "if users aren't online the system uses the refresh rss cron job to
 * send the email using resend": refresh the RSS caches first, then send
 * the newsletters off the FRESH feeds via Resend (lib/digest.ts
 * digestSweep — the same engine /api/cron/digest uses).
 */

const CRON_SECRET = '965977e5d9adca4f90aa6f23b6f95371964ed8793bc735cd'

// Respond after at most this long, even if refreshes are still running.
// 8s leaves a huge buffer under cron-job.org's 30s limit (cold starts +
// Vercel queueing + event-loop jitter included — observed overhead was
// up to ~10s on the old sequential version).
const SYNC_WAIT_MS = 8000

export async function GET(req: NextRequest) {
  const t0 = Date.now()

  // ── Auth: admin secret (external cron) OR one-time mesh lease (a
  // visitor's browser driving the schedule — the userCron experiment) OR
  // the Vercel platform cron (vercel.json schedule).
  const secret = req.nextUrl.searchParams.get('secret') || ''
  const leaseId = req.nextUrl.searchParams.get('lease') || ''
  const peer = req.nextUrl.searchParams.get('peer') || ''
  const viaVercelCron = req.headers.get('x-vercel-cron') === '1'
  let authorized = secret === CRON_SECRET || viaVercelCron
  let viaLease = false
  if (!authorized && leaseId) {
    const lease = await consumeLease(leaseId, peer, 'refresh')
    authorized = lease.ok
    viaLease = lease.ok
    if (!lease.ok) {
      console.warn(`[cron/refresh-all] lease rejected: ${lease.reason}`)
    }
  }
  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── Interval floor for lease- AND vercel-cron-triggered runs ──
  // The external cron keeps its own schedule and is NOT throttled here;
  // visitor-driven and platform-cron triggers are capped so a buggy/
  // spoofed caller cannot multiply invocations.
  if (viaLease || viaVercelCron) {
    if (await jobRecentlyRan('refresh', CRON_JOB_INTERVALS.refresh.serverFloorMs)) {
      return NextResponse.json({
        ok: true,
        skipped: 'interval',
        message: 'Refresh ran recently — floor respected',
        ts: Date.now(),
      })
    }
    await markJobRun('refresh')
  }

  // ── Rotation: relevant/GB is ALWAYS refreshed (default landing page),
  // 'top' is ALWAYS refreshed (the flagship category — the sitemap's
  // priority room; it previously went 6 DAYS stale because only a user
  // opening the Top tab ever refreshed it, which silently EMPTIED the
  // top-only news sitemap Google was reading), one RSS category rotates
  // by UTC hour (each refreshed every ~3.5h), and mycountry/GB (GDELT)
  // runs last in the parallel set.
  const countrySourceIds = sourcesForCountry('GB')
  const hour = new Date().getUTCHours()
  const rotation = ['world', 'politics', 'business', 'technology', 'science', 'health', 'sports']
  const rotatedCategory = rotation[hour % rotation.length]

  const categoriesToRefresh = [
    { cat: 'relevant' as Category, country: 'GB', isMyCountry: false },
    { cat: 'top' as Category, country: '', isMyCountry: false },
    { cat: rotatedCategory as Category, country: '', isMyCountry: false },
    { cat: 'mycountry' as Category, country: 'GB', isMyCountry: true },
  ]

  // ── Start ALL refreshes IN PARALLEL ──
  // (was: sequential — 3 × 8-15s ≈ 25-40s wall time, which is exactly what
  // produced the 26-42s cron-job.org durations and the 30s timeouts).
  // Each refreshCategory is self-contained: it aggregates, writes to
  // Firebase, dedups concurrent refreshes, and never throws.
  const refreshes = categoriesToRefresh.map(({ cat, country, isMyCountry }) => {
    const startedAt = Date.now()
    const promise = refreshCategory(cat, country, async () => {
      if (isMyCountry) {
        const gdeltResult = await aggregateMyCountryViaGdelt(country, 60)
        await shortenLongTitles(gdeltResult.topics)
        return gdeltResult
      }
      return aggregateCategory(cat, {
        limit: 60,
        minCoverage: 1,
        countrySourceIds: isMyCountry ? countrySourceIds : [],
        countryCode: country,
      })
    })
    return {
      label: cat + (country ? `/${country}` : ''),
      startedAt,
      // The RAW refresh promise (resolves to the aggregate result with
      // .topics) — kept for the summary pre-generation below.
      raw: promise,
      // Resolve to a per-category status object (refreshCategory returns
      // null on failure → topics: 0; it logs the error internally).
      done: promise.then((result) => ({
        category: cat + (country ? `/${country}` : ''),
        topics: result?.topics?.length || 0,
        ms: Date.now() - startedAt,
      })),
    }
  })

  const allDone = Promise.allSettled(refreshes.map((r) => r.done))

  // ── THE ARCHIVE PASS (Oct 2026 — the GSC 404 fix) ──
  // Google Search Console showed ~500 /story/<id> URLs as "not indexed:
  // 404". Root cause: THIS cron (not the visitor-triggered /api/refresh)
  // refreshes relevant__GB/top/rotated/mycountry — the rooms the news
  // sitemap lists — but never ARCHIVED anything. Archiving relied on a
  // visitor happening to open the same category later (rate-limit-willing)
  // or the client-side archiver. On quiet rotations topics left the live
  // cache with NO archive copy → their /story URLs 404'd forever.
  // Now: every topic in every room this cron refreshes is archived in the
  // SAME tick that surfaces it (idempotent PUTs, snapshot markers per
  // instance, batches of 8) + indexed into searchIndex. A story that ever
  // enters a sitemap-listed room can never 404 again.
  const archivePass = allDone.then(async () => {
    for (const r of refreshes) {
      try {
        const room = r.label.replace('relevant/GB', 'relevant__GB').replace('mycountry/GB', 'mycountry__GB')
        const payload = await r.raw
        const snapshotAt = payload?.updatedAt || 0
        if (!payload?.topics?.length) continue
        if (snapshotArchived(room, snapshotAt)) continue

        const toArchive = payload.topics.filter((t) => t?.topicId)
        const batchSize = 8
        for (let i = 0; i < toArchive.length; i += batchSize) {
          const batch = toArchive.slice(i, i + batchSize)
          // Archive the trimmed permanent copy …
          await Promise.allSettled(
            batch.map((topic) =>
              firebaseWrite(`archive/${topic.topicId}`, {
                ...trimTopicForArchive(topic),
                archivedAt: Date.now(),
              }),
            ),
          )
          // … and make it searchable in the same write burst (compact
          // index entries — one PATCH per batch, not per topic).
          const indexPatch: Record<string, ReturnType<typeof buildSearchIndexEntry>> = {}
          for (const topic of batch) {
            indexPatch[topic.topicId] = buildSearchIndexEntry(topic)
          }
          await firebasePatch('searchIndex', indexPatch).catch(() => {})
        }
        markSnapshotArchived(room, snapshotAt)
        console.log(
          `[cron/refresh-all] archived ${toArchive.length} topics from ${room}`,
        )
      } catch (err) {
        console.warn(`[cron/refresh-all] archive pass for '${r.label}' failed:`, err)
      }
    }
  })

  // ── Respond FAST; slow refreshes finish post-response ──
  // Wait at most SYNC_WAIT_MS for quick refreshes. Whether or not they
  // all finish in that window, we respond — cron-job.org gets its 200 in
  // ≤ ~10s instead of 26-42s.
  // flatMap (instead of .map(...).filter(Boolean)) keeps the element type
  // concrete — filter(Boolean) is not a type guard, so the old expression
  // widened the race type until `quickResults` collapsed to `never`.
  type RefreshStatus = { category: string; topics: number; ms: number }
  const quickResults = await Promise.race([
    allDone.then((settled) =>
      settled.flatMap((s): RefreshStatus[] =>
        s.status === 'fulfilled' ? [s.value] : [],
      ),
    ),
    new Promise<RefreshStatus[] | null>((resolve) =>
      setTimeout(() => resolve(null), SYNC_WAIT_MS),
    ),
  ])

  // ── CUSTOM SUBTOPIC PASS — starts NOW, concurrent with the still-running
  // main refreshes, so a slow RSS room can never starve it (the old
  // `await allDone` + 45s gate skipped premium refreshes on ~every heavy
  // tick — part of why subtopics felt stale). Cadence itself lives in
  // customTopicsDueForRefresh: 8h per topic (owner spec: slower than the
  // 30min normal rooms, visibly alive).
  const customTopicPass = (async () => {
    try {
      const { customTopicsDueForRefresh, fillCustomTopic } = await import('@/lib/custom-topics')
      const due = await customTopicsDueForRefresh(4)
      for (const topicId of due) {
        try {
          // Adaptive per-topic budget: split what's left of the tick
          // (60s maxDuration) across the due topics so one heavy fill
          // can never eat the whole tick — and never START a fresh fill
          // when the tick is nearly spent.
          const remaining = 52_000 - (Date.now() - t0)
          if (remaining < 5000) {
            console.log(`[cron/refresh-all] custom topics: tick nearly spent, deferring ${due.length - due.indexOf(topicId)} topic(s) to the next tick`)
            break
          }
          const perTopic = Math.max(6000, Math.floor(remaining / Math.max(1, due.length)))
          const feed = await fillCustomTopic(topicId, {
            aiFilter: true,
            mode: 'background',
            budgetMs: perTopic,
          })
          console.log(
            `[cron/refresh-all] custom topic '${topicId}' refreshed: ${feed?.topics?.length || 0} topics, ${feed?.articleCount || 0} articles (${Date.now() - t0}ms into the tick)`,
          )
        } catch (err) {
          console.warn(`[cron/refresh-all] custom topic '${topicId}' refresh failed:`, err)
        }
      }
    } catch (err) {
      console.warn('[cron/refresh-all] custom-topic refresh pass failed:', err)
    }
  })()

  // Belt-and-suspenders: registering the pending work with `after()` keeps
  // the function alive until every refresh settles (even the ones that
  // outlive the response), up to maxDuration. Without this, a recycled
  // instance could drop an unfinished refresh.
  after(async () => {
    await Promise.allSettled([allDone, archivePass, customTopicPass])
    console.log(
      `[cron/refresh-all] all refreshes settled after ${Date.now() - t0}ms (response went out earlier)`,
    )

    // ── DIGEST EMAIL TAIL (the offline-user guarantee) ──
    // The user spec: "if users aren't online the system uses the refresh
    // rss cron job to send the email using resend". After the feeds are
    // fresh, one catch-up sweep delivers the newsletters of subscribers
    // whose last send is staler than their frequency interval — nobody
    // needs a browser open anywhere. Runs after the archive + custom
    // passes settle (fresh feeds → better newsletters) and only while
    // the tick still has budget.
    try {
      const elapsed = Date.now() - t0
      if (elapsed < 55_000) {
        const { digestSweep } = await import('@/lib/digest')
        const result = await digestSweep({ catchup: true, cap: 8, trigger: 'refresh-all-tail' })
        console.log(
          `[cron/refresh-all] digest tail: ${result.due} due — ${result.sent} sent, ${result.outboxed} outboxed (${Date.now() - t0}ms into the tick)`,
        )
      } else {
        console.log(
          `[cron/refresh-all] skipping digest tail — tick already at ${elapsed}ms`,
        )
      }
    } catch (err) {
      console.warn('[cron/refresh-all] digest tail failed:', err)
    }

    // ── SUMMARY PRE-GENERATION (the Google indexing fix, Sep 2026) ──
    // Story pages must ship their complete neutral summary in the RAW
    // HTML or Google refuses to index them (the "summary suddenly loads"
    // problem). Pre-generating summaries for the NEWEST stories right
    // after each refresh means Googlebot — arriving via the news sitemap
    // minutes later — reads a story page whose summary is already
    // persisted: a pure cache read, no render-time LLM wait. Bounded:
    // newest-first, ≤4 topics per tick, skipped entirely when the tick is
    // already deep into its maxDuration budget. Best-effort by design.
    try {
      const elapsed = Date.now() - t0
      if (elapsed < 55_000) {
        const settled = await Promise.allSettled(refreshes.map((r) => r.raw))
        const freshTopics = settled.flatMap((s) =>
          s.status === 'fulfilled' && s.value?.topics ? s.value.topics : [],
        )
        if (freshTopics.length > 0) {
          const generated = await preGenerateSummaries(freshTopics, { max: 4 })
          console.log(
            `[cron/refresh-all] pre-generated ${generated} neutral summar${generated === 1 ? 'y' : 'ies'} of ${freshTopics.length} fresh topics (${Date.now() - t0}ms into the tick)`,
          )
        }
      } else {
        console.log(
          `[cron/refresh-all] skipping summary pre-generation — tick already at ${elapsed}ms`,
        )
      }
    } catch (err) {
      console.warn('[cron/refresh-all] summary pre-generation failed:', err)
    }
  })

  const ms = Date.now() - t0
  const completed = quickResults !== null
  console.log(
    `[cron/refresh-all] responded in ${ms}ms — ${completed ? 'all refreshes completed' : `${refreshes.length} refreshes still running in background (after())`}`,
  )

  return NextResponse.json({
    ok: true,
    message: completed
      ? 'Refresh complete'
      : `Responded after ${ms}ms; refreshes finishing in background via after() — cron-job.org never times out`,
    results: quickResults ?? [],
    // In the not-completed branch quickResults is null BY DEFINITION
    // (completed === quickResults !== null), so the old
    // `!quickResults?.some(...)` filter always kept every refresh — the
    // `.some` was dead code (and a type error under TS 5.5's aliased-
    // condition narrowing, which types the narrowed-away branch as never).
    // Write the equivalent direct form: every refresh is still pending.
    pending: completed ? [] : refreshes.map((r) => r.label),
    ms,
    ts: Date.now(),
  })
}
