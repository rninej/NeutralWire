import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead, firebaseWrite, firebasePatch } from '@/lib/firebase-server'
import {
  kofiVerificationToken,
  kofiTierForEvent,
  resolveKofiAccountId,
  applyKofiPayment,
} from '@/lib/subscriptions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 20

/**
 * POST /api/kofi/webhook — Ko-fi payment fulfilment (the LIVE checkout
 * provider).
 *
 * Ko-fi dashboard → API → Webhook URL:
 *   https://neutralwire.org/api/kofi/webhook
 *
 * Payload: application/x-www-form-urlencoded with a single `data` field
 * containing the payment as a JSON string. Every request carries
 * `verification_token` — requests whose token doesn't match ours are
 * rejected with 401. A 200 response confirms receipt; anything else makes
 * Ko-fi retry the same message_id, so this handler is IDEMPOTENT: each
 * message_id is stored once at kofiEvents/<message_id> and repeats answer
 * 200 immediately without re-granting.
 *
 * MATCHING a payment to a NeutralWire account (Ko-fi cannot pass custom
 * checkout parameters, so we triangulate):
 *   1. The supporter pasted their claim code (NW-XXXXXX, shown at
 *      checkout) into the Ko-fi message → kofiClaims/<code>.
 *   2. The Ko-fi account email exactly matches a NeutralWire account email.
 *   3. The email matches an account linked by an earlier payment
 *      (kofiEmailIndex) — this is how RENEWALS auto-extend.
 *   4. No match → the event is stored unclaimed; the in-app "I already
 *      paid" claim (/api/kofi/claim) picks it up by email later.
 *
 * Subscriptions: is_first_subscription_payment grants for 31 days; each
 * later monthly payment EXTENDS the horizon. Tier comes from tier_name
 * ("Ultra"/"Premium" memberships on Ko-fi) with an amount fallback.
 * One-off tips never change the tier — they're logged as support.
 */
export async function POST(req: NextRequest) {
  // ── Parse (form-encoded `data` JSON, or a raw JSON body for testing) ──
  let data: Record<string, unknown>
  try {
    const raw = await req.text()
    if (raw.trim().startsWith('{')) {
      data = JSON.parse(raw) as Record<string, unknown>
    } else {
      const form = new URLSearchParams(raw)
      const dataField = form.get('data')
      if (!dataField) throw new Error('no data field')
      data = JSON.parse(dataField) as Record<string, unknown>
    }
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  // ── Token verification (Ko-fi's own authenticity check) ──
  const token = String(data.verification_token || '')
  if (!token || token !== kofiVerificationToken()) {
    console.warn('[kofi/webhook] verification token mismatch — rejecting')
    return NextResponse.json({ error: 'Invalid verification token' }, { status: 401 })
  }

  const messageId = String(data.message_id || '')
  if (!messageId) {
    return NextResponse.json({ error: 'Missing message_id' }, { status: 400 })
  }

  // ── Idempotency: the same message_id must never grant twice ──
  const existing = await firebaseRead<{ accountId?: string | null }>(`kofiEvents/${messageId}`)
  if (existing) {
    return NextResponse.json({ received: true, duplicate: true })
  }

  const email = String(data.email || '').trim().toLowerCase()
  const message = String(data.message || '')
  const tier = kofiTierForEvent({
    type: String(data.type || ''),
    tier_name: (data.tier_name as string | null) ?? null,
    amount: data.amount as string | number,
    is_subscription_payment:
      data.is_subscription_payment === true || data.is_subscription_payment === 'true',
  })
  const renewal =
    (data.is_subscription_payment === true || data.is_subscription_payment === 'true') &&
    data.is_first_subscription_payment !== true &&
    data.is_first_subscription_payment !== 'true'

  // ── Match + grant ──
  let grantedAccountId: string | null = null
  let grantedTier: 'premium' | 'ultra' | null = null
  if (tier) {
    const match = await resolveKofiAccountId(message, email)
    if (match) {
      const ok = await applyKofiPayment(match.accountId, tier, {
        renewal,
        kofiEmail: email || undefined,
        code: match.via === 'code' ? match.code : undefined,
      })
      if (ok) {
        grantedAccountId = match.accountId
        grantedTier = tier
        console.log(
          `[kofi/webhook] GRANTED ${tier} (${renewal ? 'renewal' : 'new'}) → account ${match.accountId} via ${match.via}`,
        )
      }
    } else {
      console.log(
        `[kofi/webhook] ${tier} payment stored UNCLAIMED (no code/email match) — message_id ${messageId}`,
      )
    }
  }

  // ── Store the event (claimed or not) ──
  await firebaseWrite(`kofiEvents/${messageId}`, {
    at: Date.now(),
    timestamp: String(data.timestamp || ''),
    type: String(data.type || ''),
    amount: String(data.amount || ''),
    currency: String(data.currency || ''),
    email,
    fromName: String(data.from_name || ''),
    message,
    tierName: data.tier_name ? String(data.tier_name) : null,
    isSubscriptionPayment:
      data.is_subscription_payment === true || data.is_subscription_payment === 'true',
    isFirstSubscriptionPayment:
      data.is_first_subscription_payment === true || data.is_first_subscription_payment === 'true',
    kofiTransactionId: String(data.kofi_transaction_id || messageId),
    tier: grantedTier || tier,
    accountId: grantedAccountId,
    claimed: grantedAccountId !== null,
  }).catch(() => {})

  // Always 200 once verified — stops Ko-fi's retries for events we fully
  // absorbed (unclaimed ones are claimed later via /api/kofi/claim).
  return NextResponse.json({ received: true, granted: grantedTier })
}

/** GET — tiny explainer so hitting the URL in a browser isn't a 405. */
export async function GET() {
  return NextResponse.json({
    endpoint: 'Ko-fi webhook',
    method: 'POST (application/x-www-form-urlencoded, data=<json>)',
    status: 'listening',
  })
}
