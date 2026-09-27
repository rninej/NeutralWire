/**
 * mesh-crypto.ts — CLIENT-side manifest signature verification.
 *
 * Holds only the PUBLIC half of the mesh signing keypair (ECDSA P-256).
 * The private half lives in mesh-sign.ts, which is imported exclusively
 * by server code (news-cache.ts). A client — or any database write —
 * cannot forge a manifest that passes verification, because RTDB's
 * public rules let anyone WRITE a manifest node but nobody compute a
 * valid signature for it.
 */

const MESH_PUBLIC_JWK: JsonWebKey = {
  kty: 'EC',
  crv: 'P-256',
  x: 'OdLABW-3o2CpBXaKOPiaynwUbr40k0qsT56KUL_2t5Q',
  y: 'WoAcggr8dJE6GUjFBOfUkgnF3dGTPN8ol6RrwXDZJT0',
  ext: true,
  key_ops: ['verify'],
}

let cachedKey: CryptoKey | null = null

async function getVerifyKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey
  cachedKey = await globalThis.crypto.subtle.importKey(
    'jwk',
    MESH_PUBLIC_JWK,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  )
  return cachedKey
}

/** The exact string that gets signed / verified. */
export function manifestSignPayload(
  room: string,
  hash: string,
  updatedAt: number,
  v: number,
): string {
  return `${room}|${hash}|${updatedAt}|${v}`
}

function b64ToBytes(b64: string): Uint8Array {
  const bin =
    typeof atob === 'function'
      ? atob(b64)
      : Buffer.from(b64, 'base64').toString('binary')
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/**
 * Verify a manifest's ECDSA signature. Returns false for any malformed
 * input — callers treat that as "verification failed" and fall back to
 * the direct server fetch.
 */
export async function verifyManifestSig(
  room: string,
  hash: string,
  updatedAt: number,
  v: number,
  sigB64: unknown,
): Promise<boolean> {
  if (typeof sigB64 !== 'string' || !sigB64) return false
  if (typeof hash !== 'string' || hash.length !== 64) return false
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return false
  if (typeof v !== 'number' || !Number.isFinite(v)) return false
  try {
    const key = await getVerifyKey()
    const data = new TextEncoder().encode(
      manifestSignPayload(room, hash, updatedAt, v),
    )
    return await globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      b64ToBytes(sigB64) as unknown as ArrayBuffer,
      data as unknown as ArrayBuffer,
    )
  } catch {
    return false
  }
}

/**
 * Full manifest check for a room: signature valid AND the hash the
 * receiver computed matches the signed hash.
 */
export async function verifyManifestForNode(
  room: string,
  manifest: unknown,
  nodeHash: string,
): Promise<{ ok: boolean; reason?: 'missing' | 'bad-sig' | 'mismatch' }> {
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, reason: 'missing' }
  }
  const m = manifest as { hash?: unknown; updatedAt?: unknown; v?: unknown; sig?: unknown }
  if (typeof m.hash !== 'string' || typeof m.sig !== 'string') {
    return { ok: false, reason: 'missing' }
  }
  const sigOk = await verifyManifestSig(
    room,
    m.hash,
    typeof m.updatedAt === 'number' ? m.updatedAt : 0,
    typeof m.v === 'number' ? m.v : 0,
    m.sig,
  )
  if (!sigOk) return { ok: false, reason: 'bad-sig' }
  if (m.hash !== nodeHash) return { ok: false, reason: 'mismatch' }
  return { ok: true }
}
