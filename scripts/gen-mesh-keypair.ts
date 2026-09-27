// Module marker (keeps this script's top-level scope out of the global
// script namespace when tsc type-checks the repo).
export {}

/**
 * One-time generator for the mesh manifest signing keypair (ECDSA P-256).
 *
 * The mesh relay system signs feed manifests server-side (private key,
 * src/lib/mesh/mesh-sign.ts) and clients verify them with the embedded
 * public key (src/lib/mesh/mesh-crypto.ts). Because the Firebase RTDB has
 * public read/write rules, ANY client could forge an unsigned manifest —
 * the ECDSA signature is what makes manifest entries unforgeable even on
 * a fully public database.
 *
 * Run: bun scripts/gen-mesh-keypair.ts
 * Output: two JWK strings to paste into mesh-sign.ts / mesh-crypto.ts.
 */

async function main() {
  const { subtle } = globalThis.crypto
  const pair = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const privJwk = await subtle.exportKey('jwk', pair.privateKey)
  const pubJwk = await subtle.exportKey('jwk', pair.publicKey)
  // Compact single-line JWKs for embedding.
  const compact = (j: JsonWebKey) =>
    JSON.stringify({
      kty: j.kty,
      crv: j.crv,
      x: j.x,
      y: j.y,
      ...(j.d ? { d: j.d } : {}),
      ext: true,
      key_ops: j.d ? ['sign'] : ['verify'],
    })
  console.log('PRIVATE (mesh-sign.ts):\n' + compact(privJwk))
  console.log('\nPUBLIC (mesh-crypto.ts):\n' + compact(pubJwk))

  // Round-trip self-test: sign + verify with the exported keys.
  const data = new TextEncoder().encode('neutralwire-mesh-selftest')
  const sig = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.privateKey,
    data,
  )
  const ok = await subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.publicKey,
    sig,
    data,
  )
  console.log('\nself-test verify:', ok)
}

main()
