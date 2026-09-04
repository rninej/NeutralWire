/**
 * Tiny localStorage-based gates for REDUNDANT idempotent server calls.
 *
 * ── Why (Vercel Fluid Active CPU) ──
 * Several client calls fire on EVERY page load / PWA launch even though
 * they are idempotent healing writes whose server-side effect only
 * matters once (or when something actually changes):
 *
 *   - POST /api/referral/track (no ?ref=) — full device read-modify-write
 *     in Firebase on every single page view
 *   - POST /api/session (immediate tz ping) — 2-4 Firebase ops per reload
 *   - POST /api/push/subscribe — full device read + full write per PWA
 *     launch, even when the subscription is byte-identical
 *   - POST /api/notifications {enabled:true} — redundant re-enable ping
 *     per PWA launch
 *   - POST /api/pwa-installed — re-marks an immutable flag per PWA launch
 *
 * Each gated call still fires when:
 *   - it has NEVER fired before (first visit — full original behaviour),
 *   - the semantically relevant fields CHANGED (endpoint, timezone,
 *     standalone mode…), or
 *   - the heartbeat TTL expired (so server-side data loss still heals,
 *     within the TTL window — nothing silently rots forever).
 *
 * Calls that carry REAL information (referral attribution, settings
 * toggles, the `appinstalled` event, the 5-minute session pings) are NOT
 * gated — they keep firing exactly as before. The user experience is
 * unchanged: the server state these calls maintain is already correct.
 *
 * Failure-safe by design: if localStorage is unavailable or corrupted,
 * every gate OPENs (the call always fires) — a gate can never block a
 * call, it can only skip provably-redundant ones.
 */

const GATE_PREFIX = 'neutralwire:gate:'

interface GateRecord {
  ts: number
  [field: string]: unknown
}

function readGate(key: string): GateRecord | null {
  try {
    const raw = localStorage.getItem(GATE_PREFIX + key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as GateRecord
    if (typeof parsed?.ts !== 'number' || !isFinite(parsed.ts)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * True when the gated call SHOULD fire:
 *   never fired  |  a field changed  |  heartbeat TTL expired  |  storage broken
 */
export function gateAllows(
  key: string,
  fields: Record<string, unknown>,
  ttlMs: number,
): boolean {
  try {
    const entry = readGate(key)
    if (!entry) return true
    if (Date.now() - entry.ts > ttlMs) return true
    for (const [field, value] of Object.entries(fields)) {
      if (entry[field] !== value) return true
    }
    return false
  } catch {
    return true
  }
}

/**
 * Record that the gated call just succeeded. Call this only AFTER the
 * server confirmed success, so a failed call is retried on the next load.
 */
export function markGate(key: string, fields: Record<string, unknown> = {}): void {
  try {
    localStorage.setItem(
      GATE_PREFIX + key,
      JSON.stringify({ ts: Date.now(), ...fields } satisfies GateRecord),
    )
  } catch {
    // silent — worst case the call re-fires next load
  }
}
