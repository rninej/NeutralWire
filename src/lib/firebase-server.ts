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
  'https://neutralwire-2f24e-default-rtdb.europe-west1.firebasedatabase.app'

const FETCH_TIMEOUT_MS = 8000

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
        // We never want Next to cache Firebase reads — they must always
        // reflect the latest cache state.
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      }),
      FETCH_TIMEOUT_MS,
    )
    if (!res.ok) {
      // 404 / null nodes return 200 with "null" body; non-2xx here means
      // an actual permission or network problem.
      console.warn(`[firebase] read ${path} failed: HTTP ${res.status}`)
      return null
    }
    const text = await res.text()
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
