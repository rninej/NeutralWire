/**
 * user-cron.ts — experimental: the site's visitors run the cron schedule.
 *
 * Instead of (or as a backstop to) an external cron service hitting the
 * server on a fixed clock, the OLDEST live visitor (deterministic
 * election over the meshCron presence room) checks job staleness every
 * minute and — only when a job is actually due — triggers it. Costs:
 *  - One tiny Firebase read (meshJobs/lastRun, ~60 bytes) per minute,
 *    paid by a single browser. No Vercel invocations for the check.
 *  - The job's invocation itself happens only when users are online
 *    (which is exactly when refreshes/notifications have value) —
 *    the 3 a.m. no-visitor invocations disappear entirely.
 *
 * Jobs:
 *  - refresh  → /api/cron/refresh-all (RSS/GDELT cache refresh), 30 min
 *  - notify   → /api/push/trigger-tz  (timezone-aware briefings), 20 min
 *
 * AUTH: the endpoints accept a ONE-TIME LEASE instead of the admin
 * secret: the browser writes meshJobs/leases/<id> = { p, ts: <SERVER
 * timestamp sentinel> } — Firebase itself stamps the time, so clients
 * cannot forge freshness — and the route validates + consumes it. Both
 * routes additionally enforce their own minimum-interval floors in
 * Firebase + in-memory, so even a forged-lease spammer cannot force
 * back-to-back heavy runs (the underlying aggregation is itself deduped
 * and rate-limited per category).
 */

import { MESH_PATHS } from '@/lib/mesh/mesh-protocol'
import { RoomPresence, type PresenceSnapshot } from '@/lib/mesh/mesh-presence'
import { logMeshEvent } from '@/lib/mesh/mesh-log'
import { rtdbGet, rtdbPut, serverTimestamp } from '@/lib/mesh/rtdb-rest'

const REFRESH_INTERVAL_MS = 30 * 60 * 1000
const NOTIFY_INTERVAL_MS = 20 * 60 * 1000
const TICK_MS = 60 * 1000

type CronJob = 'refresh' | 'notify'

interface CronRuntime {
  started: boolean
  presence: RoomPresence | null
  tickTimer: ReturnType<typeof setInterval> | null
  iAmLeader: boolean
  lastTriggered: Record<CronJob, number>
  inFlight: Set<CronJob>
}

const runtime: CronRuntime = {
  started: false,
  presence: null,
  tickTimer: null,
  iAmLeader: false,
  lastTriggered: { refresh: 0, notify: 0 },
  inFlight: new Set(),
}

async function createLease(job: CronJob, peerId: string): Promise<string | null> {
  const leaseId = `${job}_${globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 12) ?? Math.random().toString(36).slice(2, 12)}`
  const ok = await rtdbPut(MESH_PATHS.lease(leaseId), { p: peerId, job, ts: serverTimestamp() })
  return ok ? leaseId : null
}

async function triggerJob(job: CronJob, endpoint: string): Promise<void> {
  if (!runtime.presence) return
  const peerId = runtime.presence.myPeerId
  const leaseId = await createLease(job, peerId)
  if (!leaseId) {
    logMeshEvent({ type: 'cron-skip', room: 'cron', detail: `${job}: lease write failed` })
    return
  }
  const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}lease=${encodeURIComponent(leaseId)}&peer=${encodeURIComponent(peerId)}`
  try {
    const res = await fetch(url, { cache: 'no-store' })
    const ok = res.ok
    logMeshEvent({
      type: 'cron-trigger',
      room: 'cron',
      detail: `${job}: HTTP ${res.status}${ok ? '' : ' (server will enforce interval)'}`,
    })
  } catch {
    logMeshEvent({ type: 'cron-skip', room: 'cron', detail: `${job}: fetch failed` })
  }
}

async function tick(): Promise<void> {
  if (!runtime.started || !runtime.iAmLeader) return
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  const now = Date.now()
  // One tiny read — both jobs' last-run timestamps.
  const lastRun = await rtdbGet<Record<string, number>>(MESH_PATHS.jobs + '/lastRun')
  const refreshAt = typeof lastRun?.refresh === 'number' ? lastRun.refresh : 0
  const notifyAt = typeof lastRun?.notify === 'number' ? lastRun.notify : 0

  if (
    now - refreshAt > REFRESH_INTERVAL_MS &&
    now - runtime.lastTriggered.refresh > REFRESH_INTERVAL_MS &&
    !runtime.inFlight.has('refresh')
  ) {
    runtime.inFlight.add('refresh')
    runtime.lastTriggered.refresh = now
    await triggerJob('refresh', '/api/cron/refresh-all')
    setTimeout(() => runtime.inFlight.delete('refresh'), 60_000)
  }

  if (
    now - notifyAt > NOTIFY_INTERVAL_MS &&
    now - runtime.lastTriggered.notify > NOTIFY_INTERVAL_MS &&
    !runtime.inFlight.has('notify')
  ) {
    runtime.inFlight.add('notify')
    runtime.lastTriggered.notify = now
    await triggerJob('notify', '/api/push/trigger-tz')
    setTimeout(() => runtime.inFlight.delete('notify'), 60_000)
  }
}

export function startUserCron(): void {
  if (runtime.started || typeof window === 'undefined') return
  runtime.started = true
  const presence = new RoomPresence('cron', 'cron')
  runtime.presence = presence
  void presence.join()
  presence.onSnapshot((snap: PresenceSnapshot) => {
    const wasLeader = runtime.iAmLeader
    runtime.iAmLeader = snap.iAmRelay
    if (runtime.iAmLeader && !wasLeader) {
      logMeshEvent({ type: 'promote', room: 'cron', detail: 'this browser now runs the cron schedule' })
      void tick()
    }
  })
  runtime.tickTimer = setInterval(() => void tick(), TICK_MS)
}

export function stopUserCron(): void {
  if (!runtime.started) return
  runtime.started = false
  if (runtime.tickTimer) clearInterval(runtime.tickTimer)
  runtime.tickTimer = null
  runtime.presence?.leave()
  runtime.presence = null
  runtime.iAmLeader = false
}

/** Introspection for /debug. */
export function userCronStatus(): { started: boolean; leader: boolean; peerId: string | null } {
  return {
    started: runtime.started,
    leader: runtime.iAmLeader,
    peerId: runtime.presence?.myPeerId ?? null,
  }
}
