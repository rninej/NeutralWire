/**
 * test-mesh-parity.ts — hash-parity + signing self-test for the mesh.
 *
 * The whole mesh integrity model rests on ONE invariant: the server's
 * manifest hash (computed in Node from in-memory topics) must equal the
 * hash a client computes from the Firebase-returned node. Firebase
 * round-trips JSON through storage that (a) deletes null keys, (b) can't
 * store empty arrays, (c) returns keys alphabetically. This test
 * simulates all three transforms and asserts the hashes still match, and
 * that the ECDSA sign→verify round trip works.
 *
 * Run: bun scripts/test-mesh-parity.ts
 */

import { hashMeshNode, canonical, slimNodeForMesh, validateMeshNode, type MeshFeedNode } from '../src/lib/mesh/mesh-protocol'
import { signManifest, } from '../src/lib/mesh/mesh-sign'
import { verifyManifestForNode, verifyManifestSig } from '../src/lib/mesh/mesh-crypto'

// ── Simulate Firebase RTDB storage behavior ──
function firebaseRoundTrip(value: unknown): unknown {
  const json = JSON.stringify(value) // drops undefined
  const parsed = JSON.parse(json)
  return stripNulls(parsed)
}

function stripNulls(v: unknown): unknown {
  if (v === null || v === undefined) return undefined
  if (Array.isArray(v)) {
    // RTDB cannot store empty arrays — an [] key disappears.
    const cleaned = v.map(stripNulls)
    if (cleaned.length === 0) return undefined
    return cleaned
  }
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      const cleaned = stripNulls(val)
      if (cleaned === undefined) continue // null keys are DELETED by RTDB
      out[k] = cleaned
    }
    return out
  }
  return v
}

async function main() {
  let failures = 0
  const check = (name: string, ok: boolean) => {
    if (!ok) failures++
    console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`)
  }

  // ── 1. Server-side node (as news-cache constructs it) ──
  const serverNode: MeshFeedNode = {
    updatedAt: 1730000000000,
    sourceCount: 42,
    articleCount: 312,
    cacheVersion: 7,
    topics: [
      {
        topicId: 't-abc',
        title: 'Sample headline',
        summary: 'A summary with "quotes" and unicode — dashes.',
        imageUrl: 'https://example.com/a.jpg',
        coverage: 6,
        leanLeft: 2,
        leanCenter: 3,
        leanRight: 1,
        firstSeen: 1729990000000,
        latestSeen: 1730000000000,
        articles: [
          {
            id: 'x1',
            title: 'Article',
            link: 'https://example.com/1',
            description: 'desc',
            pubDate: null,
            iso: 1729990000000,
            imageUrl: null,
            sourceId: 'bbc',
            sourceName: 'BBC',
            sourceHomepage: 'https://bbc.co.uk',
            leaning: 'center',
            country: 'GB',
            category: 'world',
          },
        ],
        localCoverage: 2,
        boostScore: 6,
      },
      {
        topicId: 't-def',
        title: 'Second headline',
        summary: 'Another summary',
        imageUrl: null, // ← null: RTDB will DELETE this key
        coverage: 3,
        leanLeft: 3,
        leanCenter: 0,
        leanRight: 0,
        firstSeen: 1729990000000,
        latestSeen: 1730000000000,
        articles: [], // ← empty array: RTDB will DELETE this key
        // Extra pass-through field the slim normalizer preserves defensively
        // (typed via cast — TopicArticle's declared surface doesn't include it).
        ...({ videoUrl: undefined } as object),
      },
    ],
  }

  const serverHash = await hashMeshNode(serverNode)

  // ── 2. Client-side node (after Firebase round trip + key reordering) ──
  const stored = firebaseRoundTrip(serverNode)
  const clientHash = await hashMeshNode(stored as MeshFeedNode)
  check('hash parity across Firebase round-trip (null-drop, []-drop)', serverHash === clientHash)

  // Manually reordered + re-serialized keys must canonicalize identically.
  const reordered = JSON.parse(
    JSON.stringify(stored, (_k, v) => v),
  )
  const reorderedHash = await hashMeshNode(reordered as MeshFeedNode)
  check('hash parity across key reordering', serverHash === reorderedHash)

  // Double round trip stability.
  const twiceHash = await hashMeshNode(firebaseRoundTrip(stored) as MeshFeedNode)
  check('hash stable across double round-trip', serverHash === twiceHash)

  // ── 3. Tamper detection ──
  const tampered = JSON.parse(JSON.stringify(stored)) as MeshFeedNode
  tampered.topics[0].title = 'TAMPERED HEADLINE'
  const tamperHash = await hashMeshNode(tampered)
  check('tampered payload produces a different hash', tamperHash !== serverHash)

  // ── 4. Slim normalization explicitness ──
  const slimmed = slimNodeForMesh(serverNode)
  check(
    'slim topics carry articles: [] explicitly',
    slimmed.topics.every((t) => Array.isArray(t.articles) && t.articles.length === 0),
  )
  check('slim drops null imageUrl', slimmed.topics.every((t) => t.imageUrl !== null))

  // ── 5. validateMeshNode rejects garbage ──
  check('validate rejects non-object', validateMeshNode(null) === null)
  check('validate rejects missing updatedAt', validateMeshNode({ topics: [{ topicId: 'a', title: 'b' }] }) === null)
  check('validate rejects 200-topic bombs', validateMeshNode({ updatedAt: 1, topics: new Array(200).fill({ topicId: 'a', title: 'b' }) }) === null)
  const valid = validateMeshNode(stored)
  check('validate accepts the round-tripped node', valid !== null && valid.topics.length === 2)

  // ── 6. Canonical determinism vs JSON.stringify ──
  const c1 = canonical({ b: 1, a: [2, { d: 'x', c: true }] })
  const c2 = canonical({ a: [2, { c: true, d: 'x' }], b: 1 })
  check('canonical is key-order independent', c1 === c2)
  check(
    'canonical drops null-valued keys',
    canonical({ a: null, b: 1 }) === canonical({ b: 1 }),
  )

  // ── 7. ECDSA sign → verify round trip ──
  const room = 'relevant__GB'
  const sig = await signManifest(room, serverHash, 1730000000000, 7)
  check('signing produced a signature', typeof sig === 'string' && sig.length > 0)
  check('signature verifies', await verifyManifestSig(room, serverHash, 1730000000000, 7, sig))
  check('signature fails on tampered hash', !(await verifyManifestSig(room, tamperHash, 1730000000000, 7, sig)))
  check('signature fails on tampered room', !(await verifyManifestSig('relevant__US', serverHash, 1730000000000, 7, sig)))
  check('signature fails on tampered timestamp', !(await verifyManifestSig(room, serverHash, 1730000000001, 7, sig)))
  check(
    'verifyManifestForNode accepts the true manifest',
    (await verifyManifestForNode(room, { hash: serverHash, updatedAt: 1730000000000, v: 7, sig }, serverHash)).ok,
  )
  check(
    'verifyManifestForNode rejects a mismatched hash',
    !(await verifyManifestForNode(room, { hash: serverHash, updatedAt: 1730000000000, v: 7, sig }, tamperHash)).ok,
  )
  check(
    'verifyManifestForNode rejects a forged manifest (no valid sig)',
    !(await verifyManifestForNode(room, { hash: serverHash, updatedAt: 1730000000000, v: 7, sig: 'AAAA' + sig.slice(4) }, serverHash)).ok,
  )

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
