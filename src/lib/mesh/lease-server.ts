/**
 * lease-server.ts — one-time lease validation for the user-powered cron
 * (experimental: visitors trigger refresh/notify jobs).
 *
 * Flow (see src/lib/mesh/user-cron.ts for the client half):
 *   1. A browser writes meshJobs/leases/<id> = { p: <peerId>, ts: <SERVER
 *      timestamp sentinel> } — Firebase itself stamps `ts`, so a client
 *      cannot forge freshness.
 *   2. The browser calls the cron route with ?lease=<id>&peer=<peerId>.
 *   3. THIS module validates: lease exists, peer matches, age ≤ 45s —
 *      then DELETES it (single use).
 *   4. The route additionally enforces a per-job minimum-interval floor
 *      (Firebase lastRun + an in-memory per-instance floor), so even a
 *      lease-spamming client cannot force back-to-back heavy runs; the
 *      underlying work (cache refresh / push send) is itself deduped.
 *
 * The admin-secret path (external cron service) bypasses leases but NOT
 * the interval floors for lease-triggered runs — the external schedule
 * keeps working exactly as before.
 */

import { firebaseDelete, firebaseRead, firebaseWrite } from '@/lib/firebase-server'

const LEASE_MAX_AGE_MS = 45 * 1000

// Per-instance floors — survive forged meshJobs/lastRun writes (a client
// COULD overwrite that node on the public database; the in-memory floor
// bounds abuse on every warm instance regardless).
const LAST_ACCEPTED_RUN = new Map<string, number>()

export async function consumeLease(
  leaseId: string,
  peer: string,
  job: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!leaseId || !peer) return { ok: false, reason: 'missing params' }
  const path = `meshJobs/leases/${leaseId}`
  const entry = await firebaseRead<{ p?: string; ts?: number; job?: string }>(path)
  if (!entry || typeof entry.ts !== 'number') {
    return { ok: false, reason: 'lease not found' }
  }
  // Single use — delete FIRST so a replay race can't double-consume.
  await firebaseDelete(path)
  if (entry.p !== peer) return { ok: false, reason: 'peer mismatch' }
  if (entry.job && entry.job !== job) return { ok: false, reason: 'job mismatch' }
  const age = Date.now() - entry.ts
  if (age < -10_000 || age > LEASE_MAX_AGE_MS) {
    return { ok: false, reason: `lease age ${age}ms out of window` }
  }
  return { ok: true }
}

/**
 * Interval floor for a job. Returns true when the job ran "recently
 * enough" that a lease-triggered run should be SKIPPED. Checks both the
 * Firebase lastRun node and the in-memory per-instance floor.
 */
export async function jobRecentlyRan(
  job: string,
  minIntervalMs: number,
): Promise<boolean> {
  const now = Date.now()
  const mem = LAST_ACCEPTED_RUN.get(job) ?? 0
  if (now - mem < minIntervalMs) return true
  const stored = await firebaseRead<number>(`meshJobs/lastRun/${job}`)
  if (typeof stored === 'number' && now - stored < minIntervalMs) return true
  return false
}

/** Record that a job just ran (both stores). */
export async function markJobRun(job: string): Promise<void> {
  const now = Date.now()
  LAST_ACCEPTED_RUN.set(job, now)
  await firebaseWrite(`meshJobs/lastRun/${job}`, now)
}

// ── Job constants (client interval > server floor > underlying dedup) ──
export const CRON_JOB_INTERVALS = {
  /** RSS/GDELT cache refresh — visitors check every 30 min. */
  refresh: {
    clientIntervalMs: 30 * 60 * 1000,
    serverFloorMs: 25 * 60 * 1000,
  },
  /** Timezone-aware briefings — visitors check every 20 min (the ±15
   *  minute send windows always catch at least one trigger). */
  notify: {
    clientIntervalMs: 20 * 60 * 1000,
    serverFloorMs: 14 * 60 * 1000,
  },
} as const
