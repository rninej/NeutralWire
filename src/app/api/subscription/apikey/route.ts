import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead } from '@/lib/firebase-server'
import {
  readSession,
  getAccountById,
  issueAndRecordUltraApiKey,
  revokeUltraApiKeys,
} from '@/lib/subscriptions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 30

/**
 * POST /api/subscription/apikey — issue a fresh Ultra API key (or revoke
 * all with { action: 'revoke' }). The raw key is returned ONCE and stored
 * client-side by the Account page; the server keeps only its SHA-256.
 *
 * GET /api/subscription/apikey — status: how many keys exist + the API
 * docs snippet (never the keys themselves).
 */
export async function GET(req: NextRequest) {
  const session = await readSession(req)
  if (!session?.accountId) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  }
  const account = await getAccountById(session.accountId)
  const hashes = await firebaseRead<string[]>(`accounts/${session.accountId}/apiKeyHashes`)
  return NextResponse.json({
    tier: account?.tier || 'free',
    keys: (hashes || []).length,
    docs: {
      endpoint: '/api/v1/feed?topic=top&limit=20',
      auth: 'Authorization: Bearer <key>',
    },
  })
}

export async function POST(req: NextRequest) {
  const session = await readSession(req)
  if (!session?.accountId) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  }
  const account = await getAccountById(session.accountId)
  if (!account || account.tier !== 'ultra') {
    return NextResponse.json(
      { error: 'API access is an Ultra feature.', needUpgrade: true },
      { status: 402 },
    )
  }

  let action = 'issue'
  try {
    const body = (await req.json()) as { action?: string }
    if (body.action === 'revoke') action = 'revoke'
  } catch {}

  if (action === 'revoke') {
    const revoked = await revokeUltraApiKeys(session.accountId)
    return NextResponse.json({ ok: true, revoked })
  }

  const key = await issueAndRecordUltraApiKey(session.accountId)
  if (!key) {
    return NextResponse.json({ error: 'Could not create the key — try again.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, key })
}
