import { NextRequest, NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'crypto'
import {
  readInterestProfile,
  recordInterestEvent,
  PROFILE_ROOT,
  isSmartPersonalizationOn,
  type InterestEventType,
} from '@/lib/interest-engine'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * POST /api/interest/track — the client's learning ping.
 *
 * Body: {
 *   deviceId?: string        // device-level profile
 *   accountId?: string       // account-level profile (mirrored, 1.2× weight)
 *   type: 'story_open' | 'story_share' | 'story_like' | 'story_dislike'
 *       | 'digest_click' | 'notification_click' | 'notification_dismiss'
 *       | 'interests_pick'
 *   topicId?, title?, summary?, category?, sectors? (interests_pick)
 * }
 *
 * Fire-and-forget by design: always answers {ok:true}-ish FAST, never
 * throws, never blocks the page. Learning must be invisible.
 *
 * GET  /api/interest/track?deviceId=…&password=… — admin inspector read
 * (the /debug Interest Inspector card): profile + recent event ring.
 * Password-gated like every debug surface (the profile data is private).
 */

const PASSWORD_HASH = '5c2113db1bd51e6e6fce4205d8eb36e41f5018d5d32d4c04b294fb02192f474a'

function verifyPassword(input: string): boolean {
  const inputHash = createHash('sha256').update(input).digest('hex')
  if (inputHash.length !== PASSWORD_HASH.length) return false
  try {
    return timingSafeEqual(Buffer.from(inputHash), Buffer.from(PASSWORD_HASH))
  } catch {
    return false
  }
}

const VALID_TYPES: InterestEventType[] = [
  'story_open', 'story_share', 'story_like', 'story_dislike',
  'digest_click', 'notification_click', 'notification_dismiss', 'interests_pick',
]

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      deviceId?: string
      accountId?: string
      type?: string
      topicId?: string
      title?: string
      summary?: string
      category?: string
      sectors?: string[]
    }

    if (!body.type || !VALID_TYPES.includes(body.type as InterestEventType)) {
      return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
    }
    const deviceId = (body.deviceId || '').trim().slice(0, 64)
    const accountId = (body.accountId || '').trim().slice(0, 64)
    if (!deviceId && !accountId) {
      return NextResponse.json({ error: 'deviceId or accountId required' }, { status: 400 })
    }

    // Never accept unbounded payloads — the title/summary are for term
    // extraction only.
    const title = (body.title || '').slice(0, 200)
    const summary = (body.summary || '').slice(0, 300)
    const topicId = (body.topicId || '').slice(0, 80) || undefined

    const result = await recordInterestEvent({
      deviceId: deviceId || null,
      accountId: accountId || null,
      event: {
        type: body.type as InterestEventType,
        topicId,
        title: title || undefined,
        summary: summary || undefined,
        category: (body.category || '').slice(0, 30) || undefined,
        sectors: Array.isArray(body.sectors) ? body.sectors.slice(0, 10) : undefined,
      },
    })

    // digest_click carries a second duty: it clears the "emailed but never
    // clicked" drag for that story in the sender's sentTopics ledger, so
    // future digests stop demoting a story the reader demonstrably wanted
    // (and give it a small +6 instead).
    if (body.type === 'digest_click' && accountId && topicId) {
      try {
        const path = `digestSubscribers/${accountId}/sentTopics/${topicId}`
        const existing = await firebaseRead<{ n?: number; ts?: number; clicked?: boolean }>(path)
        if (existing) {
          await firebaseWrite(path, { ...existing, clicked: true, clickedAt: Date.now() })
        }
      } catch {
        // ledger bookkeeping only — never fail the ping
      }
    }

    return NextResponse.json({ ok: true, learned: result.updated.length })
  } catch {
    // Tracking failures are ALWAYS silent — the learning system must
    // never degrade the user experience.
    return NextResponse.json({ ok: true, learned: 0 })
  }
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const password = sp.get('password') || ''
  const deviceId = (sp.get('deviceId') || '').trim().slice(0, 64)
  if (!deviceId) {
    return NextResponse.json({ error: 'deviceId required' }, { status: 400 })
  }
  if (!verifyPassword(password)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const [profile, events, smartOn] = await Promise.all([
      readInterestProfile(deviceId),
      firebaseRead<Record<string, { type: string; topicId?: string | null; title?: string | null; at: number }>>(
        `${PROFILE_ROOT}/${deviceId}/events`,
      ),
      isSmartPersonalizationOn(),
    ])

    const eventList = Object.entries(events || {})
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .slice(0, 20)
      .map(([k, v]) => ({ id: k, ...v }))

    return NextResponse.json({
      ok: true,
      deviceId,
      smartPersonalization: smartOn,
      profile: profile
        ? {
            version: profile.version,
            createdAt: profile.createdAt,
            updatedAt: profile.updatedAt,
            eventCount: profile.eventCount,
            termCount: Object.keys(profile.terms).length,
            topicCount: Object.keys(profile.topics).length,
            topTerms: Object.entries(profile.terms)
              .sort((a, b) => b[1].s - a[1].s)
              .slice(0, 24)
              .map(([term, v]) => ({ term, score: Math.round(v.s * 10) / 10, touches: v.c, lastSeen: v.ts })),
            negativeTerms: Object.entries(profile.terms)
              .sort((a, b) => a[1].s - b[1].s)
              .slice(0, 8)
              .map(([term, v]) => ({ term, score: Math.round(v.s * 10) / 10, touches: v.c })),
            sectors: Object.entries(profile.sectors)
              .sort((a, b) => b[1] - a[1])
              .map(([sector, score]) => ({ sector, score: Math.round(score) })),
          }
        : null,
      events: eventList,
    })
  } catch (err) {
    return NextResponse.json({ error: 'Profile read failed', detail: String(err) }, { status: 500 })
  }
}
