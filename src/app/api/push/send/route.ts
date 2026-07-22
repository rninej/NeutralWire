import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * This endpoint is DISABLED.
 *
 * Notifications are now sent via cron-job.org which calls
 * /api/push/trigger?slot=morning|lunch|evening at the correct times.
 *
 * The old Vercel Cron (8:00 UTC daily) sent 3 notifications in a burst
 * at 9am UK time, which was not what the user wanted. It has been removed
 * from vercel.json and this endpoint is now a no-op.
 *
 * To manually trigger notifications, use:
 *   /api/push/trigger?slot=morning&secret=neutralwire-trigger
 *   /api/push/trigger?slot=lunch&secret=neutralwire-trigger
 *   /api/push/trigger?slot=evening&secret=neutralwire-trigger
 */
export async function GET() {
  return NextResponse.json({
    disabled: true,
    message: 'Use /api/push/trigger?slot=morning|lunch|evening instead',
  })
}
