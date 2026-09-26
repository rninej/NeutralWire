import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * GET /api/auth/google?deviceId=…&tier=premium|ultra
 *
 * Starts the Google Sign-In OAuth flow. Enabled when BOTH env vars exist:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 * (Google Cloud Console → Credentials → OAuth client (Web), with
 *  https://neutralwire.org/api/auth/google/callback as an authorized
 *  redirect URI.)
 *
 * The deviceId is carried through the OAuth `state` parameter so the
 * account links back to the visitor's device after the round-trip.
 */
export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID || ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || ''
  const deviceId = req.nextUrl.searchParams.get('deviceId') || ''
  const tier = req.nextUrl.searchParams.get('tier') === 'ultra' ? 'ultra' : 'premium'

  if (!clientId || !clientSecret) {
    return NextResponse.json(
      {
        error: 'Google Sign-In is not configured yet.',
        setup:
          'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars (Google Cloud Console → Credentials → OAuth client ID, redirect URI: /api/auth/google/callback).',
      },
      { status: 503 },
    )
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${req.nextUrl.origin}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    state: `${deviceId}|${tier}`,
  })
  return NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  )
}
