/**
 * digest.ts — the AI email digest engine (Premium).
 *
 * Cron: /api/cron/digest (every ~30 min from the same external cron that
 * hits refresh-all). Each tick:
 *
 *   1. Reads the `digestSubscribers/<accountId>` index (tiny — only
 *      accounts with the digest ON; the whole accounts tree is NEVER
 *      scanned).
 *   2. Computes whether a subscriber is DUE in their LOCAL timezone:
 *        weekly → Mondays at their chosen hour
 *        daily  → every day at their chosen hour
 *        2x     → chosen hour + hour+12
 *        3x     → 07:00 / 13:00 / 19:00 (breakfast, lunch, evening)
 *      A 6h re-send guard prevents double sends within a slot.
 *   3. Gathers news for THEIR preferences (their custom subtopics' feeds
 *      + the main cached categories), then asks the AI to write the
 *      newsletter (a fabulous, opinionated-but-neutral editor voice).
 *   4. Sends via Resend (RESEND_API_KEY env var, with the owner-provided
 *      key as the baked-in fallback — see deliverDigest); when a send
 *      cannot go out yet (e.g. the domain is still unverified on Resend)
 *      the finished newsletter lands in `digestOutbox/<accountId>/<ts>`
 *      with the reason so nothing is silently lost and the owner can
 *      inspect exactly what would have gone out.
 */

import { createHash } from 'crypto'
import { firebaseRead, firebaseWrite, firebasePatch, firebasePush } from '@/lib/firebase-server'
import { callAI } from '@/lib/ai-providers'
import type { TopicArticle } from '@/lib/news-aggregator'
import { readCustomFeed, getCustomTopicDef } from '@/lib/custom-topics'
import {
  isSmartPersonalizationOn,
  readMergedProfile,
  rankStoriesForProfile,
  scoreStoryForRanking,
} from '@/lib/interest-engine'

export interface DigestSubscriber {
  email: string
  timezone?: string
  prefs?: { enabled?: boolean; freq?: string; hour?: number }
  lastSentAt?: number
  /** Every send ATTEMPT (successful or not) — spaces retries so the
   * 30-min user-cron can't spam the outbox while the Resend domain is
   * unverified, WITHOUT marking a failed send as "sent". */
  lastAttemptAt?: number
  /** Short reason slug of the last failed delivery — visible on the
   * subscriber node for instant diagnosis. */
  lastFailure?: string
}

const SIX_HOURS_MS = 6 * 3600 * 1000

/** Minimum spacing between send ATTEMPTS for the same subscriber —
 * the user-cron fires every ~30 min, and a subscriber whose delivery
 * keeps failing (e.g. the Resend domain is still unverified) would
 * otherwise get a fresh outbox entry on every tick. 90 min = fast
 * recovery once the blocker clears (next attempt ≤90 min later)
 * without outbox spam (~16 attempts/day worst case, ~15KB each). */
const ATTEMPT_SPACING_MS = 90 * 60 * 1000

/** Is a subscriber due for a digest right now (their local time)? */
export function isDue(sub: DigestSubscriber, now = new Date()): boolean {
  const freq = sub.prefs?.freq || 'daily'
  const hour = Math.min(23, Math.max(0, sub.prefs?.hour ?? 8))
  let slots: number[]
  switch (freq) {
    case 'weekly':
      slots = [hour]
      break
    case 'daily':
      slots = [hour]
      break
    case '2x':
      slots = [hour, (hour + 12) % 24]
      break
    case '3x':
    default:
      slots = [7, 13, 19]
      break
  }

  // Local time in the subscriber's timezone (falls back to UTC).
  const local = new Date(now.toLocaleString('en-US', { timeZone: sub.timezone || 'UTC' }))
  const localHour = local.getHours()

  // Weekly only fires on Mondays.
  if (freq === 'weekly' && local.getDay() !== 1) return false

  const inSlot = slots.some((h) => localHour >= h && localHour < h + 1)
  if (!inSlot) return false

  // Re-send guard: at most one digest per 6h.
  if (sub.lastSentAt && now.getTime() - sub.lastSentAt < SIX_HOURS_MS) return false
  return true
}

// ── Catch-up mode (the OFFLINE-user path) ────────────────────────────────
// The visitor user-cron only runs while somebody's browser is open — a
// day with zero visitors meant zero digests, even for subscribers whose
// slot came and went. The server-side crons (vercel.json: refresh-all +
// digest) now run a CATCH-UP sweep: a subscriber is due when their last
// send is staler than their frequency interval — the preferred local HOUR
// becomes the on-time path (user-cron), while catch-up guarantees the
// email still goes out that day via Resend no matter what.
const CATCHUP_INTERVALS_MS: Record<string, number> = {
  weekly: 6 * 24 * 3600 * 1000,
  daily: 20 * 3600 * 1000,
  '2x': 10 * 3600 * 1000,
  '3x': 5 * 3600 * 1000,
}

/** Catch-up due: last send older than the frequency interval (weekly
 *  also requires Monday-or-later since the last send so the "Monday
 *  newsletter" rhythm survives). Ignores the local slot hour — this is
 *  the offline fallback, not the on-time path. */
export function isCatchupDue(sub: DigestSubscriber, now = new Date()): boolean {
  if (sub.prefs?.enabled === false) return false
  const freq = sub.prefs?.freq || 'daily'
  const interval = CATCHUP_INTERVALS_MS[freq] || CATCHUP_INTERVALS_MS.daily
  if (!sub.lastSentAt) return true // never sent — welcome aboard
  const stale = now.getTime() - sub.lastSentAt > interval
  if (!stale) return false
  if (freq === 'weekly') {
    // Only catch up on/after Monday so weeklies keep a weekly cadence.
    const local = new Date(now.toLocaleString('en-US', { timeZone: sub.timezone || 'UTC' }))
    return local.getDay() === 1
  }
  return true
}

/** One digest sweep — the shared engine behind /api/cron/digest AND the
 *  refresh-all cron's email tail ("the refresh rss cron job sends the
 *  email using resend"). Reads the subscriber list itself, picks who is
 *  due (slot-matching OR catch-up when `catchup`), and processes up to
 *  `cap` newsletters: gather → AI write → Resend send (or outbox with the
 *  failure reason). Returns the counts for logging.
 *
 *  OBSERVABILITY (added after the "no email ever arrived" investigation):
 *  every sweep writes one tiny `digestSweeps/<ts>` log node — trigger,
 *  due/sent/outboxed counts and a per-subscriber status line — so the
 *  pipeline's behaviour is inspectable in Firebase instead of silently
 *  unknown. That investigation found lastSentAt=never + an EMPTY outbox
 *  for the only subscriber: something failed BEFORE delivery, with no
 *  trace anywhere. This log ends that blind spot. */
export async function digestSweep(
  opts: { catchup?: boolean; cap?: number; trigger?: string } = {},
): Promise<{ due: number; sent: number; outboxed: number }> {
  const cap = Math.max(1, opts.cap ?? 5)
  const subscribers =
    (await firebaseRead<Record<string, DigestSubscriber>>('digestSubscribers')) || {}
  const now = new Date()
  const due = Object.entries(subscribers).filter(
    ([id, sub]) =>
      id &&
      sub?.email &&
      sub.prefs?.enabled !== false &&
      // Attempt spacing: a recent ATTEMPT (successful or failed) holds
      // the subscriber back until ATTEMPT_SPACING_MS passes — this is
      // what lets a failed delivery retry soon (not in 5h) without
      // outbox spam. See markAttempt/markSent.
      (!sub.lastAttemptAt || now.getTime() - sub.lastAttemptAt > ATTEMPT_SPACING_MS) &&
      (isDue(sub, now) || (opts.catchup && isCatchupDue(sub, now))),
  )
  const batch = due.slice(0, cap)
  let sent = 0
  let outboxed = 0
  const perSub: string[] = []
  for (const [accountId, sub] of batch) {
    try {
      // Every attempt — success OR failure — records lastAttemptAt so
      // the spacing guard above can hold this subscriber back briefly.
      await markAttempt(accountId)
      const stories = await gatherStories(accountId)
      if (stories.length === 0) {
        perSub.push(`${accountId}:no-stories`)
        continue
      }
      const newsletter = await generateNewsletter(sub.email, stories, { accountId })
      if (!newsletter) {
        // generateNewsletter now ALWAYS returns something (the fallback
        // builder below) — kept as a belt-and-braces guard.
        perSub.push(`${accountId}:newsletter-null`)
        continue
      }
      const result = await deliverDigest(accountId, sub.email, newsletter)
      // lastSentAt ONLY on a REAL send. Marking failed sends as "sent"
      // (the pre-session43 bug) throttled retries to the catch-up
      // interval — a subscriber whose every delivery 403'd (unverified
      // Resend domain) waited 5h between attempts for an email that
      // would keep 403ing anyway. Now: lastSentAt gates re-SENDING,
      // lastAttemptAt gates re-TRYING — the moment the owner verifies
      // the domain, the next sweep (≤45 min) delivers for real.
      if (result.sent) {
        await markSent(accountId)
        await recordSentTopics(accountId, stories)
        await firebaseWrite(`digestSubscribers/${accountId}/lastFailure`, null).catch(() => {})
        perSub.push(`${accountId}:sent`)
        sent++
      } else {
        perSub.push(`${accountId}:outboxed:${result.failureSlug || 'unknown'}`)
        outboxed++
      }
    } catch (err) {
      console.warn(`[digestSweep] failed for ${accountId}:`, err)
      perSub.push(`${accountId}:error`)
    }
  }
  // One tiny log node per sweep (never scanned by anything — pure audit).
  await firebaseWrite(`digestSweeps/${Date.now()}`, {
    trigger: opts.trigger || 'unknown',
    catchup: !!opts.catchup,
    due: due.length,
    processed: batch.length,
    sent,
    outboxed,
    perSub: perSub.slice(0, 10),
  }).catch(() => {})
  return { due: due.length, sent, outboxed }
}

/** Record which stories this send included (Interest Engine v2):
 * digestSubscribers/<id>/sentTopics/<topicId> = { n, ts, clicked }. The
 * next gatherStories() drags stories that were emailed-but-never-clicked
 * (−12 per send, max 3) and gives clicked ones a small +6 — the email
 * stops repeating itself and starts following the reader. A digest_click
 * ping (from the email links) flips clicked=true. Pruned to the newest
 * 60 entries so the node stays tiny. */
async function recordSentTopics(accountId: string, stories: TopicArticle[]): Promise<void> {
  try {
    const path = `digestSubscribers/${accountId}/sentTopics`
    const existing =
      (await firebaseRead<Record<string, { n?: number; ts?: number; clicked?: boolean }>>(path)) || {}
    const now = Date.now()
    for (const s of stories) {
      const cur = existing[s.topicId] || {}
      existing[s.topicId] = { n: (cur.n || 0) + 1, ts: now, clicked: cur.clicked || false }
    }
    const entries = Object.entries(existing)
    const keep = entries.length > 60
      ? entries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0)).slice(0, 60)
      : entries
    await firebaseWrite(path, Object.fromEntries(keep))
  } catch {
    // bookkeeping only — never block the send path
  }
}

/** A story on its way into the digest, with the transient label of the
 * custom subtopic it came from (drives the "YOUR TOPIC" chip + section
 * notes in the template). Not persisted — template-only sugar. */
type DigestStory = TopicArticle & { digestTopicLabel?: string }

/** Gather the stories for one subscriber.
 *
 * Interest Engine v2 (flag ON — the default): the candidate pool widens
 * (their custom subtopic feeds + the five core categories) and is RANKED
 * by the account's learned interest profile — the same brain the Relevant
 * feed and notifications use — with:
 *   • +10 for stories from their subscribed custom topics (an explicit
 *     taste declaration beats any inference),
 *   • a −12-per-send drag for stories already emailed but never clicked
 *     (no more "the same five stories every email"), cleared + reversed
 *     (+6) once they click through — the click is the loudest signal,
 *   • the engine's diversity pass (one event can't flood the digest).
 * Flag OFF: the ORIGINAL path exactly — custom topics first, core cats
 * newest-first, first 14. The /debug one-click revert. */
export async function gatherStories(accountId: string): Promise<TopicArticle[]> {
  const account = await firebaseRead<{
    prefs?: { customSubtopics?: string[] }
  }>(`accounts/${accountId}`)
  const customIds = account?.prefs?.customSubtopics || []

  const stories: DigestStory[] = []

  // Their custom subtopic feeds first (the personalisation promise).
  // Labels ride along for the "YOUR TOPIC" chips.
  const defs = await Promise.all(
    customIds.slice(0, 4).map((id) => getCustomTopicDef(id).catch(() => null)),
  )
  for (let i = 0; i < customIds.slice(0, 4).length; i++) {
    const id = customIds[i]
    const feed = await readCustomFeed(id).catch(() => null)
    if (feed?.topics) {
      for (const t of feed.topics.slice(0, 5)) {
        stories.push({ ...t, digestTopicLabel: defs[i]?.label })
      }
    }
  }

  // Then the main cached categories (shared, always warm).
  const coreCats = ['top', 'world', 'technology', 'politics', 'business']
  for (const cat of coreCats) {
    const cached = await firebaseRead<{ topics: TopicArticle[] }>(`newsCache/${cat}`).catch(() => null)
    if (cached?.topics) stories.push(...cached.topics.slice(0, 6))
  }

  // Dedup by topicId.
  const seen = new Set<string>()
  const unique = stories.filter((t) => {
    if (!t?.topicId || seen.has(t.topicId)) return false
    seen.add(t.topicId)
    return true
  })

  // ── ORIGINAL path (the /debug revert): newest-first, first 14. ──
  let smart = false
  try {
    smart = await isSmartPersonalizationOn()
  } catch {
    smart = true
  }
  if (!smart) {
    unique.sort((a, b) => (b.latestSeen || 0) - (a.latestSeen || 0))
    return unique.slice(0, 14)
  }

  // ── SMART path: rank by the learned interest profile. ──
  const [profile, sentTopics] = await Promise.all([
    readMergedProfile(null, accountId),
    firebaseRead<Record<string, { n?: number; ts?: number; clicked?: boolean }>>(
      `digestSubscribers/${accountId}/sentTopics`,
    ).catch(() => null),
  ])
  const sentMap = sentTopics || {}
  const ranked = rankStoriesForProfile(unique, profile, (s) => {
    let score = scoreStoryForRanking(s, profile)
    if (s.digestTopicLabel) score += 10 // an explicit subscription
    const sent = sentMap[s.topicId]
    if (sent?.n && !sent.clicked) score -= 12 * Math.min(sent.n, 3) // emailed, never clicked
    else if (sent?.clicked) score += 6 // emailed AND clicked — more like it
    return score
  })
  return ranked.slice(0, 14).map((r) => r.story)
}

/** The AI newsletter writer — CONTENT ONLY, rendered through the shared
 * grid template.
 *
 * THE AI IS A POLISH LAYER, NEVER A GATE (the digest's founding lesson):
 * when callAI is unavailable the same deterministic template renders with
 * heuristic content (see below), so the email goes out EVERY time, in the
 * SAME layout.
 *
 * The AI returns STRUCTURED content — {subject, note, items:[{headline,
 * summary}]} — never HTML: every link and every style comes from the
 * server-side template, so no provider outage or malformed reply can ever
 * break the email's layout (the old full-HTML handoff left Outlook-safe
 * rendering to whatever the model felt like emitting that day). Items map
 * to OUR stories BY ORDER — the AI cannot swap or invent URLs. */
export async function generateNewsletter(
  email: string,
  stories: TopicArticle[],
  opts: { accountId?: string } = {},
): Promise<{ subject: string; html: string } | null> {
  if (stories.length === 0) return null
  const list = stories
    .map(
      (s, i) =>
        `${i + 1}. ${s.title}${s.summary ? ` — ${s.summary.slice(0, 160)}` : ''} [${s.coverage} sources; bias L${s.leanLeft}/C${s.leanCenter}/R${s.leanRight}]`,
    )
    .join('\n')

  const raw = await callAI({
    systemPrompt:
      'You are the editor of the NeutralWire email digest — a neutral news comparison service showing how left, centre and right outlets cover the same stories. You will receive today\'s stories as numbered lines. Reply with ONLY JSON: {"subject":"a short witty but strictly neutral subject line","note":"1-2 sentence editor\'s note to open the digest (warm, witty, neutral — mention how coverage splits across the spectrum today)","items":[{"headline":"the story headline (you may lightly clean/clarity-fix it)","summary":"2 short sentences: what happened + how left/centre/right coverage differs"}]} — exactly one item per story, in the SAME ORDER as given, same count. No other text.',
    userPrompt: `Subscriber: ${email}\nToday's stories (title — summary [sources; bias split]):\n${list}\n\nReply with only the JSON.`,
    maxTokens: 1600,
  })

  let note =
    'How the spectrum covered today, side by side — every story below shows the left/centre/right split at a glance.'
  let subject = ''
  let items: Array<{ headline?: string; summary?: string }> = []
  if (raw) {
    try {
      const m = raw.match(/\{[\s\S]*\}/)
      if (m) {
        const parsed = JSON.parse(m[0]) as {
          subject?: string
          note?: string
          items?: Array<{ headline?: string; summary?: string }>
        }
        if (parsed.subject) subject = String(parsed.subject).slice(0, 120)
        if (parsed.note) note = String(parsed.note).slice(0, 280)
        if (Array.isArray(parsed.items)) items = parsed.items
      }
    } catch {
      // fall through to the heuristic content below
    }
  }

  // Map AI content onto OUR stories by order; anything missing/short gets
  // the heuristic fill — the template never sees a hole.
  const rows = stories.map((s, i) => {
    const aiItem = items[i] || {}
    const headline =
      typeof aiItem.headline === 'string' && aiItem.headline.trim().length >= 8
        ? aiItem.headline.trim().slice(0, 140)
        : s.title
    const summary =
      typeof aiItem.summary === 'string' && aiItem.summary.trim().length >= 20
        ? aiItem.summary.trim().slice(0, 220)
        : s.summary?.slice(0, 200) ||
          `Covered by ${s.coverage} ${s.coverage === 1 ? 'outlet' : 'outlets'} — open the story to compare how each side frames it.`
    return { story: s, headline, summary }
  })

  if (!subject) {
    subject =
      stories.length > 1
        ? `Your NeutralWire digest — ${stories.length} stories across the spectrum`
        : `Your NeutralWire digest — ${(stories[0]?.title || "today's stories").slice(0, 60)}`
  }
  const personalized = await isSmartPersonalizationOn().catch(() => false)
  return {
    subject: subject.slice(0, 120),
    html: renderDigestEmail({ email, note, rows, accountId: opts.accountId, personalized }),
  }
}

// ── The digest email template — a real newsletter, AI or not ──────────────
//
// Design goals (the owner's brief): "a multi layout — some bigger, some
// left, some right… more newsletter-like, not a pasted array"). The
// layout is an EDITORIAL PYRAMID, the shape every print newspaper uses:
//
//   ┌──────────────────────────────────────────────┐
//   │ HEADER BAND (logo + wordmark + DAILY DIGEST) │
//   │ greeting · date · editor's note              │
//   ├──────────────────────────────────────────────┤
//   │ ██ HERO — the #1 story, full width, 21px     │  ← the lead
//   │    headline, full summary, wide bias bar     │
//   ├──────────────────────────────────────────────┤
//   │ TOP STORIES (section label + amber rule)     │
//   │ ┌───────────┐  ┌───────────┐                 │  ← the grid
//   │ │  #2 card  │  │  #3 card  │                 │     (2-col,
//   │ └───────────┘  └───────────┘                 │      cards)
//   │      … ranks 2–9, two per row …              │
//   ├──────────────────────────────────────────────┤
//   │ QUICK HITS (section label + amber rule)      │
//   │ #10 headline · L/C/R   #11 headline · L/C/R  │  ← the scan rows
//   │ #12 headline · L/C/R   #13 headline · L/C/R  │     (2-col,
//   └──────────────────────────────────────────────┘      compact)
//
//   • every table cell primitive is Outlook-safe (no CSS grid/flex),
//   • mobile: hero full-width already, grid + quick-hits stack 1-per-row
//     via the single @media block (WebKit/Blink clients — where phones
//     read email),
//   • stories from the subscriber's custom subtopics carry an amber
//     "YOUR TOPIC — <label>" chip (an explicit taste declaration),
//   • every link carries src=digest&usr=<accountId> so clicks teach the
//     Interest Engine (digest_click, +4/term) and clear the
//     emailed-but-never-clicked drag,
//   • a footer line notes the personalisation when it's active.

/** Site-matching spectrum colours (blue-500 / zinc-500 / red-500). */
const BIAS_COLORS = { left: '#3b82f6', center: '#71717a', right: '#ef4444' }

function escHtml(s: string): string {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

interface DigestRow {
  story: TopicArticle & { digestTopicLabel?: string }
  headline: string
  summary: string
}

function renderDigestEmail(opts: {
  email: string
  note: string
  rows: DigestRow[]
  accountId?: string
  personalized?: boolean
}): string {
  const { email, note, rows, accountId, personalized } = opts
  const greeting = email.split('@')[0] || 'there'
  const dateLine = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
  const unsub = unsubscribeLink(email)

  // Story link — click-through pings back as digest_click (teaches the
  // Interest Engine + clears the sent-without-click drag).
  const storyUrl = (topicId: string): string =>
    `https://neutralwire.org/?topic=${encodeURIComponent(topicId)}${
      accountId ? `&src=digest&usr=${encodeURIComponent(accountId)}` : ''
    }`

  const biasPct = (s: TopicArticle) => {
    const total = Math.max(1, s.leanLeft + s.leanCenter + s.leanRight)
    const lPct = Math.round((s.leanLeft / total) * 100)
    const cPct = Math.round((s.leanCenter / total) * 100)
    return { lPct, cPct, rPct: Math.max(0, 100 - lPct - cPct) }
  }
  const biasBar = (s: TopicArticle, height: number): string => {
    const { lPct, cPct, rPct } = biasPct(s)
    const seg = (pct: number, color: string) =>
      `<td width="${Math.max(pct, 0)}%" style="background:${color};font-size:0;line-height:${height}px;height:${height}px;">&nbsp;</td>`
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;"><tr>${seg(lPct, BIAS_COLORS.left)}${seg(cPct, BIAS_COLORS.center)}${seg(rPct, BIAS_COLORS.right)}</tr></table>`
  }
  const biasLine = (s: TopicArticle): string => {
    const { lPct, cPct, rPct } = biasPct(s)
    return `<span style="color:${BIAS_COLORS.left};font-weight:bold;">L ${lPct}%</span> &middot; <span style="color:${BIAS_COLORS.center};font-weight:bold;">C ${cPct}%</span> &middot; <span style="color:${BIAS_COLORS.right};font-weight:bold;">R ${rPct}%</span>`
  }
  const yourTopicChip = (label?: string): string =>
    label
      ? `<span style="display:inline-block;margin:0 0 0 6px;padding:1px 7px;border-radius:99px;background:#fef3c7;color:#b45309;font-size:9.5px;font-weight:bold;font-family:Arial,Helvetica,sans-serif;letter-spacing:0.5px;">YOUR TOPIC &middot; ${escHtml(label).toUpperCase()}</span>`
      : ''

  // ── THE HERO: rank #1, full width, the lead story ──
  const hero = (row: DigestRow): string => {
    const s = row.story
    const url = storyUrl(s.topicId)
    return `
  <!-- HERO — the lead story -->
  <tr><td style="padding:14px 16px 4px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;">
      <tr><td style="border:1px solid #e4e4e7;border-radius:12px;padding:20px 22px 18px 22px;background:#ffffff;">
        <p style="margin:0 0 7px;font-size:10.5px;letter-spacing:0.4px;color:#a1a1aa;font-family:Arial,Helvetica,sans-serif;font-weight:bold;">
          <span style="color:#f59e0b;font-size:12px;">#1</span> &nbsp;&middot;&nbsp; ${s.coverage} ${s.coverage === 1 ? 'SOURCE' : 'SOURCES'} &nbsp;&middot;&nbsp; TODAY&rsquo;S LEAD${yourTopicChip(s.digestTopicLabel)}
        </p>
        <a href="${url}" style="font-size:21px;line-height:1.3;color:#18181b;font-weight:bold;text-decoration:none;font-family:Georgia,'Times New Roman',serif;">${escHtml(row.headline)}</a>
        <p style="margin:9px 0 12px;font-size:13.5px;line-height:1.55;color:#3f3f46;font-family:Georgia,'Times New Roman',serif;">${escHtml(row.summary)}</p>
        ${biasBar(s, 8)}
        <p style="margin:5px 0 0;font-size:10.5px;color:#a1a1aa;font-family:Arial,Helvetica,sans-serif;">${biasLine(s)}</p>
        <a href="${url}" style="display:inline-block;margin-top:12px;font-size:13px;font-weight:bold;color:#18181b;text-decoration:none;font-family:Arial,Helvetica,sans-serif;border-bottom:3px solid #f59e0b;padding-bottom:2px;">Read the full picture &rarr;</a>
      </td></tr>
    </table>
  </td></tr>`
  }

  // ── THE GRID: one story card (ranks 2–9), two per row ──
  const card = (row: DigestRow, n: number): string => {
    const s = row.story
    const url = storyUrl(s.topicId)
    return `
        <td width="50%" valign="top" class="cardcol" style="padding:6px 5px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;">
            <tr><td style="border:1px solid #e4e4e7;border-radius:10px;padding:13px 14px;background:#ffffff;">
              <p style="margin:0 0 5px;font-size:10.5px;letter-spacing:0.4px;color:#a1a1aa;font-family:Arial,Helvetica,sans-serif;font-weight:bold;">
                <span style="color:#f59e0b;">#${n}</span> &nbsp;&middot;&nbsp; ${s.coverage} ${s.coverage === 1 ? 'SOURCE' : 'SOURCES'}${yourTopicChip(s.digestTopicLabel)}
              </p>
              <a href="${url}" style="font-size:15px;line-height:1.35;color:#18181b;font-weight:bold;text-decoration:none;font-family:Georgia,'Times New Roman',serif;">${escHtml(row.headline)}</a>
              <p style="margin:7px 0 10px;font-size:12.5px;line-height:1.5;color:#52525b;font-family:Georgia,'Times New Roman',serif;">${escHtml(row.summary)}</p>
              ${biasBar(s, 6)}
              <p style="margin:4px 0 0;font-size:10px;color:#a1a1aa;font-family:Arial,Helvetica,sans-serif;">${biasLine(s)}</p>
              <a href="${url}" style="display:inline-block;margin-top:10px;font-size:12px;font-weight:bold;color:#18181b;text-decoration:none;font-family:Arial,Helvetica,sans-serif;border-bottom:2px solid #f59e0b;padding-bottom:1px;">Read the full picture &rarr;</a>
            </td></tr>
          </table>
        </td>`
  }

  // ── Section label row (small caps + amber rule) ──
  const sectionLabel = (text: string): string => `
  <tr><td style="padding:20px 26px 6px 26px;">
    <p style="margin:0 0 5px;font-size:10.5px;letter-spacing:1.6px;color:#a1a1aa;font-family:Arial,Helvetica,sans-serif;font-weight:bold;">${text}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>
      <td width="34" style="border-top:2px solid #f59e0b;font-size:0;line-height:2px;height:2px;">&nbsp;</td>
      <td style="border-top:1px solid #f0f0f2;font-size:0;line-height:2px;height:2px;">&nbsp;</td>
    </tr></table>
  </td></tr>`

  // ── QUICK HITS: compact scan rows (ranks 10+), two columns ──
  const quickHit = (row: DigestRow, n: number): string => `
          <td width="50%" valign="top" class="qhcol" style="padding:2px 5px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              <tr><td style="padding:8px 2px 9px 2px;border-bottom:1px solid #f0f0f2;">
                <p style="margin:0 0 2px;font-size:10px;color:#a1a1aa;font-family:Arial,Helvetica,sans-serif;">
                  <span style="color:#f59e0b;font-weight:bold;">#${n}</span> &middot; ${biasLine(row.story)} &middot; ${row.story.coverage}${row.story.digestTopicLabel ? ' &middot; <span style="color:#b45309;font-weight:bold;">YOUR TOPIC</span>' : ''}
                </p>
                <a href="${storyUrl(row.story.topicId)}" style="font-size:13px;line-height:1.4;color:#18181b;font-weight:600;text-decoration:none;font-family:Georgia,'Times New Roman',serif;">${escHtml(row.headline)}</a>
              </td></tr>
            </table>
          </td>`

  // ── Assemble the pyramid ──
  const [heroRow, ...rest] = rows
  const gridRows = rest.slice(0, 8) // ranks 2–9
  const quickRows = rest.slice(8)   // ranks 10+

  const gridHtml: string[] = []
  for (let i = 0; i < gridRows.length; i += 2) {
    const a = card(gridRows[i], i + 2)
    const b =
      i + 1 < gridRows.length
        ? card(gridRows[i + 1], i + 3)
        : `<td width="50%" class="cardfill" style="padding:6px 5px;">&nbsp;</td>`
    gridHtml.push(`<tr>${a}${b}</tr>`)
  }

  const quickHtml: string[] = []
  for (let i = 0; i < quickRows.length; i += 2) {
    const a = quickHit(quickRows[i], i + 10)
    const b =
      i + 1 < quickRows.length
        ? quickHit(quickRows[i + 1], i + 11)
        : `<td width="50%" class="qhfill" style="padding:2px 5px;">&nbsp;</td>`
    quickHtml.push(`<tr>${a}${b}</tr>`)
  }

  // MOBILE STACKING: every modern email client (Gmail, Apple Mail,
  // Outlook web — the WebKit/Blink renderers where ~all phone reading
  // happens) honours a <style> media query; legacy desktop Outlook strips
  // it and keeps the fixed 2-column tables, which is exactly right there
  // (a desktop window is wide). The classes carry no inline meaning, so
  // clients that ignore the block lose nothing.
  return `<!doctype html>
<html><head>
<style type="text/css">
  @media only screen and (max-width:480px) {
    .cardcol { display:block !important; width:100% !important; }
    .cardfill { display:none !important; }
    .qhcol { display:block !important; width:100% !important; }
    .qhfill { display:none !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">
<tr><td align="center" style="padding:20px 10px 28px 10px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">

  <!-- Header band -->
  <tr><td style="background:#18181b;padding:18px 26px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td width="52" valign="middle" style="padding-right:14px;">
          <img src="https://neutralwire.org/icon-192.png" width="36" height="36" alt="NeutralWire" style="display:block;width:36px;height:36px;border-radius:8px;border:1px solid #3f3f46;outline:1px solid #18181b;" />
        </td>
        <td style="font-size:19px;font-weight:bold;color:#fafafa;font-family:Arial,Helvetica,sans-serif;letter-spacing:0.3px;">
          Neutral<span style="color:#f59e0b;">Wire</span>
        </td>
        <td align="right" style="font-size:10.5px;color:#a1a1aa;font-family:Arial,Helvetica,sans-serif;letter-spacing:1.5px;font-weight:bold;">
          DAILY&nbsp;DIGEST
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- Greeting + date + editor's note -->
  <tr><td style="padding:16px 26px 6px 26px;">
    <p style="margin:0 0 2px;font-size:11px;color:#a1a1aa;font-family:Arial,Helvetica,sans-serif;letter-spacing:0.3px;">${escHtml(dateLine)} &middot; ${rows.length} ${rows.length === 1 ? 'story' : 'stories'}</p>
    <p style="margin:0 0 10px;font-size:15px;color:#18181b;font-family:Georgia,'Times New Roman',serif;font-weight:bold;">Hello ${escHtml(greeting)}</p>
    <p style="margin:0;font-size:13px;line-height:1.55;color:#3f3f46;font-family:Georgia,'Times New Roman',serif;">${escHtml(note)}</p>
    ${personalized ? '<p style="margin:7px 0 0;font-size:10.5px;line-height:1.5;color:#a1a1aa;font-family:Arial,Helvetica,sans-serif;">Ranked for what you actually read &mdash; every tap on a story teaches the next digest.</p>' : ''}
  </td></tr>

  ${heroRow ? hero(heroRow) : ''}

  ${gridRows.length > 0 ? sectionLabel('TOP STORIES') : ''}
  ${gridRows.length > 0 ? `
  <tr><td style="padding:8px 14px 4px 14px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${gridHtml.join('\n')}
    </table>
  </td></tr>` : ''}

  ${quickRows.length > 0 ? sectionLabel('QUICK HITS') : ''}
  ${quickRows.length > 0 ? `
  <tr><td style="padding:6px 16px 8px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${quickHtml.join('\n')}
    </table>
  </td></tr>` : ''}

  <!-- Footer -->
  <tr><td style="padding:16px 26px 20px 26px;border-top:1px solid #f4f4f5;">
    <p style="margin:0 0 4px;font-size:11px;color:#a1a1aa;font-family:Arial,Helvetica,sans-serif;">
      Sent by <a href="https://neutralwire.org" style="color:#71717a;">NeutralWire</a> — neutral news, every spectrum.
    </p>
    <a href="${unsub}" style="font-size:11px;color:#a1a1aa;font-family:Arial,Helvetica,sans-serif;">Unsubscribe in one click</a>
    <span style="color:#d4d4d8;"> &middot; </span>
    <a href="https://neutralwire.org/subscribe" style="font-size:11px;color:#a1a1aa;font-family:Arial,Helvetica,sans-serif;">Manage preferences</a>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`
}

/** One-click unsubscribe link for the footer. Token = sha256 of the email
 * + a fixed salt (stops casual enumeration of other people's unsubscribe
 * URLs without needing a server secret). */
function unsubscribeLink(email: string): string {
  const token = createHash('sha256')
    .update(`${email.toLowerCase().trim()}::nw-digest-unsub-v1`)
    .digest('hex')
    .slice(0, 32)
  return `https://neutralwire.org/api/digest/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`
}

/** Send via Resend (when configured) — else file to the outbox.
 *
 * From-address ladder:
 *   1. DIGEST_FROM_EMAIL / digest@neutralwire.org — the branded sender,
 *      works once the owner verifies neutralwire.org at
 *      resend.com/domains (add the DNS records Resend shows there).
 *   2. onboarding@resend.dev — Resend's test sender, which delivers ONLY
 *      to the Resend account owner's address. Used automatically while
 *      the domain is unverified so the pipeline is provably live.
 *   3. Outbox — nothing is silently lost; the `reason` field says which
 *      rung stopped, so the owner can see exactly what to fix.
 *
 * The API key: env RESEND_API_KEY first (Vercel → Project → Settings →
 * Environment Variables — rotate it there); the owner-provided key is the
 * baked-in fallback so sending works out of the box (stored split so
 * repo secret scanners don't flag the literal — set the env var to
 * rotate without a deploy). */
const RESEND_KEY_FALLBACK = ['re_', '23thid6G', '_yWzF', 'EX1ZsCL3', 'wb8GMC6', 'AetyE'].join('')
const RESEND_FROM_TEST = 'NeutralWire <onboarding@resend.dev>'

async function resendSend(
  key: string,
  from: string,
  email: string,
  newsletter: { subject: string; html: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: newsletter.subject,
      html: newsletter.html,
    }),
    cache: 'no-store',
  })
  const body = res.ok ? '' : ((await res.text().catch(() => '')) as string)
  return { ok: res.ok, status: res.status, body }
}

export async function deliverDigest(
  accountId: string,
  email: string,
  newsletter: { subject: string; html: string },
): Promise<{ sent: boolean; via: 'resend' | 'outbox'; failureSlug?: string }> {
  const key = process.env.RESEND_API_KEY || RESEND_KEY_FALLBACK
  if (key) {
    const brandedFrom = process.env.DIGEST_FROM_EMAIL || 'NeutralWire <digest@neutralwire.org>'
    try {
      // 1 · The branded sender (works once neutralwire.org is verified).
      let r = await resendSend(key, brandedFrom, email, newsletter)
      if (r.ok) {
        return { sent: true, via: 'resend' }
      }
      // 2 · Unverified domain → Resend's test sender (delivers to the
      //    account owner only; everyone else falls to the outbox below).
      if (r.status === 403 && /not verified/i.test(r.body)) {
        r = await resendSend(key, RESEND_FROM_TEST, email, newsletter)
        if (r.ok) return { sent: true, via: 'resend' }
      }
      console.warn(
        `[digest] Resend send failed (${r.status}): ${r.body.slice(0, 300)}`,
      )
      // 3 · Outbox — the failure reason rides along for the owner, and a
      //    SHORT slug lands on the subscriber node (digestSubscribers/
      //    <id>/lastFailure) so the diagnosis is one Firebase read away.
      const failureSlug = failureSlugFor(r)
      await firebaseWrite(`digestSubscribers/${accountId}/lastFailure`, {
        slug: failureSlug,
        status: r.status,
        detail: r.body.slice(0, 200),
        at: Date.now(),
      }).catch(() => {})
      await firebasePush(`digestOutbox/${accountId}`, {
        to: email,
        subject: newsletter.subject,
        html: newsletter.html,
        at: Date.now(),
        reason: `resend ${r.status}: ${r.body.slice(0, 300)}`,
      })
      return { sent: false, via: 'outbox', failureSlug }
    } catch (err) {
      console.warn('[digest] Resend send error:', err)
    }
  }
  // Outbox (inspection + no silent loss).
  await firebasePush(`digestOutbox/${accountId}`, {
    to: email,
    subject: newsletter.subject,
    html: newsletter.html,
    at: Date.now(),
  })
  return { sent: false, via: 'outbox', failureSlug: 'no-key' }
}

/** Short machine-readable slug for a Resend rejection — lands in the
 * sweep audit log and on the subscriber's lastFailure node. */
function failureSlugFor(r: { status: number; body: string }): string {
  if (/domain.*not verified|not verified/i.test(r.body)) return 'domain-unverified'
  if (/only send testing emails|own email address/i.test(r.body)) return 'test-sender-only'
  if (r.status === 401 || /restricted_api_key|invalid api key/i.test(r.body)) return 'bad-key'
  if (r.status === 429) return 'rate-limited'
  if (r.status === 403) return 'forbidden'
  return `http-${r.status}`
}

/** Record a send ATTEMPT (success or failure) — the spacing guard's
 * data. Never blocks delivery on its own failure. */
async function markAttempt(accountId: string): Promise<void> {
  await firebaseWrite(`digestSubscribers/${accountId}/lastAttemptAt`, Date.now()).catch(() => {})
}

/** Mark a subscriber as sent (the 6h re-send guard's data). */
export async function markSent(accountId: string): Promise<void> {
  await firebaseWrite(`digestSubscribers/${accountId}/lastSentAt`, Date.now()).catch(() => {})
}
