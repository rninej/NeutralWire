import { NextRequest, NextResponse } from 'next/server'
import {
  registerEmailAccount,
  createSession,
  setSessionCookie,
} from '@/lib/subscriptions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * POST /api/auth/register — create an email+password account.
 *
 * Body: { email, password, deviceId?, timezone? }
 * Sets the `nw_session` cookie (90 days) and links the current device.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      email?: string
      password?: string
      deviceId?: string
      timezone?: string
    }
    if (!body.email || !body.password) {
      return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 })
    }

    const result = await registerEmailAccount(
      body.email,
      body.password,
      body.deviceId,
      body.timezone,
    )
    if (!result.ok || !result.accountId) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    const token = await createSession(result.accountId)
    const res = NextResponse.json({
      ok: true,
      account: { email: result.account?.email, tier: 'free' },
    })
    return setSessionCookie(res, token)
  } catch (err) {
    return NextResponse.json(
      { error: 'Registration failed', detail: String(err) },
      { status: 500 },
    )
  }
}
