import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { firebasePatch } from '@/lib/firebase-server'
import { getRequesterTier, readSession, getAccountById } from '@/lib/subscriptions'
import {
  subscribeCustomTopic,
  unsubscribeCustomTopic,
  readCustomFeed,
  refreshCustomTopic,
} from '@/lib/custom-topics'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 30

/**
 * POST /api/subtopics/subscribe — track which custom topics have followers.
 *
 * Body: { topicId: string, action: 'add' | 'remove' }
 *
 * • Premium gate (402 + needUpgrade when a free user tries to add).
 * • 'add' bumps customSubscriptions/<topicId>.count — this is what makes
 *   the refresh cron keep the topic's feed warm (topics with 0 followers
 *   cost nothing).
 * • 'add' ALSO warms the feed right now, in the background (after()):
 *   catalog topics previously had NO first fill — the user tapped their
 *   new chip and waited 12s only to get an empty feed (GDELT cold start
 *   or a 429). Filling post-response means the feed is usually warm by
 *   the time the picker closes and the chip is tapped.
 * • Logged-in accounts ALSO persist their topic list on the account
 *   (prefs.customSubtopics) so it follows them across devices.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      topicId?: string
      action?: 'add' | 'remove'
      label?: string
    }
    const topicId = (body.topicId || '').trim()
    if (!topicId || !/^[a-z0-9-]{1,60}$/.test(topicId)) {
      return NextResponse.json({ error: 'Invalid topicId' }, { status: 400 })
    }
    const action = body.action === 'remove' ? 'remove' : 'add'

    const requester = await getRequesterTier(req)
    if (action === 'add' && !requester.allUnlocked && requester.tier === 'free') {
      return NextResponse.json(
        { error: 'Custom subtopics are a Premium feature.', needUpgrade: true },
        { status: 402 },
      )
    }

    if (action === 'add') {
      await subscribeCustomTopic(topicId)
      // Background first fill (post-response). Only when the cached feed
      // is missing or stale — a healthy feed costs nothing. Failures are
      // silent: the cron's rotation + /api/news's synchronous fallback
      // remain the safety net.
      after(async () => {
        try {
          const existing = await readCustomFeed(topicId)
          const stale =
            !existing ||
            !Array.isArray(existing.topics) ||
            existing.topics.length === 0 ||
            Date.now() - (existing.updatedAt || 0) > 3 * 3600 * 1000
          if (stale) {
            // Background mode: patient GDELT timings + the AI keyword
            // fallback — nobody is waiting on this fill, it just needs to
            // be warm before the chip gets tapped.
            await refreshCustomTopic(topicId, { aiFilter: false, mode: 'background' })
          }
        } catch {}
      })
    } else {
      await unsubscribeCustomTopic(topicId)
    }

    // Persist on the account when signed in (cross-device list).
    const session = await readSession(req)
    if (session?.accountId) {
      const account = await getAccountById(session.accountId)
      const current = account?.prefs?.customSubtopics || []
      let next: string[]
      if (action === 'add') {
        next = Array.from(new Set([...current, topicId])).slice(-40)
      } else {
        next = current.filter((t) => t !== topicId)
      }
      await firebasePatch(`accounts/${session.accountId}/prefs`, {
        customSubtopics: next,
      }).catch(() => {})
    }

    return NextResponse.json({ ok: true, topicId, action })
  } catch (err) {
    return NextResponse.json(
      { error: 'Subscribe failed', detail: String(err) },
      { status: 500 },
    )
  }
}
