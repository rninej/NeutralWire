/**
 * mesh-presence.ts — per-room presence + deterministic relay election.
 *
 * Each mesh room (one per feed cache path, e.g. relevant__GB) keeps a
 * presence node in Firebase:
 *
 *   mesh/<room>/peers/<peerId> = { since: <ms>, hb: <ms> }
 *   meshCron/peers/<peerId>    = same (the user-cron election room)
 *
 * Peers heartbeat every 10s (short REST PUT — no persistent connection);
 * anyone without a heartbeat for 35s is treated as gone. The RELAY for a
 * room is the live peer with the earliest `since` — everyone computes
 * this locally from the same presence stream, so when a relay leaves,
 * the next-oldest peer automatically promotes and consumers reconnect
 * to it (auto-replacement, no coordination needed).
 *
 * One SSE watch per room per visible tab (Firebase caps simultaneous
 * connections). Hidden tabs keep receiving events but stop heartbeating
 * (browser timer throttling), so they naturally drop out of presence and
 * rejoin instantly on visibility.
 */

import {
  MESH,
  MESH_PATHS,
  electRelay,
  livePeers,
  type MeshPeerEntry,
} from '@/lib/mesh/mesh-protocol'
import { applyPutEvent, rtdbDelete, rtdbPut, rtdbWatch } from '@/lib/mesh/rtdb-rest'

export type PresenceKind = 'feed' | 'cron'

export interface PresenceSnapshot {
  peers: Array<{ peerId: string; since: number }>
  relay: string | null
  iAmRelay: boolean
  myPeerId: string
}

function getTabPeerId(): string {
  try {
    const existing = sessionStorage.getItem('nw:mesh:peerId')
    if (existing) return existing
    const fresh =
      globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 16) ??
      Math.random().toString(36).slice(2, 12)
    sessionStorage.setItem('nw:mesh:peerId', fresh)
    return fresh
  } catch {
    return Math.random().toString(36).slice(2, 12)
  }
}

function getRoomSince(room: string): number {
  try {
    const key = `nw:mesh:since:${room}`
    const existing = sessionStorage.getItem(key)
    if (existing) return Number(existing) || Date.now()
    const now = Date.now()
    sessionStorage.setItem(key, String(now))
    return now
  } catch {
    return Date.now()
  }
}

export class RoomPresence {
  readonly room: string
  readonly myPeerId: string
  private readonly kind: PresenceKind
  private readonly since: number
  private peers: Record<string, MeshPeerEntry | null> = {}
  private watchHandle: { close: () => void } | null = null
  private hbTimer: ReturnType<typeof setInterval> | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private visHandler: (() => void) | null = null
  private leaveHandlers: (() => void)[] = []
  private joined = false
  private lastSignature = ''
  private listener: ((snap: PresenceSnapshot) => void) | null = null

  constructor(room: string, kind: PresenceKind = 'feed') {
    this.room = room
    this.kind = kind
    this.myPeerId = getTabPeerId()
    this.since = getRoomSince(`kind:${kind}:${room}`)
  }

  private get peersPath(): string {
    return this.kind === 'cron' ? MESH_PATHS.cronPeers : MESH_PATHS.peers(this.room)
  }
  private get myPath(): string {
    return this.kind === 'cron'
      ? MESH_PATHS.cronPeer(this.myPeerId)
      : MESH_PATHS.peer(this.room, this.myPeerId)
  }

  onSnapshot(cb: (snap: PresenceSnapshot) => void): void {
    this.listener = cb
    this.emit()
  }

  snapshot(): PresenceSnapshot {
    const peers = livePeers(this.peers as Record<string, MeshPeerEntry>)
    const relay = electRelay(peers)
    return {
      peers,
      relay,
      iAmRelay: relay === this.myPeerId,
      myPeerId: this.myPeerId,
    }
  }

  private emit(): void {
    if (!this.listener) return
    const snap = this.snapshot()
    // Dedupe by signature — SSE churn shouldn't spam consumers.
    const sig = `${snap.relay}|${snap.peers.length}|${snap.peers.map((p) => p.peerId).sort().join(',')}`
    if (sig === this.lastSignature) return
    this.lastSignature = sig
    this.listener(snap)
  }

  async join(): Promise<void> {
    if (this.joined || typeof window === 'undefined') return
    this.joined = true

    // Initial presence write.
    await rtdbPut(this.myPath, { since: this.since, hb: Date.now() })

    // Heartbeat (skips naturally while the tab is throttled).
    this.hbTimer = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void rtdbPut(this.myPath, { since: this.since, hb: Date.now() })
    }, MESH.HEARTBEAT_MS)

    // Watch everyone else (one SSE stream).
    this.watchHandle = rtdbWatch(this.peersPath, (events) => {
      for (const ev of events) {
        this.peers = applyPutEvent<MeshPeerEntry | null>(this.peers, ev)
      }
      this.emit()
    })

    // Staleness sweep (peers can go stale without any SSE event).
    this.sweepTimer = setInterval(() => this.emit(), 5_000)

    // Immediate heartbeat + recompute when the tab becomes visible again.
    this.visHandler = () => {
      if (document.visibilityState === 'visible') {
        void rtdbPut(this.myPath, { since: this.since, hb: Date.now() })
        this.emit()
      }
    }
    document.addEventListener('visibilitychange', this.visHandler)

    // Best-effort clean leave when the tab closes.
    const leave = () => this.leaveSync()
    window.addEventListener('pagehide', leave)
    this.leaveHandlers.push(() => window.removeEventListener('pagehide', leave))
  }

  /** Fire-and-forget heartbeat write (used right before a long wait). */
  beat(): void {
    void rtdbPut(this.myPath, { since: this.since, hb: Date.now() })
  }

  private leaveSync(): void {
    try {
      // keepalive DELETE — the request survives tab teardown.
      void fetch(
        `https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app/${this.myPath}.json`,
        { method: 'DELETE', keepalive: true },
      ).catch(() => {})
    } catch {
      /* noop */
    }
  }

  leave(): void {
    if (!this.joined) return
    this.joined = false
    if (this.hbTimer) clearInterval(this.hbTimer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    if (this.visHandler) {
      document.removeEventListener('visibilitychange', this.visHandler)
      this.visHandler = null
    }
    for (const off of this.leaveHandlers) off()
    this.leaveHandlers = []
    this.watchHandle?.close()
    this.watchHandle = null
    void rtdbDelete(this.myPath)
  }
}
