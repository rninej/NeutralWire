/**
 * rtdb-rest.ts — thin client-side Firebase Realtime Database REST client.
 *
 * The whole app talks to Firebase through server routes; the mesh is the
 * one place where the BROWSER talks to the RTDB directly (that is the
 * entire point — presence, signaling and tiny manifest reads bypass
 * Vercel completely). The database has public read/write rules, so plain
 * unauthenticated REST works and adds zero server cost.
 *
 * Read/write calls are short-lived requests (no persistent connection).
 * rtdbWatch() opens ONE long-lived streaming read (SSE) and is used only
 * for room presence — the Firebase Spark plan caps simultaneous
 * connections (~100), so the mesh keeps exactly ≤1 stream per visible
 * tab and pauses it while the tab is hidden (see mesh-presence.ts).
 */

import { RTDB_URL } from '@/lib/mesh/mesh-protocol'

const FETCH_TIMEOUT_MS = 8000

function url(path: string): string {
  return `${RTDB_URL}/${path.replace(/^\/+/, '')}.json`
}

/** Server-timestamp sentinel — Firebase replaces it with its own clock
 *  at write time, so lease/heartbeat times cannot be forged by clients. */
export function serverTimestamp(): { '.sv': string } {
  return { '.sv': 'timestamp' }
}

export async function rtdbGet<T = unknown>(path: string): Promise<T | null> {
  try {
    const res = await fetch(url(path), {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const text = await res.text()
    if (!text || text === 'null') return null
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export async function rtdbPut(
  path: string,
  value: unknown,
): Promise<boolean> {
  try {
    const res = await fetch(url(path), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function rtdbDelete(path: string): Promise<boolean> {
  try {
    const res = await fetch(url(path), {
      method: 'DELETE',
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Push (append with a server-generated chronological key). */
export async function rtdbPush(
  path: string,
  value: unknown,
): Promise<string | null> {
  try {
    const res = await fetch(url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { name?: string } | null
    return data?.name ?? null
  } catch {
    return null
  }
}

// ── Streaming watch (SSE over fetch) ──

export interface RtdbWatchHandle {
  close: () => void
}

export interface RtdbPutEvent {
  /** Sub-path that changed; "/" = full initial snapshot. */
  path: string
  data: unknown
}

/**
 * Watch a node with a long-lived streaming GET (Firebase REST SSE).
 * Firebase emits an initial full "put" (path "/") on connect, then
 * incremental puts. Automatic reconnect with backoff; each reconnect
 * re-syncs the full node. Returns a handle with close().
 *
 * Browsers that can't stream fetch responses (very old iOS) fall back
 * to polling every `pollMs` — the caller's semantics are unchanged.
 */
export function rtdbWatch(
  path: string,
  onData: (events: RtdbPutEvent[]) => void,
  opts: { pollMs?: number } = {},
): RtdbWatchHandle {
  const pollMs = opts.pollMs ?? 10_000
  let closed = false
  let abort: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  // Streaming works in every modern browser AND Node/Bun (fetch +
  // ReadableStream) — feature-detect, don't environment-detect.
  const canStream =
    typeof fetch === 'function' &&
    typeof ReadableStream !== 'undefined'

  const schedule = (ms: number) => {
    if (closed) return
    timer = setTimeout(() => void run(), ms)
  }

  const run = async () => {
    if (closed) return
    abort = new AbortController()
    try {
      if (canStream) {
        const res = await fetch(url(path), {
          headers: { Accept: 'text/event-stream' },
          cache: 'no-store',
          signal: abort.signal,
        })
        if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        // Firebase keep-alive pings arrive every ~30s; if nothing arrives
        // for 90s we treat the stream as dead and reconnect.
        let lastEventAt = Date.now()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (closed) break
          buffer += decoder.decode(value, { stream: true })
          lastEventAt = Date.now()
          let nl: number
          const events: RtdbPutEvent[] = []
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload) continue
            try {
              const parsed = JSON.parse(payload) as { path?: string; data?: unknown }
              if (typeof parsed.path === 'string') {
                events.push({ path: parsed.path, data: parsed.data })
              }
            } catch {
              // ignore malformed frames
            }
          }
          if (events.length > 0) onData(events)
          if (Date.now() - lastEventAt > 90_000) {
            reader.cancel().catch(() => {})
            break
          }
        }
      } else {
        // Polling fallback — one short GET per interval.
        const data = await rtdbGet<unknown>(path)
        if (!closed) onData([{ path: '/', data }])
      }
    } catch {
      // aborted or network error — fall through to reconnect
    }
    if (!closed) schedule(canStream ? 2_000 : pollMs)
  }

  void run()

  return {
    close: () => {
      closed = true
      try {
        abort?.abort()
      } catch {
        /* noop */
      }
      if (timer) clearTimeout(timer)
    },
  }
}

/**
 * Apply a Firebase put event to a local snapshot map (null data at a
 * child path = delete). Used by presence/signaling watchers.
 */
export function applyPutEvent<T>(
  snapshot: Record<string, T>,
  event: RtdbPutEvent,
): Record<string, T> {
  if (event.path === '/') {
    if (event.data === null) return {}
    if (event.data && typeof event.data === 'object') {
      return { ...(event.data as Record<string, T>) }
    }
    return {}
  }
  // Child path like "/peerId" (one level for our use cases).
  const child = event.path.replace(/^\//, '').split('/')[0]
  if (!child) return snapshot
  if (event.data === null) {
    const next = { ...snapshot }
    delete next[child]
    return next
  }
  return { ...snapshot, [child]: event.data as T }
}
