import { NextRequest, NextResponse } from 'next/server'
import {
  upsertSocialAccount,
  createSession,
  setSessionCookie,
} from '@/lib/subscriptions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 15

/**
 * GET /api/auth/google/callback — the OAuth return leg.
 *
 * Exchanges the authorization code for tokens at Google's token endpoint
 * (server-to-server over TLS), then reads the id_token payload to get the
 * verified email + Google subject id. The token arrived directly from
 * Google over TLS (never from the browser), so decoding the payload is
 * safe; we still verify `aud` matches our client id.
 *
 * Then: find-or-create the account, set the session cookie, redirect home
 * (with ?social=google so the UI can celebrate the sign-in).
 */
interface GoogleTokenResponse {
  id_token?: string
  access_token?: string
  error?: string
}

interface IdTokenPayload {
  email?: string
  email_verified?: boolean | string
  sub?: string
  aud?: string
  name?: string
  picture?: string
}

function decodeJwtPayload(jwt: string): IdTokenPayload | null {
  try {
    const parts = jwt.split('.')
    if (parts.length !== 3) return null
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = Buffer.from(b64, 'base64').toString('utf8')
    return JSON.parse(json) as IdTokenPayload
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID || ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || ''
  const code = req.nextUrl.searchParams.get('code') || ''
  const state = req.nextUrl.searchParams.get('state') || ''
  const [deviceId = '', tier = 'premium'] = state.split('|')

  const homeWith = (params: string) =>
    NextResponse.redirect(`${req.nextUrl.origin}/${params}`)

  if (!code || !clientId || !clientSecret) {
    return homeWith('?authError=google')
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${req.nextUrl.origin}/api/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
      cache: 'no-store',
    })
    const tokens = (await tokenRes.json()) as GoogleTokenResponse
    if (!tokens.id_token) {
      console.warn('[auth/google] token exchange failed:', tokens.error)
      return homeWith('?authError=google')
    }

    const payload = decodeJwtPayload(tokens.id_token)
    if (!payload?.email || payload.aud !== clientId) {
      console.warn('[auth/google] bad id_token payload (aud mismatch or no email)')
      return homeWith('?authError=google')
    }

    const { accountId } = await upsertSocialAccount(
      'google',
      payload.email,
      payload.sub || '',
      deviceId || undefined,
    )

    const sessionToken = await createSession(accountId)
    const res = NextResponse.redirect(`${req.nextUrl.origin}/?social=google&tier=${tier}`)
    return setSessionCookie(res, sessionToken)
  } catch (err) {
    console.warn('[auth/google] callback error:', err)
    return homeWith('?authError=google')
  }
}
