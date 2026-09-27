import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import {
  readSession,
  getAccountById,
  newKofiClaimCode,
  KOFI_PAGE_URL,
} from '@/lib/subscriptions'
import { firebaseWrite } from '@/lib/firebase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 20

/**
 * POST /api/subscription/checkout — start a Ko-fi subscription.
 *
 * Body: { tier: 'premium' | 'ultra', deviceId? }
 *
 * Ko-fi has no server-side checkout API — the supporter pays on
 * ko-fi.com/neutralwire/tiers (the membership tier picker; tiers named
 * "Premium" and "Ultra"), and the
 * webhook (POST /api/kofi/webhook) fulfils the grant the moment the payment
 * lands. This endpoint hands the client everything the pay-panel needs:
 *
 *   { mode: 'kofi', tier, code: 'NW-XXXXXX', url: 'https://ko-fi.com/…',
 *     email: 'the account email' }
 *
 * • `email` — the account email, shown by the pay-panel as the EASIEST
 *   path: pay on Ko-fi with that email and the webhook auto-matches it —
 *   nothing to copy or paste.
 * • `code` — a one-shot claim code bound to the signed-in account (48h
 *   validity), the fallback for supporters paying with a DIFFERENT email
 *   (paste it into the Ko-fi message; the webhook matches it and grants
 *   instantly). The "I already paid" claim (/api/kofi/claim) sweeps the
 *   rest.
 * • An ACCOUNT is required (grants attach to accounts, not devices) —
 *   logged-out callers get 401 { needAccount: true }.
 */
const CLAIM_TTL_MS = 48 * 60 * 60 * 1000

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { tier?: string; deviceId?: string }
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

    // ── Issue the claim code ──
    const code = newKofiClaimCode()
    await firebaseWrite(`kofiClaims/${code}`, {
      accountId: session.accountId,
      email: account.email,
      tier,
      createdAt: Date.now(),
      expiresAt: Date.now() + CLAIM_TTL_MS,
    })

    return NextResponse.json({
      ok: true,
      mode: 'kofi',
      tier,
      code,
      url: KOFI_PAGE_URL,
      email: account.email,
      expiresInMs: CLAIM_TTL_MS,
      note: 'Pick the tier on Ko-fi and pay with your account email — it unlocks automatically. Paid with a different email? Paste the code into the Ko-fi message.',
    })
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
 * LEGACY Stripe success-return handler — kept so any old checkout links
 * still resolve; new payments go through Ko-fi's webhook instead.
 */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('session_id') || ''
  const stripeKey = process.env.STRIPE_SECRET_KEY || ''
  if (!sessionId || !stripeKey) {
    return NextResponse.redirect(`${req.nextUrl.origin}/subscribe`)
  }
  try {
    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
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
        const { setAccountTier } = await import('@/lib/subscriptions')
        await setAccountTier(session.metadata.accountId, {
          tier,
          renewsAt: Date.now() + 31 * 24 * 3600 * 1000,
          source: 'stripe',
        })
      }
      return NextResponse.redirect(`${req.nextUrl.origin}/?subscribed=1&tier=${tier}`)
    }
  } catch (err) {
    console.warn('[subscription/checkout] return verification failed:', err)
  }
  return NextResponse.redirect(`${req.nextUrl.origin}/subscribe`)
}

// `after` imported for route-segment consistency with the news routes.
void after
