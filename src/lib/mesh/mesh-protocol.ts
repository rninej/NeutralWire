/**
 * mesh-protocol.ts — shared constants + canonicalization for the
 * NeutralWire P2P mesh relay (experimental).
 *
 * WHAT THE MESH IS
 * ================
 * Visitors relay news feeds DIRECTLY to each other over WebRTC data
 * channels, keyed per feed room (one room per Firebase cache path, so
 * different countries / categories never mix). One relay user per room
 * reads the feed from Firebase (or triggers the normal /api/news path)
 * and serves every other visitor in that room — server (Vercel) cost per
 * feed drops from O(users) to O(rooms).
 *
 * INTEGRITY MODEL (why this file exists)
 * ======================================
 * The Firebase RTDB has PUBLIC read/write rules, so nothing stored there
 * is trustworthy-by-storage. The mesh therefore binds every relayed
 * payload to a MANIFEST written by the server at cache-write time
 * (news-cache.ts → writeCachedNews):
 *
 *   meshManifest/<room> = { hash, updatedAt, v, sig }
 *     hash = SHA-256 of canonicalJSON(slim cache node)
 *     sig  = ECDSA P-256 signature over "<room>|<hash>|<updatedAt>|<v>",
 *            signed with the server-only private key (mesh-sign.ts).
 *
 * Clients verify the signature with the embedded PUBLIC key
 * (mesh-crypto.ts) — a forged manifest is computationally impossible
 * even though the database is public-write. A relayed node is accepted
 * ONLY when the receiver's own recomputed hash matches the (verified)
 * manifest hash. At high peer counts, verification switches to
 * 3-RANDOM-PEER consensus (peerHashes written to Firebase) with a
 * periodic signed-manifest anchor, exactly as specified.
 *
 * HASH PARITY (server Node ↔ client browser)
 * ===========================================
 * Both sides hash the SAME logical value, produced by the SAME function
 * (slimNodeForMesh) in this file. Two Firebase quirks make naive
 * hashing diverge, and canonical() neutralizes both:
 *   1. RTDB DELETEs keys whose value is null      → canonical drops null.
 *   2. RTDB cannot store empty arrays ([])        → slimNodeForMesh
 *      re-adds `articles: []` explicitly on both sides.
 * Key order also differs (RTDB returns alphabetical) → canonical sorts
 * keys. Numbers below 1e21 stringify identically everywhere.
 */

import type { TopicArticle } from '@/lib/news-aggregator'

// ── Firebase RTDB (public client config — same URL layout.tsx
//    preconnects to; safe to embed client-side) ──
export const RTDB_URL =
  'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'

// ── Tuning constants ──
export const MESH = {
  /** Presence heartbeat write interval (per room). */
  HEARTBEAT_MS: 10_000,
  /** A peer with no heartbeat for this long is considered gone. */
  PEER_STALE_MS: 35_000,
  /** Strict timeout for a mesh-served fetch; on expiry the caller falls
   *  back to the normal /api/news request. Never slows a cold load —
   *  mesh fetches only run when a live connection already exists. */
  FETCH_TIMEOUT_MS: 2_200,
  /** WebRTC connection establishment budget. */
  CONNECT_TIMEOUT_MS: 7_000,
  /** Room population at/above which verification switches from the
   *  signed Firebase manifest to 3-random-peer consensus. */
  CONSENSUS_MIN_PEERS: 12,
  /** How long a peerHash entry stays "fresh" for consensus purposes. */
  PEER_HASH_TTL_MS: 150_000,
  /** Re-verify against the signed manifest at least this often, even in
   *  consensus mode (bounds any slow-collusion window). */
  MANIFEST_ANCHOR_MS: 5 * 60_000,
  /** Relay polls the manifest hash for feed updates on this cadence. */
  MANIFEST_POLL_MS: 60_000,
  /** Max age of a node before consumers ask the relay to refresh. */
  STALE_NODE_MS: 40 * 60_000,
  /** Min gap between refresh-reqs the relay honors (per room). */
  REFRESH_REQ_GAP_MS: 2.5 * 60_000,
  /** Max size of a reassembled mesh message (payload cap). */
  MAX_MESSAGE_BYTES: 3 * 1024 * 1024,
  /** Data-channel chunk size (stay well under SCTP safe limits). */
  CHUNK_BYTES: 48 * 1024,
  /** Inbound message rate cap per channel before we drop the peer. */
  MSG_RATE_LIMIT_PER_SEC: 120,
  /** Max mesh log entries kept in Firebase (trimmed opportunistically). */
  LOG_MAX_ENTRIES: 250,
} as const

// ── Firebase paths used by the mesh ──
export const MESH_PATHS = {
  peers: (room: string) => `mesh/${room}/peers`,
  peer: (room: string, peerId: string) => `mesh/${room}/peers/${peerId}`,
  hashes: (room: string) => `mesh/${room}/hashes`,
  hash: (room: string, peerId: string) => `mesh/${room}/hashes/${peerId}`,
  sig: (room: string) => `mesh/${room}/sig`,
  sigOf: (room: string, peerId: string) => `mesh/${room}/sig/${peerId}`,
  manifest: (room: string) => `meshManifest/${room}`,
  node: (room: string) => `newsCache/${room}`,
  logs: 'meshLogs',
  cronPeers: 'meshCron/peers',
  cronPeer: (peerId: string) => `meshCron/peers/${peerId}`,
  jobs: 'meshJobs',
  lease: (leaseId: string) => `meshJobs/leases/${leaseId}`,
  lastRun: (job: string) => `meshJobs/lastRun/${job}`,
} as const

/**
 * Room key for a (category, country) feed — mirrors cachePath() in
 * news-cache.ts: virtual categories (relevant / mycountry) are per
 * country, everything else is global. Country feeds therefore never mix.
 */
export function meshRoomFor(
  category: string,
  country?: string | null,
): string {
  const cat = (category || 'relevant').toLowerCase()
  if (cat === 'relevant' || cat === 'mycountry') {
    const c = (country || 'INT').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'INT'
    return `${cat}__${c}`
  }
  return cat
}

// ── Wire payload types ──

/** A slim cache node — topics carry all display fields, articles: []. */
export interface MeshFeedNode {
  updatedAt: number
  sourceCount: number
  articleCount: number
  cacheVersion?: number
  topics: TopicArticle[]
}

/** Server-signed manifest stored at meshManifest/<room>. */
export interface MeshManifest {
  hash: string
  updatedAt: number
  v: number
  sig: string
}

/** A peer's published (verified) hash — consensus building block. */
export interface MeshPeerHash {
  h: string
  u: number
  ts: number
}

// ── Canonical JSON + hashing (hash-parity critical!) ──

/**
 * Deterministic JSON: object keys sorted, undefined AND null values
 * dropped, numbers/strings/booleans/arrays as-is. Must NEVER change
 * format once manifests ship — bump a version marker if it ever must.
 */
export function canonical(value: unknown): string {
  return _canon(value)
}

function _canon(v: unknown): string {
  if (v === null || v === undefined) return '∅' // dropped at parent level
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '"NaN"'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) {
    // null/undefined INSIDE arrays are preserved as ∅ (RTDB cannot store
    // them; slimNodeForMesh never produces them, so parity holds).
    return `[${v.map((x) => _canon(x)).join(',')}]`
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>)
      .filter((k) => {
        const val = (v as Record<string, unknown>)[k]
        return val !== undefined && val !== null
      })
      .sort()
    if (keys.length === 0) return '{}'
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${_canon((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return '"∅"'
}

/** SHA-256 hex of a string (WebCrypto — available server + client). */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Hash of a slim node — the value the manifest's `hash` field carries. */
export async function hashMeshNode(node: MeshFeedNode): Promise<string> {
  return sha256Hex(canonical(slimNodeForMesh(node)))
}

// ── Slim normalization (hash-parity critical!) ──
//
// Explicit field list — identical on server (in-memory topics) and client
// (Firebase-returned topics). Optional fields are omitted when nullish
// (canonical drops null on both sides, matching RTDB's null-key deletion);
// `articles` is ALWAYS an explicit empty array.

const TOPIC_STRING_FIELDS = [
  'topicId',
  'title',
  'summary',
  'imageUrl',
  'videoUrl',
  'videoId',
  'blindspotSide',
] as const
const TOPIC_NUMBER_FIELDS = [
  'coverage',
  'leanLeft',
  'leanCenter',
  'leanRight',
  'firstSeen',
  'latestSeen',
  'localCoverage',
  'blindspotPct',
  'totalArticles',
  'totalNewsrooms',
  'boostScore',
  'videoDuration',
] as const

export function slimTopicForMesh(raw: unknown): TopicArticle | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const t: Record<string, unknown> = { articles: [] }
  for (const k of TOPIC_STRING_FIELDS) {
    const v = r[k]
    if (typeof v === 'string' && v.length > 0) t[k] = v
  }
  for (const k of TOPIC_NUMBER_FIELDS) {
    const v = r[k]
    if (typeof v === 'number' && Number.isFinite(v)) t[k] = v
  }
  if (typeof t.topicId !== 'string' || typeof t.title !== 'string') return null
  return t as unknown as TopicArticle
}

export function slimNodeForMesh(node: MeshFeedNode): MeshFeedNode {
  const topics = (Array.isArray(node.topics) ? node.topics : [])
    .map(slimTopicForMesh)
    .filter((t): t is TopicArticle => t !== null)
  return {
    updatedAt: typeof node.updatedAt === 'number' ? node.updatedAt : 0,
    sourceCount: typeof node.sourceCount === 'number' ? node.sourceCount : 0,
    articleCount: typeof node.articleCount === 'number' ? node.articleCount : 0,
    ...(typeof node.cacheVersion === 'number' ? { cacheVersion: node.cacheVersion } : {}),
    topics,
  }
}

/**
 * Structural validation of a node received from a peer (pre-hash).
 * Malformed payloads are dropped, logged, and the caller falls back to
 * the normal server fetch — bad data can never reach the UI.
 */
export function validateMeshNode(raw: unknown): MeshFeedNode | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.updatedAt !== 'number' || r.updatedAt <= 0) return null
  if (!Array.isArray(r.topics) || r.topics.length === 0) return null
  if (r.topics.length > 120) return null // sanity cap (cache holds ≤ 60)
  const slim = slimNodeForMesh(raw as MeshFeedNode)
  if (slim.topics.length === 0) return null
  return slim
}

// ── Wire messages (data channel) ──

export type MeshWireMessage =
  | { t: 'get' } // consumer → relay: request current snapshot
  | { t: 'refresh-req' } // consumer → relay: feed is stale, please refresh
  | { t: 'ping' }
  | { t: 'pong' }
  | { t: 'snap'; node: MeshFeedNode } // relay → consumer: full snapshot
  | { t: 'upd'; node: MeshFeedNode } // relay → consumer: updated node

/** Envelope for chunked transfer of large messages. */
export interface MeshChunkFrame {
  t: 'm'
  /** Reassembly id (random per message). */
  id: string
  seq: number
  tot: number
  /** JSON fragment of the serialized original message. */
  s: string
}

// ── Presence types ──

export interface MeshPeerEntry {
  since: number
  hb: number
}

/** Extract a "live" peer list from a presence snapshot (client clock). */
export function livePeers(
  peers: Record<string, MeshPeerEntry | null>,
  now = Date.now(),
): Array<{ peerId: string; since: number }> {
  const out: Array<{ peerId: string; since: number }> = []
  for (const [peerId, entry] of Object.entries(peers)) {
    if (!entry || typeof entry.hb !== 'number') continue
    if (now - entry.hb > MESH.PEER_STALE_MS) continue
    if (typeof entry.since !== 'number') continue
    out.push({ peerId, since: entry.since })
  }
  return out
}

/**
 * Deterministic relay election: the live peer with the EARLIEST `since`
 * (ties broken by smallest peerId) is the relay. Every client computes
 * the same result from the same presence snapshot — when the relay
 * leaves (heartbeat goes stale), the next-oldest peer automatically
 * takes over and everyone reconnects to it.
 */
export function electRelay(
  peers: Array<{ peerId: string; since: number }>,
): string | null {
  if (peers.length === 0) return null
  const sorted = [...peers].sort(
    (a, b) => a.since - b.since || (a.peerId < b.peerId ? -1 : 1),
  )
  return sorted[0].peerId
}

// ── Mesh log event types (records bugs / unwanted switches for /debug) ──

export type MeshLogType =
  | 'join'
  | 'leave'
  | 'promote'
  | 'relay-switch'
  | 'connect'
  | 'disconnect'
  | 'served'
  | 'fallback-timeout'
  | 'fallback-no-relay'
  | 'fallback-no-data'
  | 'verify-ok'
  | 'verify-manifest-miss'
  | 'verify-manifest-bad'
  | 'verify-consensus-fail'
  | 'malformed'
  | 'rate-abuse'
  | 'stale-reject'
  | 'refresh-req'
  | 'refresh-served'
  | 'cron-trigger'
  | 'cron-skip'
  | 'error'

export interface MeshLogEvent {
  type: MeshLogType
  room: string
  detail?: string
  peerId?: string
}
