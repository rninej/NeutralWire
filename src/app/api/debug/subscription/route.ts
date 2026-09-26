import { NextRequest, NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'crypto'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import { adminSetTier, resolveGrantTarget, type Tier } from '@/lib/subscriptions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 30

/**
 * /api/debug/subscription — the /debug Subscription Manager (password
 * gated, same admin password as /api/flags).
 *
 * POST body: { password, identifier, tier } | { password, action: 'lookup', identifier }
 *   identifier — a guest code (6-digit or alphanumeric), a device id
 *                (d_…) or an account email.
 *   tier       — 'free' | 'premium' | 'ultra' (free = REMOVE).
 *
 * GET ?password=…&identifier=… — resolve + show what a grant would hit
 * (never changes anything).
 */
const PASSWORD_HASH = '5c2113db1bd51e6e6fce4205d8eb36e41f5018d5d32d4c04b294fb02192f474a'

function verifyPassword(input: string): boolean {
  const inputHash = createHash('sha256').update(input).digest('hex')
  try {
    return timingSafeEqual(Buffer.from(inputHash), Buffer.from(PASSWORD_HASH))
  } catch {
    return false
  }
}

interface LookupInfo {
  kind: string
  label: string
  currentTier?: string
  email?: string | null
  deviceId?: string
  accountId?: string
}

async function describeTarget(identifier: string): Promise<LookupInfo> {
  const target = await resolveGrantTarget(identifier)
  let currentTier: string | undefined
  let email: string | null = null
  if (target.kind === 'device' && target.deviceId) {
    currentTier = (await firebaseRead<string>(`devices/${target.deviceId}/tier`)) || 'free'
    const acc = await firebaseRead<{ accountId?: string }>(`devices/${target.deviceId}`)
    if (acc?.accountId) {
      const a = await firebaseRead<{ email?: string; tier?: string }>(`accounts/${acc.accountId}`)
      email = a?.email || null
      currentTier = a?.tier || currentTier
    }
  }
  if (target.kind === 'account' && target.accountId) {
    const a = await firebaseRead<{ email?: string; tier?: string }>(`accounts/${target.accountId}`)
    currentTier = a?.tier || 'free'
    email = a?.email || null
  }
  return {
    kind: target.kind,
    label: target.label,
    currentTier,
    email,
    deviceId: target.deviceId,
    accountId: target.accountId,
  }
}

async function handle(identifier: string, tier: Tier): Promise<{
  ok: boolean
  error?: string
  target?: LookupInfo
  tier?: Tier
}> {
  const info = await describeTarget(identifier)
  if (info.kind === 'unknown') {
    return {
      ok: false,
      error:
        'No match. Paste their guest code (the 6-digit one in their Account page), a device id (d_…) or an account email.',
    }
  }
  const result = await adminSetTier(identifier, tier)
  // Re-read for the response.
  const after = await describeTarget(identifier)
  return {
    ok: result.ok,
    target: { ...after, currentTier: after.currentTier || 'free' },
    tier,
  }
}

export async function GET(req: NextRequest) {
  const password = req.nextUrl.searchParams.get('password') || ''
  const identifier = req.nextUrl.searchParams.get('identifier') || ''
  if (!verifyPassword(password)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!identifier) {
    return NextResponse.json({ error: 'Provide ?identifier=…' }, { status: 400 })
  }
  const info = await describeTarget(identifier)
  return NextResponse.json({ ok: true, lookup: info })
}

export async function POST(req: NextRequest) {
  let body: { password?: string; identifier?: string; tier?: string; action?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!body.password || !verifyPassword(body.password)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!body.identifier) {
    return NextResponse.json({ error: 'Provide an identifier (guest code / device id / email).' }, { status: 400 })
  }

  // Lookup-only mode.
  if (body.action === 'lookup') {
    const info = await describeTarget(body.identifier)
    return NextResponse.json({ ok: true, lookup: info })
  }

  const tier: Tier =
    body.tier === 'premium' ? 'premium' : body.tier === 'ultra' ? 'ultra' : body.tier === 'free' ? 'free' : 'premium'
  const result = await handle(body.identifier, tier)
  if (!result.ok && result.error) {
    return NextResponse.json(result, { status: 400 })
  }
  // Audit log (append-only).
  await firebaseWrite(`subscriptionsLog/${Date.now()}`, {
    at: Date.now(),
    who: result.target?.label || body.identifier,
    tier,
    via: 'debug',
  }).catch(() => {})

  return NextResponse.json(result)
}
