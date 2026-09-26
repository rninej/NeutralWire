import { NextRequest, NextResponse } from 'next/server'
import {
  getRequesterTier,
  entitlementsFor,
  quoteForCountry,
} from '@/lib/subscriptions'
import { detectCountryServer } from '@/lib/country-detect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * GET /api/subscription/me[?deviceId=…]
 *
 * Everything the client needs to gate premium UI:
 *   { model, tier, account: {email}|null, renewsAt, entitlements, pricing }
 *
 * The client ALSO passes ?deviceId= so logged-out visitors with a
 * /debug-granted guest premium resolve correctly.
 */
export async function GET(req: NextRequest) {
  const requester = await getRequesterTier(req)
  const entitlements = entitlementsFor(requester.tier, requester.model)

  let country = 'US'
  try {
    const detected = await detectCountryServer(req.headers)
    if (detected?.code) country = detected.code
  } catch {}

  return NextResponse.json(
    {
      model: requester.model,
      tier: requester.tier,
      account: requester.email ? { email: requester.email } : null,
      loggedIn: requester.accountId !== null,
      renewsAt: requester.renewsAt,
      via: requester.via,
      entitlements,
      pricing: {
        premium: quoteForCountry('premium', country),
        ultra: quoteForCountry('ultra', country),
        country,
      },
      payments: {
        provider: process.env.STRIPE_SECRET_KEY ? 'stripe' : 'test',
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
