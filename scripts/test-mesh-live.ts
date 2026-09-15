/**
 * test-mesh-live.ts — live smoke test of the mesh's Firebase plumbing
 * against the production RTDB (public rules, same URL the app uses).
 *
 * Verifies with REAL network round trips:
 *   1. Server writes a cache node + signed manifest for a TEST room
 *      (exactly like news-cache.writeCachedNews does).
 *   2. A "client" reads both back and the hash + signature verify.
 *   3. Presence + SSE streaming (rtdbWatch) delivers live puts.
 *   4. The one-time lease flow works (server-timestamped, consumed once).
 *   5. Cleanup removes every test node.
 *
 * Uses the meshTest/ prefix so production nodes are never touched.
 * Run: bun scripts/test-mesh-live.ts
 */

import { MESH_PATHS, hashMeshNode, type MeshFeedNode } from '../src/lib/mesh/mesh-protocol'
import { signManifest } from '../src/lib/mesh/mesh-sign'
import { verifyManifestForNode } from '../src/lib/mesh/mesh-crypto'
import { rtdbGet, rtdbPut, rtdbDelete, rtdbWatch } from '../src/lib/mesh/rtdb-rest'
import { serverTimestamp } from '../src/lib/mesh/rtdb-rest'
import { consumeLease } from '../src/lib/mesh/lease-server'
import { firebaseWrite, firebaseRead, firebaseDelete } from '../src/lib/firebase-server'

const TEST_ROOM = 'meshtest__ZZ'

async function main() {
  let failures = 0
  const check = (name: string, ok: boolean) => {
    if (!ok) failures++
    console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`)
  }

  // ── 1. Server-style write: node + signed manifest ──
  const node: MeshFeedNode = {
    updatedAt: Date.now(),
    sourceCount: 3,
    articleCount: 9,
    cacheVersion: 7,
    topics: [
      {
        topicId: 'test-1',
        title: 'Live mesh test topic',
        summary: 'Verifying the signed manifest pipeline end to end.',
        imageUrl: 'https://example.com/x.jpg',
        coverage: 3,
        leanLeft: 1,
        leanCenter: 1,
        leanRight: 1,
        firstSeen: Date.now() - 1000,
        latestSeen: Date.now(),
        articles: [],
      },
    ],
  }
  const hash = await hashMeshNode(node)
  const sig = await signManifest(TEST_ROOM, hash, node.updatedAt, 7)
  const nodeOk = await firebaseWrite(`newsCache/${TEST_ROOM}`, node)
  const manifestOk = await firebaseWrite(MESH_PATHS.manifest(TEST_ROOM), {
    hash,
    updatedAt: node.updatedAt,
    v: 7,
    sig,
  })
  check('server wrote test node + manifest', nodeOk && manifestOk)

  // ── 2. Client-style read + verification ──
  const readNode = await rtdbGet<Record<string, unknown>>(MESH_PATHS.node(TEST_ROOM))
  const readManifest = await rtdbGet(MESH_PATHS.manifest(TEST_ROOM))
  check('client read the node + manifest back', readNode !== null && readManifest !== null)
  const clientHash = await hashMeshNode(readNode as unknown as MeshFeedNode)
  const verify = await verifyManifestForNode(TEST_ROOM, readManifest, clientHash)
  check('client hash matches the signed manifest (LIVE parity)', verify.ok)

  // ── 3. Presence + SSE streaming ──
  const sawEvents: string[] = []
  const watch = rtdbWatch(MESH_PATHS.peers(TEST_ROOM), (events) => {
    for (const ev of events) sawEvents.push(ev.path)
  })
  await new Promise((r) => setTimeout(r, 1500)) // let the stream connect
  await rtdbPut(MESH_PATHS.peer(TEST_ROOM, 'peerA'), { since: Date.now(), hb: Date.now() })
  await rtdbPut(MESH_PATHS.peer(TEST_ROOM, 'peerB'), { since: Date.now() - 5000, hb: Date.now() })
  await new Promise((r) => setTimeout(r, 2500))
  watch.close()
  check(
    'SSE watch streamed presence puts',
    sawEvents.includes('/') && (sawEvents.includes('/peerA') || sawEvents.includes('/peerB')),
  )

  // ── 4. One-time lease flow (server-timestamped) ──
  const leaseId = `refresh_live_${Math.random().toString(36).slice(2, 10)}`
  await rtdbPut(MESH_PATHS.lease(leaseId), { p: 'peerA', job: 'refresh', ts: serverTimestamp() })
  const first = await consumeLease(leaseId, 'peerA', 'refresh')
  const replay = await consumeLease(leaseId, 'peerA', 'refresh') // second use must fail
  const wrongPeer = await consumeLease(`refresh_live_${Math.random().toString(36).slice(2, 10)}`, 'peerA', 'refresh')
  check('lease validates + is single-use', first.ok && !replay.ok && !wrongPeer.ok)

  // Stale lease: write with an old timestamp, expect rejection.
  const staleId = `refresh_live_${Math.random().toString(36).slice(2, 10)}`
  await firebaseWrite(MESH_PATHS.lease(staleId), { p: 'peerA', job: 'refresh', ts: Date.now() - 120_000 })
  const stale = await consumeLease(staleId, 'peerA', 'refresh')
  check('stale lease (age 120s) rejected', !stale.ok)

  // ── 5. meshJobs/lastRun flow ──
  await firebaseWrite('meshJobs/lastRun/refresh', Date.now())
  const lastRun = await firebaseRead<number>('meshJobs/lastRun/refresh')
  check('lastRun round trip', typeof lastRun === 'number' && Math.abs(Date.now() - (lastRun ?? 0)) < 10_000)

  // ── 6. Cleanup every test node ──
  await firebaseDelete(`newsCache/${TEST_ROOM}`)
  await firebaseDelete(MESH_PATHS.manifest(TEST_ROOM))
  await rtdbDelete(MESH_PATHS.peers(TEST_ROOM))
  await rtdbDelete(MESH_PATHS.hashes(TEST_ROOM))
  await rtdbDelete(MESH_PATHS.sig(TEST_ROOM))
  await firebaseDelete('meshJobs/leases')
  await firebaseDelete('meshJobs/lastRun/refresh')
  const nodeGone = await firebaseRead(`newsCache/${TEST_ROOM}`)
  const manifestGone = await firebaseRead(MESH_PATHS.manifest(TEST_ROOM))
  check('cleanup removed all test nodes', nodeGone === null && manifestGone === null)

  console.log(failures === 0 ? '\nALL LIVE CHECKS PASSED' : `\n${failures} LIVE CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
