import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { setAccountTier } from '@/lib/subscriptions'
import { firebasePatch } from '@/lib/firebase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 20

/**
 * POST /api/subscription/webhook — Stripe fulfilment.
 *
 * Configure in Stripe → Developers → Webhooks → add endpoint:
 *   https://neutralwire.org/api/subscription/webhook
 * with events: checkout.session.completed, customer.subscription.deleted,
 * customer.subscription.updated, invoice.paid. Then set STRIPE_WEBHOOK_SECRET.
 *
 * Signature verification: Stripe-Signature header `t=<ts>,v1=<hmac>` where
 * hmac = HMAC-SHA256(secret, `${t}.${rawBody}`). Without a configured
 * secret the event is processed with a console warning (so fulfilment
 * still works during setup).
 */
interface StripeEvent {
  id?: string
  type?: string
  data?: {
    object?: {
      metadata?: { accountId?: string; tier?: string; deviceId?: string }
      customer?: string
      subscription?: string
      id?: string
      status?: string
      current_period_end?: number
      client_reference_id?: string
      customer_email?: string
    }
  }
}

function verifyStripeSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false
  const parts = header.split(',').reduce<Record<string, string>>((acc, part) => {
    const [k, v] = part.split('=')
    if (k && v) acc[k.trim()] = v.trim()
    return acc
  }, {})
  const t = parts['t'] || ''
  const v1 = parts['v1'] || ''
  if (!t || !v1) return false
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  try {
    const a = Buffer.from(expected, 'hex')
    const b = Buffer.from(v1, 'hex')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const raw = await req.text()
  const secret = process.env.STRIPE_WEBHOOK_SECRET || ''

  if (secret) {
    const ok = verifyStripeSignature(raw, req.headers.get('stripe-signature'), secret)
    if (!ok) {
      console.warn('[subscription/webhook] signature verification FAILED — rejecting')
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
    }
  } else {
    console.warn(
      '[subscription/webhook] no STRIPE_WEBHOOK_SECRET set — processing unsigned (setup mode)',
    )
  }

  let event: StripeEvent
  try {
    event = JSON.parse(raw) as StripeEvent
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const obj = event.data?.object || {}
  const accountId = obj.metadata?.accountId || obj.client_reference_id || ''
  const tier = obj.metadata?.tier === 'ultra' ? 'ultra' : 'premium'

  switch (event.type) {
    case 'checkout.session.completed': {
      if (accountId) {
        await setAccountTier(accountId, {
          tier,
          renewsAt: Date.now() + 31 * 24 * 3600 * 1000,
          source: 'stripe',
          stripeCustomerId: obj.customer,
          stripeSubscriptionId: obj.subscription,
        })
        if (obj.metadata?.deviceId) {
          await firebasePatch(`devices/${obj.metadata.deviceId}`, { tier }).catch(() => {})
        }
        console.log(`[subscription/webhook] GRANTED ${tier} → account ${accountId}`)
      }
      break
    }
    case 'invoice.paid': {
      // Renewal: push the renewal horizon forward.
      if (accountId) {
        const periodEnd = obj.current_period_end
          ? obj.current_period_end * 1000
          : Date.now() + 31 * 24 * 3600 * 1000
        await setAccountTier(accountId, {
          tier,
          renewsAt: periodEnd,
          source: 'stripe',
        })
      }
      break
    }
    case 'customer.subscription.updated': {
      if (accountId) {
        if (obj.status === 'active' || obj.status === 'trialing') {
          const periodEnd = obj.current_period_end ? obj.current_period_end * 1000 : undefined
          await setAccountTier(accountId, {
            tier,
            renewsAt: periodEnd ?? Date.now() + 31 * 24 * 3600 * 1000,
            source: 'stripe',
          })
        } else if (obj.status === 'canceled' || obj.status === 'unpaid' || obj.status === 'incomplete_expired') {
          await setAccountTier(accountId, { tier: 'free', renewsAt: null, source: 'stripe' })
          console.log(`[subscription/webhook] REVOKED → account ${accountId} (${obj.status})`)
        }
      }
      break
    }
    case 'customer.subscription.deleted': {
      if (accountId) {
        await setAccountTier(accountId, { tier: 'free', renewsAt: null, source: 'stripe' })
        console.log(`[subscription/webhook] REVOKED (deleted) → account ${accountId}`)
      }
      break
    }
    default:
      // Unhandled event type — acknowledge so Stripe stops retrying.
      break
  }

  return NextResponse.json({ received: true })
}
