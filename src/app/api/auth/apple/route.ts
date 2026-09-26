import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * GET /api/auth/apple?deviceId=…&tier=…
 *
 * Sign in with Apple. Requires the Apple developer setup:
 *   APPLE_CLIENT_ID      (Services ID)
 *   APPLE_TEAM_ID
 *   APPLE_KEY_ID
 *   APPLE_PRIVATE_KEY    (the .p8 contents, escaped)
 * plus a Return URL of https://neutralwire.org/api/auth/apple/callback
 * configured on the Services ID.
 *
 * Until those exist this endpoint answers 503 with setup instructions and
 * the UI shows the button in its "needs setup" state.
 */
export async function GET(req: NextRequest) {
  const configured = Boolean(
    process.env.APPLE_CLIENT_ID &&
      process.env.APPLE_TEAM_ID &&
      process.env.APPLE_KEY_ID &&
      process.env.APPLE_PRIVATE_KEY,
  )
  if (!configured) {
    return NextResponse.json(
      {
        error: 'Sign in with Apple is not configured yet.',
        setup:
          'Set APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY env vars (Apple Developer → Certificates, IDs & Profiles → Services ID, Return URL: /api/auth/apple/callback).',
      },
      { status: 503 },
    )
  }

  // Configured path: Apple expects a signed client-secret JWT (ES256) and
  // a form_post response mode. Redirect to Apple's auth page.
  const params = new URLSearchParams({
    client_id: process.env.APPLE_CLIENT_ID!,
    redirect_uri: `${req.nextUrl.origin}/api/auth/apple/callback`,
    response_type: 'code id_token',
    scope: 'name email',
    response_mode: 'form_post',
    state: req.nextUrl.searchParams.get('deviceId') || '',
  })
  return NextResponse.redirect(
    `https://appleid.apple.com/auth/authorize?${params.toString()}`,
  )
}
