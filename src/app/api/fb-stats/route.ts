import { NextResponse } from 'next/server'
import { getFirebaseStats } from '@/lib/firebase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Firebase download stats endpoint.
 *
 * Returns the total bytes downloaded from Firebase in the current server
 * instance (warm function), plus the last 10 operations with their paths
 * and sizes. The client polls this every 5 seconds and logs to the console.
 *
 * Note: Vercel serverless functions don't share memory between invocations,
 * so this tracks per-instance usage. The client also accumulates a
 * per-session total across multiple API calls.
 */
export async function GET() {
  const stats = getFirebaseStats()
  return NextResponse.json(stats)
}
