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
 * Body: { enabled, freq: 'weekly'|'daily'|'2x'|'3x', hour: 0-23, email? }
 *
 * `email` is the CUSTOM DELIVERY ADDRESS for the newsletter (defaults to
 * the account email). It is persisted in prefs.digest.email and mirrored
 * into digestSubscribers/<accountId>.email — the cron reads that node, so
 * a custom address needs zero cron changes.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

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
      email?: string
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

    // MERGE with the stored prefs — a partial save (e.g. just the custom
    // newsletter address from the Profile card) must never reset the
    // cadence/hour the visitor already chose.
    const account = await firebaseRead<{ prefs?: { digest?: Partial<DigestPrefs> } }>(
      `accounts/${session.accountId}`,
    )
    const existing = account?.prefs?.digest || {}

    const freq: DigestPrefs['freq'] =
      body.freq === 'weekly' || body.freq === 'daily' || body.freq === '2x' || body.freq === '3x'
        ? body.freq
        : (existing.freq as DigestPrefs['freq']) || 'daily'
    const hour =
      body.hour !== undefined
        ? Math.min(23, Math.max(0, Math.round(Number(body.hour))))
        : typeof existing.hour === 'number'
          ? existing.hour
          : 8
    const enabled =
      body.enabled !== undefined ? body.enabled !== false : existing.enabled !== false

    // Custom newsletter address: '' clears it (back to the account email);
    // otherwise it must look like a real address. Undefined = keep stored.
    let customEmail: string | undefined
    if (typeof body.email === 'string') {
      const trimmed = body.email.trim()
      if (trimmed === '') {
        customEmail = undefined
      } else if (EMAIL_RE.test(trimmed)) {
        customEmail = trimmed.toLowerCase()
      } else {
        return NextResponse.json(
          { error: 'That newsletter address doesn\u2019t look valid.' },
          { status: 400 },
        )
      }
    } else if (typeof existing.email === 'string' && existing.email) {
      customEmail = existing.email
    }

    const prefs: DigestPrefs = {
      enabled,
      freq,
      hour,
      ...(customEmail !== undefined ? { email: customEmail } : {}),
    }
    await firebasePatch(`accounts/${session.accountId}/prefs`, { digest: prefs })

    // Maintain the tiny subscribers index the cron reads (never scan the
    // whole accounts tree). Remove when disabled.
    const requester2 = await getRequesterTier(req)
    if (prefs.enabled) {
      await firebasePatch(`digestSubscribers/${session.accountId}`, {
        email: customEmail || requester2.email || '',
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
