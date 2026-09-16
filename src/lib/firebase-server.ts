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
 *
 * ── ETag conditional reads (the 6.2GB/month bandwidth fix, Sep 2026) ──
 * Verified live against this database:
 *   GET  <path>.json        + X-Firebase-ETag: true   → 200 + ETag header
 *   GET  <path>.json        + If-None-Match: <etag>   → 304, Content-Length: 0
 *
 * Feed rooms are 130-330KB and only change every ~30 min (refresh); the
 * devices / title-rewrites / searchIndex / topicBoost trees are similarly
 * write-rare. Previously EVERY request re-downloaded the full node —
 * with `cache: 'no-store'` on the client defeating the Vercel CDN, a
 * single page load cost ~1MB+ of Firebase downloads (and the background
 * archiver up to 6MB). Now every warm serverless instance keeps a small
 * path→{etag,value} cache: repeat reads of unchanged nodes return from
 * memory after a zero-byte 304 probe.
 *
 * Correctness: an ETag is only honored by Firebase when the node's data
 * is byte-identical, so a 304 can never serve stale data. Writes through
 * this module invalidate their own path (another instance's write simply
 * changes the ETag → the next probe returns 200 with fresh data).
 */

const DB_URL =
  'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'

const FETCH_TIMEOUT_MS = 8000

// ── Firebase download tracking ──
// Tracks bytes downloaded from Firebase in the current server instance.
// Vercel serverless functions don't share memory between invocations, but
// within a single warm instance (which handles multiple requests), this
// gives a live counter.
//
// The client reads these counters via /api/fb-stats and logs them to the
// browser console so you can see exactly how much Firebase data each page
// load is consuming — including how much the ETag cache SAVED (bytes that
// would have been downloaded on the pre-fix code path).

let SESSION_DOWNLOAD_BYTES = 0
let SESSION_SAVED_BYTES = 0
let SESSION_304_HITS = 0
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
    sessionSavedBytes: SESSION_SAVED_BYTES,
    sessionSavedMB: +(SESSION_SAVED_BYTES / (1024 * 1024)).toFixed(2),
    etag304Hits: SESSION_304_HITS,
    etagCacheEntries: ETAG_CACHE.size,
    etagCacheBytes: etagCacheBytes,
    sessionOps: SESSION_OPS.length,
    recentOps: SESSION_OPS.slice(-10),
  }
}

// ── ETag conditional-read cache ─────────────────────────────────────
// path → { etag, value, ts, size }. Bounded by total cached bytes so a
// warm instance never balloons; evicts oldest-inserted first (Map keeps
// insertion order — good enough LRU for our read patterns).

interface EtagEntry {
  etag: string | null
  value: unknown
  ts: number
  size: number
}

const ETAG_CACHE = new Map<string, EtagEntry>()
const ETAG_CACHE_MAX_BYTES = 12 * 1024 * 1024 // ~12MB of cached node values
let etagCacheBytes = 0

function etagStore(path: string, etag: string | null, value: unknown, size: number) {
  const existing = ETAG_CACHE.get(path)
  if (existing) {
    etagCacheBytes -= existing.size
    ETAG_CACHE.delete(path)
  }
  ETAG_CACHE.set(path, { etag, value, ts: Date.now(), size })
  etagCacheBytes += size
  // Evict oldest entries while over budget
  while (etagCacheBytes > ETAG_CACHE_MAX_BYTES && ETAG_CACHE.size > 1) {
    const oldest = ETAG_CACHE.keys().next().value as string | undefined
    if (oldest === undefined) break
    const entry = ETAG_CACHE.get(oldest)
    ETAG_CACHE.delete(oldest)
    etagCacheBytes -= entry?.size ?? 0
  }
}

/** Invalidate a path after a local write (value/etag unknown → re-probe). */
function etagInvalidate(path: string) {
  const existing = ETAG_CACHE.get(path)
  if (existing) {
    etagCacheBytes -= existing.size
    ETAG_CACHE.delete(path)
  }
}

/** Invalidate a path AND set its expected new value (PUT replaces it). */
function etagInvalidatePut(path: string) {
  // We could optimistically store the PUT value, but its new ETag is
  // unknown — store nothing; the next read pays one full GET and re-caches.
  etagInvalidate(path)
}

// In-flight read dedup: concurrent reads of the same path share one fetch
// (e.g. /api/news + the archiver reading the same room in one tick).
const IN_FLIGHT = new Map<string, Promise<unknown>>()

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
 * Never throws.
 *
 * Uses the ETag cache: when this instance has read the path before and
 * the data is unchanged upstream, the request costs ZERO downloaded bytes
 * (HTTP 304). Also NORMALIZES repeated concurrent reads into one fetch.
 *
 * ⚠ The returned value is a SHARED cached object (on 304 hits). Callers
 * must not mutate it in ways that change semantics — the one in-repo
 * mutation (readCachedNews's idempotent imageUrl normalization) is
 * reviewed and safe. Mutate-then-return callers should clone first.
 */
export async function firebaseRead<T = unknown>(path: string): Promise<T | null> {
  const inflight = IN_FLIGHT.get(path)
  if (inflight) return inflight as Promise<T | null>

  const p = doFirebaseRead<T>(path).finally(() => IN_FLIGHT.delete(path))
  IN_FLIGHT.set(path, p)
  return p
}

async function doFirebaseRead<T = unknown>(path: string): Promise<T | null> {
  const url = `${DB_URL}/${path}.json`
  try {
    const cached = ETAG_CACHE.get(path)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (cached?.etag) {
      headers['If-None-Match'] = cached.etag
    } else {
      // Ask Firebase to include the ETag so future reads can go conditional.
      headers['X-Firebase-ETag'] = 'true'
    }

    const res = await withTimeout(
      fetch(url, {
        cache: 'no-store',
        headers,
      }),
      FETCH_TIMEOUT_MS,
    )

    // ── 304: data unchanged since our last read → serve from memory ──
    if (res.status === 304 && cached) {
      SESSION_304_HITS++
      SESSION_SAVED_BYTES += cached.size
      trackDownload(path, 'GET304', 0)
      return cached.value as T | null
    }

    if (!res.ok) {
      console.warn(`[firebase] read ${path} failed: HTTP ${res.status}`)
      return null
    }

    const etag = res.headers.get('etag')
    const text = await res.text()
    // Track download size
    const bytes = text ? new Blob([text]).size : 0
    trackDownload(path, 'GET', bytes)
    if (!text || text === 'null') {
      // Cache the "absent" result too (Firebase emits an ETag even for
      // null nodes — "null_etag") so repeat probes of missing paths are
      // also free.
      etagStore(path, etag, null, Math.max(bytes, 4))
      return null
    }
    const value = JSON.parse(text) as T
    etagStore(path, etag, value, Math.max(bytes, 4))
    return value
  } catch (err) {
    console.warn(`[firebase] read ${path} error:`, err)
    return null
  }
}

/**
 * Shallow-read a node's CHILD KEY NAMES (bytes, not KB).
 *
 * NOTE: Firebase REJECTS shallow queries combined with ETag probes
 * (verified live: HTTP 400 "Mixing 'shallow' and etag requests is not
 * supported") — so this is a plain GET with no conditional-request
 * support. Callers memoize results (listCacheKeys: 60s; listArchiveIds:
 * 2 min) to keep repeat calls cheap.
 *
 * ⚠ The archive key listing is ~313KB at ~2.5k archived topics — it is
 * ONLY used by the search-index backfill (rare, user-initiated). The
 * archive-batch endpoint deliberately does NOT use it.
 */
export async function firebaseReadShallow(path: string): Promise<string[]> {
  const url = `${DB_URL}/${path}.json?shallow=true`
  try {
    const res = await withTimeout(
      fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } }),
      FETCH_TIMEOUT_MS,
    )
    if (!res.ok) return []
    const text = await res.text()
    const bytes = text ? new Blob([text]).size : 0
    trackDownload(`#shallow:${path}`, 'GET', bytes)
    if (!text || text === 'null') return []
    return Object.keys(JSON.parse(text) as Record<string, unknown>)
  } catch {
    return []
  }
}

/**
 * Write (replace) a node at the given path with the given JSON value.
 * Uses PUT which replaces the node entirely. Invalidates this instance's
 * ETag cache entry for the path (other instances self-correct via ETag
 * mismatch on their next probe).
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
    etagInvalidatePut(path)
    return true
  } catch (err) {
    console.warn(`[firebase] write ${path} error:`, err)
    return false
  }
}

/**
 * Patch (shallow merge) a node at the given path. Invalidates the ETag
 * cache entry (merged value unknown locally).
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
    if (res.ok) etagInvalidate(path)
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

/**
 * Delete a node at the given path (REST DELETE). Used by the mesh
 * lease system (one-time lease consumption) and log trimming.
 */
export async function firebaseDelete(path: string): Promise<boolean> {
  const url = `${DB_URL}/${path}.json`
  try {
    const res = await withTimeout(
      fetch(url, {
        method: 'DELETE',
        cache: 'no-store',
      }),
      FETCH_TIMEOUT_MS,
    )
    if (res.ok) etagInvalidate(path)
    return res.ok
  } catch (err) {
    console.warn(`[firebase] delete ${path} error:`, err)
    return false
  }
}
