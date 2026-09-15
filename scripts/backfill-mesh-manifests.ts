/**
 * backfill-mesh-manifests.ts — one-time activation for existing caches.
 *
 * writeCachedNews signs a meshManifest/<room> on every write from now
 * on — but rooms cached BEFORE the mesh deploy have no manifest, so the
 * P2P relay would stay dark for up to one cache-TTL (30 min) after
 * deploy. This script backfills: for every newsCache/<room> it reads the
 * node AS STORED (the same bytes a relay reads), computes the shared
 * slim-node hash, signs it with the mesh private key, and writes the
 * manifest. Idempotent — safe to re-run anytime.
 *
 * Run: bun scripts/backfill-mesh-manifests.ts
 */

import { firebaseRead, firebaseWrite } from '../src/lib/firebase-server'
import { hashMeshNode, validateMeshNode, type MeshFeedNode, type MeshManifest } from '../src/lib/mesh/mesh-protocol'
import { signManifest } from '../src/lib/mesh/mesh-sign'
import { verifyManifestForNode } from '../src/lib/mesh/mesh-crypto'

async function main() {
  const rooms = await firebaseRead<Record<string, unknown>>('newsCache')
  if (!rooms) {
    console.log('No newsCache rooms found — nothing to backfill.')
    return
  }
  const keys = Object.keys(rooms)
  console.log(`Found ${keys.length} cache rooms: ${keys.join(', ')}`)

  let written = 0
  let skipped = 0
  let verified = 0

  for (const room of keys) {
    // Skip non-room metadata keys defensively (rooms are objects with topics).
    const raw = rooms[room]
    if (!raw || typeof raw !== 'object') {
      skipped++
      continue
    }
    const node = validateMeshNode(raw)
    if (!node) {
      console.log(`SKIP ${room} — node failed validation (no topics?)`)
      skipped++
      continue
    }

    // Existing valid manifest → leave untouched (server-signed freshness).
    const existing = await firebaseRead<MeshManifest>(`meshManifest/${room}`)
    if (existing?.sig && existing?.hash) {
      const res = await verifyManifestForNode(room, existing, existing.hash)
      if (res.ok) {
        verified++
        continue
      }
    }

    const hash = await hashMeshNode(node as MeshFeedNode)
    const sig = await signManifest(room, hash, node.updatedAt, node.cacheVersion ?? 0)
    if (!sig) {
      console.log(`FAIL ${room} — signing failed`)
      skipped++
      continue
    }
    const ok = await firebaseWrite(`meshManifest/${room}`, {
      hash,
      updatedAt: node.updatedAt,
      v: node.cacheVersion ?? 0,
      sig,
    })
    if (ok) {
      // Read-back verification — the relay's exact path.
      const written = await firebaseRead<MeshManifest>(`meshManifest/${room}`)
      const storedNode = await firebaseRead<Record<string, unknown>>(`newsCache/${room}`)
      const storedHash = await hashMeshNode(storedNode as unknown as MeshFeedNode)
      const res = await verifyManifestForNode(room, written, storedHash)
      console.log(
        `OK   ${room} — ${node.topics.length} topics, manifest signed + verified on read-back${res.ok ? '' : ' (READ-BACK VERIFY FAILED!)'}`,
      )
      if (res.ok) verified++
    } else {
      console.log(`FAIL ${room} — Firebase write failed`)
      skipped++
    }
    if (ok) written++
  }

  console.log(`\nBackfill complete: ${written} written, ${verified} verified, ${skipped} skipped`)
}

main()
