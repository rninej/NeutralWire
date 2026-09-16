/**
 * mesh-relay.ts — the P2P news relay itself (client-side, experimental).
 *
 * ROLES (per feed room — one room per Firebase cache path, so country
 * feeds never mix):
 *   RELAY    = the live peer with the earliest join time (deterministic
 *              election from presence; auto-replaces when it leaves).
 *              Duties: read newsCache/<room> + the SIGNED manifest
 *              directly from Firebase (zero Vercel invocations), verify,
 *              serve snapshots to every consumer over a WebRTC data
 *              channel, poll the manifest for updates, and — rate
 *              limited — run /api/refresh when consumers report a stale
 *              feed, broadcasting the fresh node to everyone.
 *   CONSUMER = everyone else. Connects to the relay, verifies every
 *              received node (signed manifest at low peer counts;
 *              3-random-peer consensus at scale with a periodic signed
 *              anchor), and serves its own UI from the verified node.
 *
 * NON-GOALS / SAFETY:
 *  - The mesh NEVER blocks a cold load: meshGetFeed returns instantly
 *    from the verified cache or null (caller falls back to /api/news).
 *  - Any verification failure, malformed payload, rate abuse or stale
 *    rejection → data is BLOCKED, an event lands in the /debug mesh log,
 *    and the caller fetches from the server. The mesh can only ever
 *    fail CLOSED, never open.
 *  - WebRTC handshakes use Firebase REST nodes for signaling (tiny
 *    writes + short polls — no extra persistent connections).
 */

import type { TopicArticle } from '@/lib/news-aggregator'
import {
  MESH,
  MESH_PATHS,
  hashMeshNode,
  livePeers,
  meshRoomFor,
  validateMeshNode,
  type MeshChunkFrame,
  type MeshFeedNode,
  type MeshManifest,
  type MeshPeerEntry,
  type MeshPeerHash,
  type MeshWireMessage,
} from '@/lib/mesh/mesh-protocol'
import { verifyManifestForNode } from '@/lib/mesh/mesh-crypto'
import { RoomPresence, type PresenceSnapshot } from '@/lib/mesh/mesh-presence'
import { logMeshEvent } from '@/lib/mesh/mesh-log'
import { rtdbDelete, rtdbGet, rtdbPut, serverTimestamp } from '@/lib/mesh/rtdb-rest'

// ── Public types ──

export interface MeshFeedQuery {
  category: string
  country?: string | null
  limit: number
  minCoverage: number
  offset: number
  slim: boolean
}

export interface MeshFeedResponse {
  category: string
  country: string
  topics: TopicArticle[]
  cached: boolean
  fresh: boolean
  sourceCount: number
  articleCount: number
  fetchedAt: string
  viaMesh: true
}

export interface MeshRoomInfo {
  room: string | null
  category: string | null
  country: string | null
  role: 'off' | 'relay' | 'consumer' | 'connecting'
  relayPeerId: string | null
  peers: number
  consumers: number
  verifiedHash: string | null
  nodeUpdatedAt: number | null
  verifiedAt: number | null
}

export type MeshDataCallback = (room: string, node: MeshFeedNode) => void

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 12) ??
    Math.random().toString(36).slice(2, 12)
  )
}

/** Freshness horizon mirrored from the server cache TTL (30 min). */
const FRESH_MS = 25 * 60 * 1000

// ── Chunked wire transfer ──

class Assembler {
  private map = new Map<string, { parts: string[]; tot: number; firstAt: number }>()

  push(frame: MeshChunkFrame): MeshWireMessage | null {
    if (
      frame.tot <= 0 ||
      frame.seq < 0 ||
      frame.seq >= frame.tot ||
      typeof frame.s !== 'string' ||
      frame.tot * MESH.CHUNK_BYTES > MESH.MAX_MESSAGE_BYTES
    ) {
      return null
    }
    let entry = this.map.get(frame.id)
    if (!entry) {
      entry = { parts: new Array(frame.tot).fill(null), tot: frame.tot, firstAt: Date.now() }
      this.map.set(frame.id, entry)
    }
    if (frame.tot !== entry.tot) return null
    entry.parts[frame.seq] = frame.s
    if (entry.parts.some((p) => p === null)) return null
    const serialized = entry.parts.join('')
    this.map.delete(frame.id)
    if (serialized.length > MESH.MAX_MESSAGE_BYTES) return null
    try {
      return JSON.parse(serialized) as MeshWireMessage
    } catch {
      return null
    }
  }

  sweep(): void {
    const now = Date.now()
    for (const [id, entry] of this.map) {
      if (now - entry.firstAt > 20_000) this.map.delete(id)
    }
  }
}

function sendWire(dc: RTCDataChannel, msg: MeshWireMessage): void {
  if (dc.readyState !== 'open') return
  const serialized = JSON.stringify(msg)
  if (serialized.length <= MESH.CHUNK_BYTES) {
    dc.send(serialized)
    return
  }
  if (serialized.length > MESH.MAX_MESSAGE_BYTES) return
  const id = randomId()
  const tot = Math.ceil(serialized.length / MESH.CHUNK_BYTES)
  for (let seq = 0; seq < tot; seq++) {
    const frame: MeshChunkFrame = {
      t: 'm',
      id,
      seq,
      tot,
      s: serialized.slice(seq * MESH.CHUNK_BYTES, (seq + 1) * MESH.CHUNK_BYTES),
    }
    dc.send(JSON.stringify(frame))
  }
}

function waitIceComplete(pc: RTCPeerConnection, capMs = 2_000): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', onChange)
      resolve()
    }
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish()
    }
    const timer = setTimeout(finish, capMs)
    pc.addEventListener('icegatheringstatechange', onChange)
  })
}

// ── One mesh room ──

interface ConsumerConn {
  peerId: string
  pc: RTCPeerConnection
  dc: RTCDataChannel
  assembler: Assembler
  inbound: number[]
}

class MeshRoom {
  readonly room: string
  readonly category: string
  readonly country: string | null
  private readonly onData: MeshDataCallback

  private presence: RoomPresence
  private peers: Record<string, MeshPeerEntry | null> = {}
  private relayPeerId: string | null = null
  private iAmRelay = false

  // Verified data (both roles)
  private node: MeshFeedNode | null = null
  private nodeHash: string | null = null
  private verifiedAt: number | null = null
  private lastManifestAnchorAt = 0
  private lastRefreshReqAt = 0
  private refreshInFlight = false

  // Relay state
  private consumers = new Map<string, ConsumerConn>()
  private sigPollTimer: ReturnType<typeof setInterval> | null = null
  private handledOffers = new Set<string>()
  private retryLoadTimer: ReturnType<typeof setInterval> | null = null

  // Consumer state
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private assembler = new Assembler()
  private inbound: number[] = []
  private sigPollTimerConsumer: ReturnType<typeof setInterval> | null = null
  private consumerReconnects = 0
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private lastPongAt = 0

  // Shared
  private manifestPollTimer: ReturnType<typeof setInterval> | null = null
  private hashRefreshTimer: ReturnType<typeof setInterval> | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(category: string, country: string | null, onData: MeshDataCallback) {
    this.category = category
    this.country = country
    this.room = meshRoomFor(category, country)
    this.onData = onData
    this.presence = new RoomPresence(this.room, 'feed')
    // Seed from previously verified data (same tab session) — a quick
    // category flip-flop serves instantly instead of racing the relay's
    // Firebase reload. The relay re-verifies on duty start regardless.
    const seeded = verifiedNodeCache.get(this.room)
    if (seeded && Date.now() - seeded.at < NODE_CACHE_TTL_MS) {
      this.node = seeded.node
      this.nodeHash = seeded.hash
      this.verifiedAt = seeded.at
    }
  }

  info(): MeshRoomInfo {
    const peers = livePeers(this.peers as Record<string, MeshPeerEntry>)
    return {
      room: this.room,
      category: this.category,
      country: this.country,
      role: this.iAmRelay ? 'relay' : this.dc ? 'consumer' : 'connecting',
      relayPeerId: this.relayPeerId,
      peers: peers.length,
      consumers: this.consumers.size,
      verifiedHash: this.nodeHash,
      nodeUpdatedAt: this.node?.updatedAt ?? null,
      verifiedAt: this.verifiedAt,
    }
  }

  async start(): Promise<void> {
    if (this.closed) return
    await this.presence.join()
    logMeshEvent({ type: 'join', room: this.room })
    this.presence.onSnapshot((snap) => this.onPresence(snap))
    // Kick role resolution immediately (presence snapshot may already be live).
    this.onPresence(this.presence.snapshot())
    // Periodic upkeep shared by both roles.
    this.sweepTimer = setInterval(() => {
      this.assembler.sweep()
      this.inbound = this.inbound.filter((t) => Date.now() - t < 1_000)
    }, 5_000)
    this.hashRefreshTimer = setInterval(() => {
      // Keep our consensus vote fresh while we hold verified data.
      if (this.nodeHash && this.node) {
        void rtdbPut(MESH_PATHS.hash(this.room, this.presence.myPeerId), {
          h: this.nodeHash,
          u: this.node.updatedAt,
          ts: serverTimestamp(),
        })
      }
    }, 60_000)
  }

  close(): void {
    this.closed = true
    this.presence.leave()
    this.clearTimers()
    // Close consumer side.
    this.closeConsumerSide()
    // Close all consumer channels (relay side).
    for (const conn of this.consumers.values()) {
      try {
        conn.dc.close()
        conn.pc.close()
      } catch {
        /* noop */
      }
    }
    this.consumers.clear()
    void rtdbDelete(MESH_PATHS.sigOf(this.room, this.presence.myPeerId))
    logMeshEvent({ type: 'leave', room: this.room })
  }

  private clearTimers(): void {
    for (const t of [
      this.sigPollTimer,
      this.retryLoadTimer,
      this.sigPollTimerConsumer,
      this.pingTimer,
      this.manifestPollTimer,
      this.hashRefreshTimer,
      this.sweepTimer,
    ]) {
      if (t) clearInterval(t)
    }
    this.sigPollTimer = null
    this.retryLoadTimer = null
    this.sigPollTimerConsumer = null
    this.pingTimer = null
    this.manifestPollTimer = null
    this.hashRefreshTimer = null
    this.sweepTimer = null
  }

  // ── Role resolution ──

  private onPresence(snap: PresenceSnapshot): void {
    if (this.closed) return
    this.peers = Object.fromEntries(
      snap.peers.map((p) => [p.peerId, { since: p.since, hb: Date.now() } as MeshPeerEntry]),
    )
    const prevRelay = this.relayPeerId
    this.relayPeerId = snap.relay
    const wasRelay = this.iAmRelay
    this.iAmRelay = snap.iAmRelay

    if (prevRelay && snap.relay && prevRelay !== snap.relay) {
      logMeshEvent({ type: 'relay-switch', room: this.room, detail: `${prevRelay.slice(0, 6)} → ${snap.relay.slice(0, 6)}` })
    }

    if (this.iAmRelay) {
      if (!wasRelay) {
        if (prevRelay !== null) {
          // We just inherited the room — the old relay vanished.
          logMeshEvent({ type: 'promote', room: this.room })
        }
        this.startRelayDuties()
      }
      return
    }

    if (wasRelay && !this.iAmRelay) {
      // An older peer appeared (session predates ours) — hand relay back.
      this.stopRelayDuties()
    }
    if (snap.relay && snap.relay !== this.presence.myPeerId) {
      this.connectToRelay(snap.relay)
    }
  }

  // ── Consumer side ──

  private closeConsumerSide(): void {
    if (this.sigPollTimerConsumer) {
      clearInterval(this.sigPollTimerConsumer)
      this.sigPollTimerConsumer = null
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    try {
      this.dc?.close()
    } catch {
      /* noop */
    }
    try {
      this.pc?.close()
    } catch {
      /* noop */
    }
    this.dc = null
    this.pc = null
  }

  private async connectToRelay(relayId: string): Promise<void> {
    if (this.closed || this.iAmRelay) return
    if (this.dc && this.relayPeerId === relayId) return // already connected to it
    this.closeConsumerSide()

    const myId = this.presence.myPeerId
    const sigPath = MESH_PATHS.sigOf(this.room, myId)
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    this.pc = pc
    const dc = pc.createDataChannel('nw', { ordered: true })
    this.dc = dc

    dc.onopen = () => {
      this.consumerReconnects = 0
      this.lastPongAt = Date.now()
      logMeshEvent({ type: 'connect', room: this.room, detail: relayId.slice(0, 6) })
      sendWire(dc, { t: 'get' })
      this.pingTimer = setInterval(() => {
        if (!this.dc) return
        if (Date.now() - this.lastPongAt > 45_000) {
          logMeshEvent({ type: 'disconnect', room: this.room, detail: 'pong timeout' })
          this.scheduleReconnect(relayId)
          return
        }
        sendWire(this.dc, { t: 'ping' })
      }, 15_000)
    }
    dc.onmessage = (ev) => this.onConsumerMessage(String(ev.data))
    dc.onclose = () => {
      if (!this.closed && !this.iAmRelay) this.scheduleReconnect(relayId)
    }
    pc.onconnectionstatechange = () => {
      if (
        !this.closed &&
        !this.iAmRelay &&
        (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')
      ) {
        this.scheduleReconnect(relayId)
      }
    }

    try {
      // Offer with fully-gathered ICE (non-trickle — one signaling write).
      await pc.setLocalDescription(await pc.createOffer())
      await waitIceComplete(pc)
      const offer = pc.localDescription
      if (!offer) throw new Error('no local description')
      await rtdbPut(sigPath, {
        from: myId,
        to: relayId,
        offer: { type: offer.type, sdp: offer.sdp },
        ts: Date.now(),
      })

      // Poll our own signaling node for the relay's answer (short GETs —
      // no persistent connection; stops once connected or timed out).
      const deadline = Date.now() + MESH.CONNECT_TIMEOUT_MS
      this.sigPollTimerConsumer = setInterval(async () => {
        if (this.closed || this.pc !== pc) {
          if (this.sigPollTimerConsumer) clearInterval(this.sigPollTimerConsumer)
          return
        }
        if (Date.now() > deadline) {
          if (this.sigPollTimerConsumer) clearInterval(this.sigPollTimerConsumer)
          this.scheduleReconnect(relayId)
          return
        }
        const entry = await rtdbGet<{ answer?: { type: string; sdp: string } }>(sigPath)
        if (entry?.answer?.sdp) {
          if (this.sigPollTimerConsumer) clearInterval(this.sigPollTimerConsumer)
          try {
            await pc.setRemoteDescription(
              new RTCSessionDescription({ type: 'answer', sdp: entry.answer.sdp }),
            )
          } catch {
            this.scheduleReconnect(relayId)
          } finally {
            void rtdbDelete(sigPath)
          }
        }
      }, 1_200)
    } catch {
      this.scheduleReconnect(relayId)
    }
  }

  private scheduleReconnect(relayId: string): void {
    if (this.closed || this.iAmRelay) return
    this.closeConsumerSide()
    if (++this.consumerReconnects > 5) return // presence changes will re-trigger
    setTimeout(() => {
      if (this.closed || this.iAmRelay) return
      if (this.relayPeerId === relayId) void this.connectToRelay(relayId)
    }, 1_500 + Math.random() * 1_000)
  }

  private onConsumerMessage(raw: string): void {
    // Rate limit (abuse → hard drop; the caller's fetches fall back).
    const now = Date.now()
    this.inbound.push(now)
    this.inbound = this.inbound.filter((t) => now - t < 1_000)
    if (this.inbound.length > MESH.MSG_RATE_LIMIT_PER_SEC) {
      logMeshEvent({ type: 'rate-abuse', room: this.room })
      this.closeConsumerSide()
      return
    }

    let msg: MeshWireMessage | MeshChunkFrame
    try {
      msg = JSON.parse(raw) as MeshWireMessage | MeshChunkFrame
    } catch {
      logMeshEvent({ type: 'malformed', room: this.room, detail: 'bad json' })
      return
    }
    if ((msg as MeshChunkFrame).t === 'm') {
      const assembled = this.assembler.push(msg as MeshChunkFrame)
      if (!assembled) return
      msg = assembled
    }
    this.handleWire(msg as MeshWireMessage)
  }

  private handleWire(msg: MeshWireMessage): void {
    if (!msg || typeof msg.t !== 'string') return
    switch (msg.t) {
      case 'pong':
        this.lastPongAt = Date.now()
        return
      case 'ping':
        sendWire(this.dc as RTCDataChannel, { t: 'pong' })
        return
      case 'snap':
      case 'upd': {
        const node = msg.node ?? null
        if (!node) {
          logMeshEvent({ type: 'fallback-no-data', room: this.room })
          return
        }
        void this.verifyAndAccept(node, msg.t === 'snap')
        return
      }
      default:
        return
    }
  }

  // ── Verification (the heart of the trust model) ──

  private async verifyAndAccept(rawNode: unknown, isSnapshot: boolean): Promise<void> {
    if (this.closed) return
    const node = validateMeshNode(rawNode)
    if (!node) {
      logMeshEvent({ type: 'malformed', room: this.room, detail: 'invalid node shape' })
      return
    }
    // Replay/stale guard: ignore nodes older than what we already hold.
    if (this.node && node.updatedAt <= this.node.updatedAt && !isSnapshot) {
      if (Date.now() - (this.node.updatedAt ?? 0) > MESH.STALE_NODE_MS) {
        logMeshEvent({ type: 'stale-reject', room: this.room })
      }
      return
    }

    const hash = await hashMeshNode(node)
    const peerCount = livePeers(this.peers as Record<string, MeshPeerEntry>).length
    const useConsensus = peerCount >= MESH.CONSENSUS_MIN_PEERS
    const anchorDue =
      Date.now() - this.lastManifestAnchorAt > MESH.MANIFEST_ANCHOR_MS || !this.node

    if (!useConsensus || anchorDue) {
      const manifest = await rtdbGet<MeshManifest>(MESH_PATHS.manifest(this.room))
      const res = await verifyManifestForNode(this.room, manifest, hash)
      if (!res.ok) {
        logMeshEvent({
          type:
            res.reason === 'missing'
              ? 'verify-manifest-miss'
              : res.reason === 'mismatch'
                ? 'verify-manifest-bad'
                : 'verify-manifest-bad',
          room: this.room,
          detail: `sig=${res.reason ?? 'fail'}`,
        })
        return // blocked — caller keeps using the server path
      }
      this.lastManifestAnchorAt = Date.now()
      this.acceptVerified(node, hash)
      return
    }

    // Consensus mode: 3 random live peers' published hashes; ≥2 must match.
    const hashes = await rtdbGet<Record<string, MeshPeerHash>>(MESH_PATHS.hashes(this.room))
    const now = Date.now()
    const live = new Set(
      livePeers(this.peers as Record<string, MeshPeerEntry>).map((p) => p.peerId),
    )
    const myId = this.presence.myPeerId
    const candidates: string[] = []
    if (hashes) {
      for (const [peerId, entry] of Object.entries(hashes)) {
        if (peerId === myId || !live.has(peerId)) continue
        if (!entry || typeof entry.h !== 'string') continue
        if (typeof entry.ts !== 'number' || now - entry.ts > MESH.PEER_HASH_TTL_MS) continue
        candidates.push(peerId)
      }
    }
    if (candidates.length < 3) {
      // Not enough peers to vote — fall back to the signed manifest.
      const manifest = await rtdbGet<MeshManifest>(MESH_PATHS.manifest(this.room))
      const res = await verifyManifestForNode(this.room, manifest, hash)
      if (res.ok) {
        this.lastManifestAnchorAt = Date.now()
        this.acceptVerified(node, hash)
      } else {
        logMeshEvent({ type: 'verify-manifest-bad', room: this.room, detail: 'consensus thin + manifest fail' })
      }
      return
    }
    // Random 3 (Fisher-Yates over a copy).
    const shuffled = [...candidates]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    const voters = shuffled.slice(0, 3)
    let matches = 0
    for (const v of voters) {
      if (hashes?.[v]?.h === hash) matches++
    }
    if (matches >= 2) {
      this.acceptVerified(node, hash)
    } else {
      logMeshEvent({
        type: 'verify-consensus-fail',
        room: this.room,
        detail: `${matches}/3 matched`,
      })
    }
  }

  private acceptVerified(node: MeshFeedNode, hash: string): void {
    const hadNode = !!this.node
    this.node = node
    this.nodeHash = hash
    this.verifiedAt = Date.now()
    cacheVerifiedNode(this.room, node, hash)
    logMeshEvent({ type: 'verify-ok', room: this.room })
    // Publish our vote for consensus.
    void rtdbPut(MESH_PATHS.hash(this.room, this.presence.myPeerId), {
      h: hash,
      u: node.updatedAt,
      ts: serverTimestamp(),
    })
    this.onData(this.room, node)
    if (this.iAmRelay) this.broadcast({ t: hadNode ? 'upd' : 'snap', node })
  }

  // ── Relay side ──

  private startRelayDuties(): void {
    this.closeConsumerSide() // never both
    // Initial load + retry while the room is cold (no cache/manifest yet).
    void this.loadNodeFromFirebase()
    this.retryLoadTimer = setInterval(() => {
      if (this.node) {
        if (this.retryLoadTimer) clearInterval(this.retryLoadTimer)
        this.retryLoadTimer = null
        return
      }
      void this.loadNodeFromFirebase()
    }, 15_000)
    // Manifest poll → push updates to everyone.
    this.manifestPollTimer = setInterval(() => void this.pollManifest(), MESH.MANIFEST_POLL_MS)
    // Answer connection requests from consumers (short polls).
    this.sigPollTimer = setInterval(() => void this.pollSignals(), 2_000)
  }

  private stopRelayDuties(): void {
    if (this.sigPollTimer) {
      clearInterval(this.sigPollTimer)
      this.sigPollTimer = null
    }
    if (this.retryLoadTimer) {
      clearInterval(this.retryLoadTimer)
      this.retryLoadTimer = null
    }
    for (const conn of this.consumers.values()) {
      try {
        conn.dc.close()
        conn.pc.close()
      } catch {
        /* noop */
      }
    }
    this.consumers.clear()
  }

  /** Direct Firebase read + manifest verification (zero Vercel cost).
   *  Manifest FIRST (~150B) — rooms without one (pre-mesh caches) never
   *  pay the full-node read on the retry loop. */
  private async loadNodeFromFirebase(): Promise<void> {
    if (this.closed || !this.iAmRelay) return
    try {
      const manifest = await rtdbGet<MeshManifest>(MESH_PATHS.manifest(this.room))
      if (!manifest || typeof manifest.hash !== 'string') return // no manifest yet — mesh stays off for this room
      const rawNode = await rtdbGet<Record<string, unknown>>(MESH_PATHS.node(this.room))
      if (!rawNode) return // cold room — consumers fall back to /api/news
      const node = validateMeshNode(rawNode)
      if (!node) return
      const hash = await hashMeshNode(node)
      let res = await verifyManifestForNode(this.room, manifest, hash)
      if (!res.ok) {
        // Node-then-manifest write race: the server writes the node FIRST
        // and the manifest ~300ms later (writeCachedNews awaits both, but
        // the DB sees them as two writes). If our two reads straddled a
        // refresh (old manifest + new node), re-read the manifest once
        // after it settles instead of logging a false mismatch and going
        // dark for a poll cycle.
        await new Promise((r) => setTimeout(r, 600))
        const manifest2 = await rtdbGet<MeshManifest>(MESH_PATHS.manifest(this.room))
        res = await verifyManifestForNode(this.room, manifest2, hash)
      }
      if (!res.ok) {
        logMeshEvent({ type: 'verify-manifest-bad', room: this.room, detail: `relay load: ${res.reason ?? 'fail'}` })
        return
      }
      this.lastManifestAnchorAt = Date.now()
      const isUpdate = !!this.node && this.node.updatedAt < node.updatedAt
      this.acceptVerified(node, hash)
      if (isUpdate) {
        logMeshEvent({ type: 'refresh-served', room: this.room, detail: `${node.topics.length} topics` })
      }
    } catch (err) {
      logMeshEvent({ type: 'error', room: this.room, detail: String(err).slice(0, 120) })
    }
  }

  private knownManifestHash: string | null = null

  private async pollManifest(): Promise<void> {
    if (this.closed || !this.iAmRelay) return
    const manifest = await rtdbGet<MeshManifest>(MESH_PATHS.manifest(this.room))
    if (!manifest || typeof manifest.hash !== 'string') return
    if (manifest.hash === this.nodeHash || manifest.hash === this.knownManifestHash) return
    this.knownManifestHash = manifest.hash
    void this.loadNodeFromFirebase()
  }

  private async pollSignals(): Promise<void> {
    if (this.closed || !this.iAmRelay) return
    const sigs = await rtdbGet<
      Record<string, { from?: string; to?: string; offer?: { type: string; sdp: string }; ts?: number }>
    >(MESH_PATHS.sig(this.room))
    if (!sigs) return
    const now = Date.now()
    for (const [consumerId, entry] of Object.entries(sigs)) {
      if (!entry || entry.to !== this.presence.myPeerId || !entry.offer?.sdp) continue
      const key = `${consumerId}:${entry.ts ?? 0}`
      if (this.handledOffers.has(key)) continue
      this.handledOffers.add(key)
      if (this.handledOffers.size > 200) this.handledOffers.clear()
      if (typeof entry.ts === 'number' && now - entry.ts > 45_000) {
        // Stale handshake — clean up.
        void rtdbDelete(MESH_PATHS.sigOf(this.room, consumerId))
        continue
      }
      void this.answerConsumer(consumerId, entry.offer)
    }
  }

  private async answerConsumer(consumerId: string, offer: { type: string; sdp: string }): Promise<void> {
    if (this.closed || !this.iAmRelay) return
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    const conn: ConsumerConn = {
      peerId: consumerId,
      pc,
      dc: null as unknown as RTCDataChannel,
      assembler: new Assembler(),
      inbound: [],
    }
    pc.ondatachannel = (ev) => {
      const dc = ev.channel
      conn.dc = dc
      this.consumers.set(consumerId, conn)
      dc.onopen = () => {
        // Serve the current verified snapshot immediately.
        if (this.node) sendWire(dc, { t: 'snap', node: this.node })
      }
      dc.onmessage = (m) => {
        const now = Date.now()
        conn.inbound.push(now)
        conn.inbound = conn.inbound.filter((t) => now - t < 1_000)
        if (conn.inbound.length > MESH.MSG_RATE_LIMIT_PER_SEC) {
          logMeshEvent({ type: 'rate-abuse', room: this.room, detail: consumerId.slice(0, 6) })
          try {
            dc.close()
            pc.close()
          } catch {
            /* noop */
          }
          this.consumers.delete(consumerId)
          return
        }
        let msg: MeshWireMessage | MeshChunkFrame
        try {
          msg = JSON.parse(String(m.data)) as MeshWireMessage | MeshChunkFrame
        } catch {
          logMeshEvent({ type: 'malformed', room: this.room, detail: 'bad json (relay)' })
          return
        }
        if ((msg as MeshChunkFrame).t === 'm') {
          const assembled = conn.assembler.push(msg as MeshChunkFrame)
          if (!assembled) return
          msg = assembled
        }
        const wire = msg as MeshWireMessage
        if (wire.t === 'get') {
          if (this.node) sendWire(dc, { t: 'snap', node: this.node })
        } else if (wire.t === 'refresh-req') {
          void this.handleRefreshReq()
        } else if (wire.t === 'ping') {
          sendWire(dc, { t: 'pong' })
        }
      }
      dc.onclose = () => {
        this.consumers.delete(consumerId)
        try {
          pc.close()
        } catch {
          /* noop */
        }
      }
    }
    try {
      await pc.setRemoteDescription(
        new RTCSessionDescription({ type: 'offer', sdp: offer.sdp }),
      )
      await pc.setLocalDescription(await pc.createAnswer())
      await waitIceComplete(pc)
      const answer = pc.localDescription
      if (!answer) throw new Error('no answer')
      await rtdbPut(MESH_PATHS.sigOf(this.room, consumerId), {
        from: this.presence.myPeerId,
        to: consumerId,
        answer: { type: 'answer', sdp: answer.sdp },
        ts: Date.now(),
      })
    } catch (err) {
      logMeshEvent({ type: 'error', room: this.room, detail: `answer failed: ${String(err).slice(0, 80)}` })
      try {
        pc.close()
      } catch {
        /* noop */
      }
    }
  }

  private async handleRefreshReq(): Promise<void> {
    if (this.closed || !this.iAmRelay) return
    const now = Date.now()
    if (now - this.lastRefreshReqAt < MESH.REFRESH_REQ_GAP_MS) return
    const nodeAge = this.node ? now - this.node.updatedAt : Infinity
    if (nodeAge < MESH.STALE_NODE_MS) return // not actually stale
    this.lastRefreshReqAt = now
    logMeshEvent({ type: 'refresh-req', room: this.room })
    if (this.refreshInFlight) return
    this.refreshInFlight = true
    try {
      // ONE server invocation per room per refresh — the whole room's
      // freshness rides on it.
      const params = new URLSearchParams({
        category: this.category,
        limit: '24',
        slim: '1',
        minCoverage: '1',
      })
      if (this.country) params.set('country', this.country)
      await fetch(`/api/refresh?${params.toString()}`, { cache: 'no-store' }).catch(() => null)
      // /api/refresh rewrote the cache AND manifest — reload + broadcast.
      await this.loadNodeFromFirebase()
    } finally {
      this.refreshInFlight = false
    }
  }

  private broadcast(msg: MeshWireMessage): void {
    for (const conn of this.consumers.values()) {
      if (conn.dc && conn.dc.readyState === 'open') sendWire(conn.dc, msg)
    }
  }

  /** Consumer hook: ask the relay for a fresher feed (rate-limited). */
  requestRefreshIfStale(): void {
    if (this.closed || this.iAmRelay || !this.node) return
    if (Date.now() - this.node.updatedAt < MESH.STALE_NODE_MS) return
    if (Date.now() - this.lastRefreshReqAt < MESH.REFRESH_REQ_GAP_MS) return
    this.lastRefreshReqAt = Date.now()
    if (this.dc && this.dc.readyState === 'open') {
      sendWire(this.dc, { t: 'refresh-req' })
      logMeshEvent({ type: 'refresh-req', room: this.room, detail: 'consumer requested' })
    }
  }

  // ── Query derivation (mirrors /api/news applyFilters) ──

  feedResponse(query: MeshFeedQuery): MeshFeedResponse | null {
    if (!this.node) return null
    const topics = this.node.topics
      .filter((t) => t.coverage >= query.minCoverage)
      .slice(query.offset, query.offset + query.limit)
    if (topics.length === 0 && query.offset > 0) {
      // Deeper than the room's node — let the caller hit the server.
      return null
    }
    const age = Date.now() - this.node.updatedAt
    logMeshEvent({ type: 'served', room: this.room })
    this.requestRefreshIfStale()
    return {
      category: query.category,
      country: query.country ?? '',
      topics: query.slim ? topics.map((t) => ({ ...t, articles: [] })) : topics,
      cached: true,
      fresh: age < FRESH_MS,
      sourceCount: this.node.sourceCount,
      articleCount: this.node.articleCount,
      fetchedAt: new Date(this.node.updatedAt).toISOString(),
      viaMesh: true,
    }
  }
}

// ── Manager (singleton) ──

/** Verified-node cache, keyed by room — survives room switches within
 *  the tab so a category flip-flop serves instantly from previously
 *  VERIFIED data (the cache only ever holds acceptVerified() output).
 *  Freshness is still governed by the node age checks; the relay
 *  re-reads + re-verifies from Firebase on room (re)join anyway. */
const verifiedNodeCache = new Map<string, { node: MeshFeedNode; hash: string; at: number }>()
const NODE_CACHE_TTL_MS = 10 * 60 * 1000
const NODE_CACHE_MAX = 8

function cacheVerifiedNode(room: string, node: MeshFeedNode, hash: string): void {
  verifiedNodeCache.set(room, { node, hash, at: Date.now() })
  if (verifiedNodeCache.size > NODE_CACHE_MAX) {
    const oldest = [...verifiedNodeCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) verifiedNodeCache.delete(oldest[0])
  }
}

type ManagerState = {
  enabled: boolean
  room: MeshRoom | null
  dataCallbacks: Set<MeshDataCallback>
}

const state: ManagerState = {
  enabled: false,
  room: null,
  dataCallbacks: new Set(),
}

function notifyData(room: string, node: MeshFeedNode): void {
  for (const cb of state.dataCallbacks) {
    try {
      cb(room, node)
    } catch {
      /* one bad subscriber never breaks the mesh */
    }
  }
}

export function initMesh(opts: { enabled: boolean }): void {
  if (typeof window === 'undefined') return
  const wasEnabled = state.enabled
  state.enabled = opts.enabled
  if (!opts.enabled) {
    if (wasEnabled) state.room?.close()
    state.room = null
    return
  }
  if (wasEnabled && state.room) return // already running
}

/** Switch (or join) the room for a (category, country) feed. */
export function meshSetFeed(category: string, country?: string | null): void {
  if (!state.enabled || typeof window === 'undefined') return
  if (category === 'blindspots') {
    // Not a cache-backed room — mesh never serves it.
    if (state.room) {
      state.room.close()
      state.room = null
    }
    return
  }
  const roomKey = meshRoomFor(category, country)
  if (state.room && state.room.room === roomKey) return
  if (state.room) state.room.close()
  const room = new MeshRoom(category, country ?? null, notifyData)
  state.room = room
  void room.start().catch((err) => {
    logMeshEvent({ type: 'error', room: roomKey, detail: String(err).slice(0, 120) })
  })
}

/**
 * Serve a feed query from the mesh. Returns null IMMEDIATELY (no network
 * wait) when the mesh has no verified data — the caller then runs its
 * normal /api/news fetch. Cold loads are never slowed down.
 */
export function meshGetFeed(query: MeshFeedQuery): MeshFeedResponse | null {
  if (!state.enabled || typeof window === 'undefined') return null
  meshSetFeed(query.category, query.country)
  if (!state.room) return null
  return state.room.feedResponse(query)
}

/** Subscribe to verified mesh data updates (silent UI swap). */
export function onMeshData(cb: MeshDataCallback): () => void {
  state.dataCallbacks.add(cb)
  return () => state.dataCallbacks.delete(cb)
}

export function meshHealth(): { live: boolean; nodeAgeMs: number; room: string | null } {
  const room = state.room
  if (!state.enabled || !room || !room.info().nodeUpdatedAt) {
    return { live: false, nodeAgeMs: Infinity, room: room?.room ?? null }
  }
  const age = Date.now() - (room.info().nodeUpdatedAt ?? 0)
  return { live: age < MESH.STALE_NODE_MS, nodeAgeMs: age, room: room.room }
}

export function meshRoomInfo(): MeshRoomInfo {
  if (!state.room) {
    return {
      room: null,
      category: null,
      country: null,
      role: 'off',
      relayPeerId: null,
      peers: 0,
      consumers: 0,
      verifiedHash: null,
      nodeUpdatedAt: null,
      verifiedAt: null,
    }
  }
  return state.room.info()
}

/** Test seam + hard reset for /debug. */
export function meshShutdown(): void {
  state.enabled = false
  state.room?.close()
  state.room = null
}
