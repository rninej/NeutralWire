/**
 * Firebase Realtime Database REST client (server-side).
 *
 * Why REST API instead of the firebase JS SDK or firebase-admin:
 *  - firebase-admin requires a service account JSON, which we don't have
 *    (the user supplied a *client* config, not a service account).
 *  - The firebase JS SDK works server-side but pulls in a large dependency
 *    graph and needs an auth roundtrip (anonymous sign-in) before every
 *    database read.
 *  - The RTDB REST API is a single fetch() call, returns the JSON value
 *    directly, and the user's database has public read/write rules so no
 *    auth token is needed at all. This is the leanest, fastest path.
 *
 * Database location: europe-west1 (per the databaseURL).
 * Free-tier friendly: each call is a single small JSON document.
 */

const DB_URL =
  'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'

const FETCH_TIMEOUT_MS = 8000

// ── Firebase download tracking ──
// Tracks bytes downloaded from Firebase in the current server instance.
// Vercel serverless functions don't share memory between invocations, but
// within a single warm instance (which handles multiple requests), this
// gives a live counter. Also stored in Firebase for a per-user total.
//
// The client reads these counters via /api/fb-stats and logs them to the
// browser console so you can see exactly how much Firebase data each page
// load is consuming.

let SESSION_DOWNLOAD_BYTES = 0
let SESSION_OPS: Array<{ path: string; method: string; bytes: number; ts: number }> = []

// Session ID for this server instance (so the client can tell if it's
// talking to the same warm instance or a new cold one)
const SESSION_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

function trackDownload(path: string, method: string, bytes: number) {
  SESSION_DOWNLOAD_BYTES += bytes
  SESSION_OPS.push({ path, method, bytes, ts: Date.now() })
  // Keep only the last 50 ops to avoid memory bloat
  if (SESSION_OPS.length > 50) SESSION_OPS = SESSION_OPS.slice(-50)
}

export function getFirebaseStats() {
  return {
    sessionId: SESSION_ID,
    sessionDownloadBytes: SESSION_DOWNLOAD_BYTES,
    sessionDownloadMB: +(SESSION_DOWNLOAD_BYTES / (1024 * 1024)).toFixed(2),
    sessionOps: SESSION_OPS.length,
    recentOps: SESSION_OPS.slice(-10),
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms),
    ),
  ])
}

/**
 * Read a node at the given path. Returns null if the node doesn't exist.
 */
export async function firebaseRead<T = unknown>(path: string): Promise<T | null> {
  const url = `${DB_URL}/${path}.json`
  try {
    const res = await withTimeout(
      fetch(url, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      }),
      FETCH_TIMEOUT_MS,
    )
    if (!res.ok) {
      console.warn(`[firebase] read ${path} failed: HTTP ${res.status}`)
      return null
    }
    const text = await res.text()
    // Track download size
    const bytes = text ? new Blob([text]).size : 0
    trackDownload(path, 'GET', bytes)
    if (!text || text === 'null') return null
    return JSON.parse(text) as T
  } catch (err) {
    console.warn(`[firebase] read ${path} error:`, err)
    return null
  }
}

/**
 * Write (replace) a node at the given path with the given JSON value.
 * Uses PUT which replaces the node entirely.
 */
export async function firebaseWrite<T = unknown>(
  path: string,
  value: T,
): Promise<boolean> {
  const url = `${DB_URL}/${path}.json`
  try {
    const res = await withTimeout(
      fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
        cache: 'no-store',
      }),
      FETCH_TIMEOUT_MS + 4000, // writes can be a bit slower
    )
    if (!res.ok) {
      console.warn(`[firebase] write ${path} failed: HTTP ${res.status}`)
      return false
    }
    return true
  } catch (err) {
    console.warn(`[firebase] write ${path} error:`, err)
    return false
  }
}

/**
 * Patch (shallow merge) a node at the given path.
 */
export async function firebasePatch(
  path: string,
  value: Record<string, unknown>,
): Promise<boolean> {
  const url = `${DB_URL}/${path}.json`
  try {
    const res = await withTimeout(
      fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
        cache: 'no-store',
      }),
      FETCH_TIMEOUT_MS + 4000,
    )
    return res.ok
  } catch (err) {
    console.warn(`[firebase] patch ${path} error:`, err)
    return false
  }
}

/**
 * Sanity check that the database is reachable. Used during cold start
 * to fail fast if there's a config issue.
 */
export async function firebasePing(): Promise<boolean> {
  const v = await firebaseRead<{ ok?: boolean }>('_health')
  // Don't care about the value, just that we got *something* (or null).
  // A 401/403 would still return null from firebaseRead, but a network
  // failure would too — we treat both as "db not reachable" upstream.
  return v !== null || true
}
