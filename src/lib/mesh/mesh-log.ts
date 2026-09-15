/**
 * mesh-log.ts — observability for the mesh (the "keep all bugs and
 * unwanted switches as a record in /debug" requirement).
 *
 * Two layers:
 *  1. LOCAL ring buffer + counters (localStorage) — every event, shown
 *     live in /debug's Mesh Monitor for THIS browser.
 *  2. FIREBASE /meshLogs — the operational events worth a cross-user
 *     record (fallbacks, verification failures, malformed payloads,
 *     relay switches, cron triggers…), trimmed to the last 250 entries
 *     so the node never grows unbounded. Server timestamps make entries
 *     unforgeable-in-time ({'.sv':'timestamp'} is filled by Firebase).
 */

import { MESH, MESH_PATHS, type MeshLogEvent, type MeshLogType } from '@/lib/mesh/mesh-protocol'
import { rtdbDelete, rtdbPush, serverTimestamp } from '@/lib/mesh/rtdb-rest'

const LOCAL_EVENTS_KEY = 'nw:mesh:events'
const LOCAL_STATS_KEY = 'nw:mesh:stats'
const LOCAL_EVENT_CAP = 60

/** Events worth persisting to Firebase (cross-user record). */
const REMOTE_TYPES: ReadonlySet<MeshLogType> = new Set<MeshLogType>([
  'fallback-timeout',
  'fallback-no-relay',
  'fallback-no-data',
  'verify-manifest-miss',
  'verify-manifest-bad',
  'verify-consensus-fail',
  'malformed',
  'rate-abuse',
  'stale-reject',
  'relay-switch',
  'promote',
  'refresh-req',
  'refresh-served',
  'cron-trigger',
  'cron-skip',
  'disconnect',
  'error',
])

export interface LocalMeshEvent {
  ts: number
  type: MeshLogType
  room: string
  detail?: string
}

export interface LocalMeshStats {
  joined: number
  served: number
  relaysServed: number
  fallbacks: number
  verifyOk: number
  blocks: number
  since: number
}

function readStats(): LocalMeshStats {
  try {
    const raw = localStorage.getItem(LOCAL_STATS_KEY)
    if (raw) return { ...emptyStats(), ...(JSON.parse(raw) as LocalMeshStats) }
  } catch {
    /* noop */
  }
  return emptyStats()
}

function emptyStats(): LocalMeshStats {
  return {
    joined: 0,
    served: 0,
    relaysServed: 0,
    fallbacks: 0,
    verifyOk: 0,
    blocks: 0,
    since: Date.now(),
  }
}

function writeStats(next: LocalMeshStats): void {
  try {
    localStorage.setItem(LOCAL_STATS_KEY, JSON.stringify(next))
  } catch {
    /* noop */
  }
}

function pushLocalEvent(ev: LocalMeshEvent): void {
  try {
    const raw = localStorage.getItem(LOCAL_EVENTS_KEY)
    const list: LocalMeshEvent[] = raw ? JSON.parse(raw) : []
    list.push(ev)
    while (list.length > LOCAL_EVENT_CAP) list.shift()
    localStorage.setItem(LOCAL_EVENTS_KEY, JSON.stringify(list))
  } catch {
    /* noop */
  }
}

/** Public reader for the /debug Mesh Monitor. */
export function readLocalMeshEvents(): LocalMeshEvent[] {
  try {
    const raw = localStorage.getItem(LOCAL_EVENTS_KEY)
    return raw ? (JSON.parse(raw) as LocalMeshEvent[]) : []
  } catch {
    return []
  }
}

export function readLocalMeshStats(): LocalMeshStats {
  return readStats()
}

let trimCounter = 0

/** Opportunistic trim — keeps /meshLogs bounded. */
async function trimRemoteLogs(): Promise<void> {
  try {
    const res = await fetch(
      `https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app/${MESH_PATHS.logs}.json?shallow=true`,
      { cache: 'no-store', signal: AbortSignal.timeout(6000) },
    )
    if (!res.ok) return
    const keys = (await res.json()) as Record<string, boolean> | null
    if (!keys) return
    const ids = Object.keys(keys).sort() // push ids sort chronologically
    const excess = ids.length - MESH.LOG_MAX_ENTRIES
    if (excess <= 8) return
    // Delete the oldest excess (parallel deletes, bounded batch).
    await Promise.all(ids.slice(0, excess).map((k) => rtdbDelete(`${MESH_PATHS.logs}/${k}`)))
  } catch {
    /* best-effort */
  }
}

/**
 * Log a mesh event. Cheap (fire-and-forget), never throws, never blocks
 * the caller. Remote writes are limited to operational event types so
 * normal traffic doesn't spam the shared log.
 */
export function logMeshEvent(ev: MeshLogEvent, peerId?: string): void {
  if (typeof window === 'undefined') return
  const ts = Date.now()
  const detail = ev.detail ? ev.detail.slice(0, 180) : undefined

  pushLocalEvent({ ts, type: ev.type, room: ev.room, detail })
  try {
    console.debug(`[mesh:${ev.type}] ${ev.room}${detail ? ' — ' + detail : ''}`)
  } catch {
    /* noop */
  }

  // Counters
  const stats = readStats()
  if (ev.type === 'join') stats.joined++
  else if (ev.type === 'served') stats.served++
  else if (ev.type === 'refresh-served') stats.relaysServed++
  else if (ev.type.startsWith('fallback')) stats.fallbacks++
  else if (ev.type === 'verify-ok') stats.verifyOk++
  else if (
    ev.type === 'verify-manifest-bad' ||
    ev.type === 'verify-consensus-fail' ||
    ev.type === 'malformed' ||
    ev.type === 'stale-reject' ||
    ev.type === 'rate-abuse'
  ) {
    stats.blocks++
  }
  writeStats(stats)

  // Remote record for operational events only.
  if (REMOTE_TYPES.has(ev.type)) {
    void rtdbPush(MESH_PATHS.logs, {
      ts: serverTimestamp(),
      type: ev.type,
      room: ev.room.slice(0, 40),
      peerId: (peerId ?? '').slice(0, 8), // truncated — no identity data
      detail,
    }).then((key) => {
      if (key !== null && ++trimCounter % 16 === 0) void trimRemoteLogs()
    })
  }
}
