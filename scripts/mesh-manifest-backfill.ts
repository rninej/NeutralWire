/**
 * mesh-manifest-backfill.ts — one-time repair for the Sep-16 manifest path bug.
 *
 * 1. DELETE the misplaced meshManifest/newsCache/* subtree (written with the
 *    wrong path + wrong signature room string by the buggy writeMeshManifest).
 * 2. For EVERY live newsCache room, compute the slim hash + sign a manifest
 *    with the CORRECT bare room key and write it to meshManifest/<room>.
 * 3. Verify each written manifest with the CLIENT-side verifier (the same
 *    code a browser relay runs) — proving end-to-end parity.
 */
import { MESH_PATHS, hashMeshNode, validateMeshNode } from '@/lib/mesh/mesh-protocol'
import { signManifest } from '@/lib/mesh/mesh-sign'
import { verifyManifestForNode } from '@/lib/mesh/mesh-crypto'
import { firebaseRead, firebaseWrite, firebaseDelete } from '@/lib/firebase-server'

const ROOM_OVERRIDE = process.argv[2] ?? null // optional single room

async function main() {
  // ── 1. Remove the misplaced subtree ──
  const misplaced = await firebaseRead<unknown>('meshManifest/newsCache')
  if (misplaced) {
    const n = Object.keys(misplaced as object).length
    await firebaseDelete('meshManifest/newsCache')
    console.log(`✓ deleted misplaced meshManifest/newsCache/* (${n} rooms)`)
  } else {
    console.log('• no misplaced meshManifest/newsCache subtree')
  }

  // ── 2. Backfill correct manifests for every live room ──
  const rooms: string[] = ROOM_OVERRIDE
    ? [ROOM_OVERRIDE]
    : Object.keys((await firebaseRead<Record<string, unknown>>('newsCache')) ?? {})
  console.log(`backfilling ${rooms.length} rooms: ${rooms.join(', ')}`)

  let ok = 0
  let fail = 0
  for (const room of rooms) {
    if (!room || room === 'top') {
      // 'top' is not a feed room (it's a derived node) — check it exists as
      // a real node shape; skip if it doesn't validate.
    }
    const raw = await firebaseRead<Record<string, unknown>>(`newsCache/${room}`)
    if (!raw) {
      console.log(`  ✗ ${room}: no cache node`)
      fail++
      continue
    }
    const node = validateMeshNode(raw)
    if (!node) {
      console.log(`  - ${room}: invalid node shape (no topics) — skipped (mesh never serves it)`)
      continue
    }
    const hash = await hashMeshNode(node)
    const sig = await signManifest(room, hash, node.updatedAt, node.cacheVersion ?? 0)
    if (!sig) {
      console.log(`  ✗ ${room}: signing failed`)
      fail++
      continue
    }
    await firebaseWrite(MESH_PATHS.manifest(room), {
      hash,
      updatedAt: node.updatedAt,
      v: node.cacheVersion ?? 0,
      sig,
    })
    // ── 3. Verify with the CLIENT verifier (exactly what a relay runs) ──
    const manifest = await firebaseRead<unknown>(MESH_PATHS.manifest(room))
    const res = await verifyManifestForNode(room, manifest, hash)
    if (res.ok) {
      console.log(`  ✓ ${room}: manifest written + client-verified (${node.topics.length} topics)`)
      ok++
    } else {
      console.log(`  ✗ ${room}: client verification FAILED (${res.reason})`)
      fail++
    }
  }
  console.log(`\ndone: ${ok} rooms verified, ${fail} failed`)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
