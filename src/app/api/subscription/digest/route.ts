import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead, firebasePatch } from '@/lib/firebase-server'
import { getRequesterTier, readSession, type DigestPrefs } from '@/lib/subscriptions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * GET  /api/subscription/digest — the visitor's email-digest preferences.
 * POST /api/subscription/digest — save them (Premium only).
 *
 * Body: { enabled: boolean, freq: 'weekly'|'daily'|'2x'|'3x', hour: 0-23 }
 */
export async function GET(req: NextRequest) {
  const requester = await getRequesterTier(req)
  const session = await readSession(req)
  let prefs: Partial<DigestPrefs> | null = null
  if (session?.accountId) {
    const account = await firebaseRead<{ prefs?: { digest?: Partial<DigestPrefs> } }>(
      `accounts/${session.accountId}`,
    )
    prefs = account?.prefs?.digest || null
  }
  return NextResponse.json({
    tier: requester.tier,
    model: requester.model,
    digest: prefs || { enabled: false, freq: 'daily', hour: 8 },
    email: requester.email,
  })
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      enabled?: boolean
      freq?: string
      hour?: number
    }
    const requester = await getRequesterTier(req)
    if (!requester.allUnlocked && requester.tier === 'free') {
      return NextResponse.json(
        { error: 'The email digest is a Premium feature.', needUpgrade: true },
        { status: 402 },
      )
    }
    const session = await readSession(req)
    if (!session?.accountId) {
      return NextResponse.json(
        { error: 'Sign in to save digest preferences.', needAccount: true },
        { status: 401 },
      )
    }

    const freq: DigestPrefs['freq'] =
      body.freq === 'weekly' || body.freq === 'daily' || body.freq === '2x' || body.freq === '3x'
        ? body.freq
        : 'daily'
    const hour = Math.min(23, Math.max(0, Math.round(Number(body.hour ?? 8))))
    const prefs: DigestPrefs = {
      enabled: body.enabled !== false,
      freq,
      hour,
    }
    await firebasePatch(`accounts/${session.accountId}/prefs`, { digest: prefs })

    // Maintain the tiny subscribers index the cron reads (never scan the
    // whole accounts tree). Remove when disabled.
    const requester2 = await getRequesterTier(req)
    if (prefs.enabled) {
      await firebasePatch(`digestSubscribers/${session.accountId}`, {
        email: requester2.email || '',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        prefs,
      }).catch(() => {})
    } else {
      const { firebaseDelete } = await import('@/lib/firebase-server')
      await firebaseDelete(`digestSubscribers/${session.accountId}`).catch(() => {})
    }
    return NextResponse.json({ ok: true, digest: prefs })
  } catch (err) {
    return NextResponse.json(
      { error: 'Could not save digest preferences', detail: String(err) },
      { status: 500 },
    )
  }
}
