import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead, firebasePatch } from '@/lib/firebase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Get or set notification preferences for a device.
 *
 * GET  /api/notifications?deviceId=<id>
 *   → { enabled, frequency }
 *
 * POST /api/notifications
 *   body: { deviceId, enabled?, frequency? }
 *     frequency: 'daily3' (3 per day) | 'all' (every new story)
 *   → { ok: true }
 */
export async function GET(req: NextRequest) {
  const deviceId = req.nextUrl.searchParams.get('deviceId')
  if (!deviceId) {
    return NextResponse.json({ error: 'Missing deviceId' }, { status: 400 })
  }
  const device = await firebaseRead<{
    notificationsEnabled?: boolean
    notificationFrequency?: string
  }>(`devices/${deviceId}`)
  return NextResponse.json({
    enabled: device?.notificationsEnabled || false,
    frequency: device?.notificationFrequency || 'daily3',
  })
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      deviceId: string
      enabled?: boolean
      frequency?: 'daily3' | 'all'
    }
    if (!body.deviceId) {
      return NextResponse.json({ error: 'Missing deviceId' }, { status: 400 })
    }

    const patch: Record<string, unknown> = {}
    if (typeof body.enabled === 'boolean') patch.notificationsEnabled = body.enabled
    if (body.frequency) patch.notificationFrequency = body.frequency

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    await firebasePatch(`devices/${body.deviceId}`, patch)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to update notifications', detail: String(err) },
      { status: 500 },
    )
  }
}
