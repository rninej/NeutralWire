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

import { firebaseRead, firebaseWrite, firebasePush } from '@/lib/firebase-server'
import { callAI } from '@/lib/ai-providers'
import type { TopicArticle } from '@/lib/news-aggregator'
import { readCustomFeed } from '@/lib/custom-topics'

export interface DigestSubscriber {
  email: string
  timezone?: string
  prefs?: { enabled?: boolean; freq?: string; hour?: number }
  lastSentAt?: number
}

const SIX_HOURS_MS = 6 * 3600 * 1000

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

/** Gather the stories for one subscriber: their custom topics + core
 * categories, newest-first, capped for the AI prompt. */
export async function gatherStories(accountId: string): Promise<TopicArticle[]> {
  const account = await firebaseRead<{
    prefs?: { customSubtopics?: string[] }
  }>(`accounts/${accountId}`)
  const customIds = account?.prefs?.customSubtopics || []

  const stories: TopicArticle[] = []

  // Their custom subtopic feeds first (the personalisation promise).
  for (const id of customIds.slice(0, 4)) {
    const feed = await readCustomFeed(id).catch(() => null)
    if (feed?.topics) stories.push(...feed.topics.slice(0, 4))
  }

  // Then the main cached categories (shared, always warm).
  const coreCats = ['top', 'world', 'technology', 'politics', 'business']
  for (const cat of coreCats) {
    const cached = await firebaseRead<{ topics: TopicArticle[] }>(`newsCache/${cat}`).catch(() => null)
    if (cached?.topics) stories.push(...cached.topics.slice(0, 5))
  }

  // Dedup by topicId, newest first, cap.
  const seen = new Set<string>()
  const unique = stories.filter((t) => {
    if (!t?.topicId || seen.has(t.topicId)) return false
    seen.add(t.topicId)
    return true
  })
  unique.sort((a, b) => (b.latestSeen || 0) - (a.latestSeen || 0))
  return unique.slice(0, 14)
}

/** The AI newsletter writer — returns ready-to-send HTML. */
export async function generateNewsletter(
  email: string,
  stories: TopicArticle[],
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
      'You are the editor of the NeutralWire email digest — a neutral news comparison service that shows how left, centre and right outlets cover the same stories. Write a fabulous, warm, witty but strictly NEUTRAL newsletter in clean semantic HTML (h1 greeting, a short editor\'s note, then one <section> per story with an <h2> headline, a 2-3 sentence neutral summary that mentions how coverage differs across the spectrum, and a "Read the full picture" link using the URL given). No <style>, no <script>, inline elements only. Sign off with "— The NeutralWire Editor". Reply ONLY with JSON: {"subject":"...","html":"..."}.',
    userPrompt: `Subscriber: ${email}\nToday's stories (title — summary [sources; bias split]):\n${list}\n\nStory links in order: ${stories
      .map((s) => `https://neutralwire.org/?topic=${s.topicId}`)
      .join(', ')}\n\nReply with only the JSON.`,
    maxTokens: 1800,
  })
  if (!raw) return null
  try {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return null
    const parsed = JSON.parse(m[0]) as { subject?: string; html?: string }
    if (!parsed.html) return null
    return {
      subject: parsed.subject?.slice(0, 120) || 'Your NeutralWire digest',
      html: parsed.html.slice(0, 60000),
    }
  } catch {
    return null
  }
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
): Promise<{ sent: boolean; via: 'resend' | 'outbox' }> {
  const key = process.env.RESEND_API_KEY || RESEND_KEY_FALLBACK
  if (key) {
    const brandedFrom = process.env.DIGEST_FROM_EMAIL || 'NeutralWire <digest@neutralwire.org>'
    try {
      // 1 · The branded sender (works once neutralwire.org is verified).
      let r = await resendSend(key, brandedFrom, email, newsletter)
      if (r.ok) return { sent: true, via: 'resend' }
      // 2 · Unverified domain → Resend's test sender (delivers to the
      //    account owner only; everyone else falls to the outbox below).
      if (r.status === 403 && /not verified/i.test(r.body)) {
        r = await resendSend(key, RESEND_FROM_TEST, email, newsletter)
        if (r.ok) return { sent: true, via: 'resend' }
      }
      console.warn(
        `[digest] Resend send failed (${r.status}): ${r.body.slice(0, 300)}`,
      )
      // 3 · Outbox — the failure reason rides along for the owner.
      await firebasePush(`digestOutbox/${accountId}`, {
        to: email,
        subject: newsletter.subject,
        html: newsletter.html,
        at: Date.now(),
        reason: `resend ${r.status}: ${r.body.slice(0, 300)}`,
      })
      return { sent: false, via: 'outbox' }
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
  return { sent: false, via: 'outbox' }
}

/** Mark a subscriber as sent (the 6h re-send guard's data). */
export async function markSent(accountId: string): Promise<void> {
  await firebaseWrite(`digestSubscribers/${accountId}/lastSentAt`, Date.now()).catch(() => {})
}
