import { NextRequest, NextResponse } from 'next/server'
import { getReferralStats } from '@/lib/referral'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Get referral stats for a code.
 *
 * Query: ?code=123456
 * Returns: { totalClicks, successfulReferrals }
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  if (!code) {
    return NextResponse.json({ error: 'Missing code' }, { status: 400 })
  }

  const stats = await getReferralStats(code)
  if (!stats) {
    return NextResponse.json({ error: 'Referral not found' }, { status: 404 })
  }

  return NextResponse.json(stats)
}
