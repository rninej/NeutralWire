import { NextRequest, NextResponse } from 'next/server'
import {
  readSession,
  getAccountById,
  setAccountTier,
} from '@/lib/subscriptions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 20

/**
 * POST /api/subscription/cancel — cancel the visitor's own subscription.
 *
 * LIVE Stripe mode: if we have a stored subscription id we call Stripe to
 * cancel at period end (the visitor keeps the tier until then); otherwise
 * we cancel immediately at Stripe using the stored customer. The webhook
 * finalises the tier change.
 * TEST mode: downgrade takes effect immediately (with a 0-day grace —
 * simplest for testing).
 */
export async function POST(req: NextRequest) {
  const session = await readSession(req)
  if (!session?.accountId) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  }
  const account = await getAccountById(session.accountId)
  if (!account || !account.tier || account.tier === 'free') {
    return NextResponse.json({ error: 'No active subscription.' }, { status: 400 })
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY || ''

  // ── TEST MODE: immediate downgrade ──
  if (!stripeKey || account.tierSource === 'test' || !account.stripeSubscriptionId) {
    await setAccountTier(session.accountId, {
      tier: 'free',
      renewsAt: null,
      source: account.tierSource || 'test',
    })
    return NextResponse.json({
      ok: true,
      tier: 'free',
      effective: 'immediately',
      mode: stripeKey ? 'stripe-test' : 'test',
    })
  }

  // ── LIVE MODE: cancel at period end via Stripe REST ──
  try {
    const res = await fetch(
      `https://api.stripe.com/v1/subscriptions/${account.stripeSubscriptionId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${stripeKey}` },
        cache: 'no-store',
      },
    )
    if (!res.ok) {
      const err = (await res.json()) as { error?: { message?: string } }
      console.warn('[subscription/cancel] Stripe error:', err.error?.message)
      return NextResponse.json(
        { error: 'Stripe cancel failed', detail: err.error?.message },
        { status: 502 },
      )
    }
    await setAccountTier(session.accountId, {
      tier: account.tier,
      renewsAt: account.tierRenewsAt ?? null,
      source: 'stripe',
      cancelAtEnd: true,
    })
    return NextResponse.json({
      ok: true,
      tier: account.tier,
      effective: 'period-end',
      renewsAt: account.tierRenewsAt ?? null,
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Cancel failed', detail: String(err) },
      { status: 500 },
    )
  }
}
