import { NextRequest, NextResponse } from 'next/server'
import { generateGuestCodeSmart, generateAlphanumericCode } from '@/lib/referral'
import { firebaseRead, firebaseWrite, firebasePatch } from '@/lib/firebase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Create or retrieve a referral code for a device.
 *
 * Body: { deviceId: string, existingCode?: string }
 *
 * Logic:
 *   1. If existingCode is provided AND it exists in Firebase AND it belongs
 *      to this device → return it (no new code created).
 *   2. Otherwise → generate a new unique code, store it, return it.
 *
 * The client caches the code in localStorage so it doesn't call this
 * endpoint unnecessarily, but even if it does, the server verifies
 * ownership before returning.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      deviceId: string
      existingCode?: string
    }

    if (!body.deviceId) {
      return NextResponse.json({ error: 'Missing deviceId' }, { status: 400 })
    }

    // If the client sent an existing code, verify it belongs to this device.
    if (body.existingCode) {
      const existing = await firebaseRead<{
        creatorDeviceId: string
      }>(`referrals/${body.existingCode}`)

      if (existing && existing.creatorDeviceId === body.deviceId) {
        // This code is valid and belongs to this device — return it.
        return NextResponse.json({
          code: body.existingCode,
          url: `${req.nextUrl.origin}/?ref=${body.existingCode}`,
        })
      }
    }

    // No valid existing code — create a new one.
    //
    // Code-space management: the numeric 6-digit space holds 900,000 codes;
    // once counters/guestCodes crosses the overflow threshold every NEW
    // code is alphanumeric (see referral.ts). If the numeric space is
    // somehow still saturated (collision retries exhausted) we ALSO fall
    // back to alphanumeric here — the code can never fail to be unique.
    let code = await generateGuestCodeSmart()
    let attempts = 0
    let collision = await firebaseRead(`referrals/${code}`)
    while (collision && attempts < 10) {
      code = await generateGuestCodeSmart()
      collision = await firebaseRead(`referrals/${code}`)
      attempts++
    }
    // Final fallback: alphanumeric (billions of combinations).
    if (collision) {
      do {
        code = generateAlphanumericCode()
        collision = await firebaseRead(`referrals/${code}`)
      } while (collision)
    }

    await firebaseWrite(`referrals/${code}`, {
      creatorDeviceId: body.deviceId,
      createdAt: Date.now(),
      totalClicks: 0,
      successfulReferrals: 0,
    })

    // Track total codes issued (drives the numeric→alphanumeric overflow).
    const issued = (await firebaseRead<number>('counters/guestCodes')) || 0
    await firebasePatch('counters', { guestCodes: issued + 1 }).catch(() => {})

    return NextResponse.json({
      code,
      url: `${req.nextUrl.origin}/?ref=${code}`,
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to create referral', detail: String(err) },
      { status: 500 },
    )
  }
}
