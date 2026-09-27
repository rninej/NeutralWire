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
 * KO-FI (the live provider): Ko-fi exposes no cancellation API, so the
 * tier is revoked HERE immediately and the supporter is reminded to also
 * cancel the membership on Ko-fi (otherwise it keeps charging and the
 * next webhook payment re-grants — by design, a payment is always
 * honoured).
 * LEGACY Stripe: a stored subscription id is cancelled at period end via
 * the Stripe REST API; test-source tiers downgrade immediately.
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

  // ── KO-FI or TEST source: immediate downgrade (no provider API to
  //    call — the reminder to cancel on Ko-fi comes with the response). ──
  if (account.tierSource !== 'stripe' || !account.stripeSubscriptionId) {
    await setAccountTier(session.accountId, {
      tier: 'free',
      renewsAt: null,
      source: account.tierSource || 'test',
    })
    return NextResponse.json({
      ok: true,
      tier: 'free',
      effective: 'immediately',
      mode: account.tierSource === 'kofi' ? 'kofi' : 'test',
      reminder:
        account.tierSource === 'kofi'
          ? 'Also cancel the membership on Ko-fi so it stops charging — a future payment would re-grant the tier.'
          : undefined,
    })
  }

  // ── LEGACY Stripe source: cancel at period end via Stripe REST ──
  const stripeKey = process.env.STRIPE_SECRET_KEY || ''
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
