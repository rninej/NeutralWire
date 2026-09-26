import { NextRequest, NextResponse } from 'next/server'
import {
  readSession,
  getAccountById,
  setAccountTier,
  quoteForCountry,
} from '@/lib/subscriptions'
import { firebasePatch } from '@/lib/firebase-server'
import { detectCountryServer } from '@/lib/country-detect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 20

/**
 * POST /api/subscription/checkout — start a subscription.
 *
 * Body: { tier: 'premium' | 'ultra', deviceId?, email? }
 *
 * TWO MODES:
 *   1. LIVE (STRIPE_SECRET_KEY set) — creates a real Stripe Checkout
 *      Session (mode=subscription, monthly, currency localised to the
 *      visitor's country: £3/$3/€3 premium, £20/$20/€20 ultra) and returns
 *      { url } to redirect to. Fulfilment happens in /api/subscription/webhook.
 *   2. TEST (no Stripe key) — grants the tier immediately with
 *      tierSource 'test', renewsAt +30 days. This is the sandbox / owner
 *      test path; the /debug Subscription Manager can revoke at any time.
 *
 * An ACCOUNT is REQUIRED (the user's spec: "to get premium you have to make
 * an account"). Logged-out callers get 401 { needAccount: true } and the UI
 * shows the register/login step inside the upgrade dialog.
 */
const STRIPE_API = 'https://api.stripe.com/v1'

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      tier?: string
      deviceId?: string
      email?: string
    }
    const tier: 'premium' | 'ultra' | null =
      body.tier === 'ultra' ? 'ultra' : body.tier === 'premium' ? 'premium' : null
    if (!tier) {
      return NextResponse.json({ error: 'tier must be premium or ultra' }, { status: 400 })
    }

    // ── Must be signed in ──
    const session = await readSession(req)
    if (!session?.accountId) {
      return NextResponse.json(
        { error: 'Create an account first to subscribe.', needAccount: true },
        { status: 401 },
      )
    }
    const account = await getAccountById(session.accountId)
    if (!account) {
      return NextResponse.json({ error: 'Account not found.', needAccount: true }, { status: 401 })
    }

    // ── Localised price ──
    let country = 'US'
    try {
      const detected = await detectCountryServer(req.headers)
      if (detected?.code) country = detected.code
    } catch {}
    const price = quoteForCountry(tier as 'premium' | 'ultra', country)

    const stripeKey = process.env.STRIPE_SECRET_KEY || ''

    // ── TEST MODE: no Stripe key configured ──
    if (!stripeKey) {
      const renewsAt = Date.now() + 30 * 24 * 3600 * 1000
      await setAccountTier(session.accountId, {
        tier,
        renewsAt,
        source: 'test',
      })
      if (body.deviceId) {
        await firebasePatch(`devices/${body.deviceId}`, { tier }).catch(() => {})
      }
      console.log(
        `[subscription/checkout] TEST MODE granted ${tier} to ${account.email} (renews ${new Date(renewsAt).toISOString()})`,
      )
      return NextResponse.json({
        ok: true,
        mode: 'test',
        tier,
        renewsAt,
        url: `/?subscribed=1&tier=${tier}`,
        note: 'Test mode — no STRIPE_SECRET_KEY configured. Add Stripe keys to take real payments.',
      })
    }

    // ── LIVE MODE: Stripe Checkout Session (subscription) ──
    const params = new URLSearchParams()
    params.set('mode', 'subscription')
    params.set('client_reference_id', session.accountId)
    params.set('metadata[accountId]', session.accountId)
    params.set('metadata[tier]', tier)
    if (body.deviceId) params.set('metadata[deviceId]', body.deviceId)
    params.set('customer_email', account.email)
    params.set('success_url', `${req.nextUrl.origin}/api/subscription/checkout?returned=1&session_id={CHECKOUT_SESSION_ID}`)
    params.set('cancel_url', `${req.nextUrl.origin}/?checkoutCancelled=1`)
    // Line item: ad-hoc monthly price for the tier in the visitor's currency.
    params.set('line_items[0][quantity]', '1')
    params.set('line_items[0][price_data][currency]', price.currency)
    params.set('line_items[0][price_data][unit_amount]', String(price.amount * 100))
    params.set('line_items[0][price_data][recurring][interval]', 'month')
    params.set(
      'line_items[0][price_data][product_data][name]',
      tier === 'ultra' ? 'NeutralWire Ultra (monthly)' : 'NeutralWire Premium (monthly)',
    )
    params.set(
      'line_items[0][price_data][product_data][description]',
      tier === 'ultra'
        ? 'Custom subtopics, archive search, email digest, gradient themes, API access + article export'
        : 'Custom subtopics, archive search, email digest, gradient themes + personal flags',
    )
    // Subscription data: how we find the account in webhook events.
    params.set('subscription_data[metadata][accountId]', session.accountId)
    params.set('subscription_data[metadata][tier]', tier)

    const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      cache: 'no-store',
    })
    const json = (await res.json()) as { id?: string; url?: string; error?: { message?: string } }
    if (!res.ok || !json.url) {
      console.warn('[subscription/checkout] Stripe error:', json.error?.message)
      return NextResponse.json(
        { error: 'Stripe checkout failed', detail: json.error?.message || res.status },
        { status: 502 },
      )
    }

    return NextResponse.json({ ok: true, mode: 'stripe', tier, url: json.url })
  } catch (err) {
    return NextResponse.json(
      { error: 'Checkout failed', detail: String(err) },
      { status: 500 },
    )
  }
}

/**
 * GET /api/subscription/checkout?returned=1&session_id=cs_live_…
 *
 * The Stripe success_url lands here. We verify the session with Stripe
 * (belt-and-suspenders — the webhook is the source of truth) and redirect
 * home with the celebration param.
 */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('session_id') || ''
  const stripeKey = process.env.STRIPE_SECRET_KEY || ''
  if (!sessionId || !stripeKey) {
    return NextResponse.redirect(`${req.nextUrl.origin}/?subscribed=0`)
  }
  try {
    const res = await fetch(`${STRIPE_API}/checkout/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
      cache: 'no-store',
    })
    const session = (await res.json()) as {
      metadata?: { accountId?: string; tier?: string; deviceId?: string }
      payment_status?: string
    }
    if (res.ok && session.metadata?.accountId && session.metadata?.tier) {
      const tier = session.metadata.tier === 'ultra' ? 'ultra' : 'premium'
      if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
        await setAccountTier(session.metadata.accountId, {
          tier,
          renewsAt: Date.now() + 31 * 24 * 3600 * 1000,
          source: 'stripe',
        })
      }
      return NextResponse.redirect(
        `${req.nextUrl.origin}/?subscribed=1&tier=${tier}`,
      )
    }
  } catch (err) {
    console.warn('[subscription/checkout] return verification failed:', err)
  }
  return NextResponse.redirect(`${req.nextUrl.origin}/?subscribed=0`)
}
