import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 1

/**
 * ── DEPRECATED — returns 410 Gone immediately ──
 *
 * This was the OLD notification trigger endpoint (930 lines, used AI
 * personalization via pushify.ts). It has been SUPERSEDED by
 * /api/push/trigger-tz which is timezone-aware and runs synchronously
 * (this one used `after()` which Vercel Hobby kills).
 *
 * If cron-job.org is still hitting this URL, it gets a 410 in <1ms
 * with ZERO CPU cost (no Firebase reads, no AI calls, no push sends).
 * This saves the ~5-15s of CPU per invocation that the old route
 * was burning even when it "failed" silently.
 *
 * Action required: update the cron-job.org schedule to point to
 * /api/push/trigger-tz instead. Once that's done, this route does
 * nothing (but is kept here so the old URL doesn't 500).
 */
export async function GET() {
  return NextResponse.json(
    {
      error: 'Gone',
      message: 'This endpoint is deprecated. Use /api/push/trigger-tz instead.',
      migration: 'Update cron-job.org to hit /api/push/trigger-tz?secret=nw-tz-trigger-9f3a7c2e1b8d4f6a',
    },
    { status: 410 },
  )
}

export async function POST() {
  return NextResponse.json(
    {
      error: 'Gone',
      message: 'This endpoint is deprecated. Use /api/push/trigger-tz instead.',
    },
    { status: 410 },
  )
}
