import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead, firebasePatch } from '@/lib/firebase-server'
import { readSession, getAccountById, emailKey, applyKofiPayment } from '@/lib/subscriptions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 20

/**
 * POST /api/kofi/claim — "I already paid on Ko-fi, find my payment".
 *
 * Body: { email? } — defaults to the signed-in account's email.
 *
 * Scans kofiEvents for UNCLAIMED subscription payments whose Ko-fi email
 * matches (case-insensitive), oldest first, and grants the HIGHEST tier
 * found to the signed-in account. Also links the Ko-fi email to the
 * account so future renewals auto-match without claiming again.
 *
 * Used two ways:
 *   • Manually — the "Check for my payment" button after paying.
 *   • Automatically — the checkout UI polls this while waiting for the
 *     webhook, so email-matched payments land even if the supporter
 *     ignored the claim-code instruction.
 */
interface KofiEventRecord {
  at?: number
  type?: string
  amount?: string
  email?: string
  tier?: 'premium' | 'ultra' | null
  isSubscriptionPayment?: boolean
  claimed?: boolean
  accountId?: string | null
}

export async function POST(req: NextRequest) {
  try {
    const session = await readSession(req)
    if (!session?.accountId) {
      return NextResponse.json(
        { error: 'Sign in first — payments are linked to accounts.', needAccount: true },
        { status: 401 },
      )
    }
    const account = await getAccountById(session.accountId)
    if (!account) {
      return NextResponse.json({ error: 'Account not found.' }, { status: 401 })
    }

    let body: { email?: string } = {}
    try {
      body = (await req.json()) as { email?: string }
    } catch {}

    const email = String(body.email || account.email || '').trim().toLowerCase()
    if (!email) {
      return NextResponse.json({ error: 'No email to match against.' }, { status: 400 })
    }

    // Sanity: a real-looking address (prevents scanning with junk input).
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'That does not look like an email address.' }, { status: 400 })
    }

    const events = await firebaseRead<Record<string, KofiEventRecord>>('kofiEvents')
    const matches = Object.entries(events || {})
      .filter(
        ([, ev]) =>
          ev &&
          ev.claimed !== true &&
          (ev.tier === 'premium' || ev.tier === 'ultra') &&
          String(ev.email || '').toLowerCase() === email,
      )
      .sort((a, b) => (a[1].at || 0) - (b[1].at || 0))

    if (matches.length === 0) {
      return NextResponse.json({
        ok: true,
        granted: null,
        email,
        message: 'No unclaimed Ko-fi payment found for that email yet — it can take a minute after paying.',
      })
    }

    // Grant the HIGHEST tier among the unclaimed matches (Ultra beats
    // Premium; a single claim consumes every matching event so renewals
    // can't double-apply later).
    const best = matches.reduce((acc, m) =>
      (m[1].tier || 'premium') === 'ultra' || acc[1].tier === 'premium' ? m : acc,
    )
    const tier = best[1].tier === 'ultra' ? 'ultra' : 'premium'
    const renewal = Boolean(
      best[1].isSubscriptionPayment && matches.filter((m) => m[1].claimed !== true).length > 1,
    )

    const ok = await applyKofiPayment(session.accountId, tier, {
      renewal,
      kofiEmail: email,
    })
    if (!ok) {
      return NextResponse.json({ error: 'Could not apply the payment — try again.' }, { status: 500 })
    }

    // Mark every matching event claimed by this account.
    await Promise.all(
      matches.map(([id]) =>
        firebasePatch(`kofiEvents/${id}`, {
          claimed: true,
          accountId: session.accountId,
          claimedAt: Date.now(),
          claimedVia: 'manual',
        }).catch(() => {}),
      ),
    )
    // Record the link for future renewals (applyKofiPayment already wrote
    // kofiEmailIndex; this mirrors it on the account doc itself).
    await firebasePatch(`accounts/${session.accountId}`, { kofiEmail: email }).catch(() => {})

    console.log(`[kofi/claim] GRANTED ${tier} → account ${session.accountId} (email ${email}, ${matches.length} event(s))`)
    return NextResponse.json({ ok: true, granted: tier, email, count: matches.length })
  } catch (err) {
    return NextResponse.json(
      { error: 'Claim failed', detail: String(err) },
      { status: 500 },
    )
  }
}

/** GET — status of the signed-in account's Ko-fi linkage (debug/UI). */
export async function GET(req: NextRequest) {
  const session = await readSession(req)
  if (!session?.accountId) {
    return NextResponse.json({ linked: false })
  }
  const account = await getAccountById(session.accountId)
  const email = account?.kofiEmail || ''
  const index = email
    ? await firebaseRead<{ accountId?: string }>(`kofiEmailIndex/${emailKey(email)}`)
    : null
  return NextResponse.json({
    linked: Boolean(email && index?.accountId === session.accountId),
    kofiEmail: email || null,
  })
}
