'use client'

/**
 * Client-side analytics tracker for NeutralWire.
 *
 * Sends a lightweight page-view ping to /api/analytics/track with:
 *   - deviceId (for unique user counting — already used by session tracking)
 *   - path (which page)
 *   - referrer (where they came from)
 *   - browser (parsed from userAgent)
 *   - device (mobile/tablet/desktop)
 *   - os (iOS/Android/Windows/Mac/Linux)
 *   - country (detected server-side from IP)
 *   - sessionId (to count sessions, not just page views)
 *   - ts (timestamp)
 *
 * DESIGN:
 *   - Fire-and-forget (beacon API when available, fetch fallback)
 *   - Throttled to ONE ping per session per page (not every navigation)
 *     — avoids double-counting SPA route changes
 *   - Respects sendBeacon for reliability on page unload
 *   - No cookies — uses localStorage for session ID
 *   - Country detected server-side (privacy: no precise location)
 */

const SESSION_ID_KEY = 'neutralwire:analytics-session'
const SESSION_TIMEOUT_MS = 30 * 60 * 1000 // 30 min idle = new session
const TRACKED_PATHS_KEY = 'neutralwire:analytics-tracked'

interface AnalyticsPayload {
  deviceId: string
  sessionId: string
  path: string
  referrer: string
  browser: string
  device: string
  os: string
  screen: string
  tz: string
  ts: number
}

function getOrCreateSessionId(): string {
  try {
    const stored = localStorage.getItem(SESSION_ID_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (Date.now() - parsed.ts < SESSION_TIMEOUT_MS) {
        // Refresh the timestamp (still active)
        localStorage.setItem(SESSION_ID_KEY, JSON.stringify({ id: parsed.id, ts: Date.now() }))
        return parsed.id
      }
    }
    // New session
    const id = 's_' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36)
    localStorage.setItem(SESSION_ID_KEY, JSON.stringify({ id, ts: Date.now() }))
    return id
  } catch {
    return 's_unknown'
  }
}

function detectBrowser(ua: string): string {
  if (/Edg\//i.test(ua)) return 'Edge'
  if (/OPR\//i.test(ua) || /Opera/i.test(ua)) return 'Opera'
  if (/SamsungBrowser/i.test(ua)) return 'Samsung Internet'
  if (/Firefox\//i.test(ua)) return 'Firefox'
  if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) return 'Chrome'
  if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) return 'Safari'
  if (/MSIE|Trident\//i.test(ua)) return 'Internet Explorer'
  return 'Other'
}

function detectDevice(ua: string): string {
  if (/iPad/i.test(ua)) return 'Tablet'
  if (/Mobile|Android|iPhone|iPod/i.test(ua)) return 'Mobile'
  return 'Desktop'
}

function detectOS(ua: string): string {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS'
  if (/Android/i.test(ua)) return 'Android'
  if (/Windows/i.test(ua)) return 'Windows'
  if (/Mac OS X/i.test(ua)) return 'macOS'
  if (/Linux/i.test(ua)) return 'Linux'
  return 'Other'
}

let trackedThisLoad = false

export function trackPageView(deviceId: string): void {
  if (trackedThisLoad) return
  if (typeof window === 'undefined') return

  // Don't track the debug/analytics page itself (skews metrics)
  const path = window.location.pathname
  if (path.startsWith('/debug')) return

  trackedThisLoad = true

  // Check if we already tracked this path in this session
  // (prevents double-counting on fast re-renders)
  try {
    const tracked = JSON.parse(localStorage.getItem(TRACKED_PATHS_KEY) || '{}')
    if (tracked[path] && Date.now() - tracked[path] < 5 * 60 * 1000) {
      // Already tracked this path in the last 5 min — skip
      return
    }
    tracked[path] = Date.now()
    // Keep only last 20 paths
    const entries = Object.entries(tracked)
    if (entries.length > 20) {
      const kept = entries.slice(-20)
      localStorage.setItem(TRACKED_PATHS_KEY, JSON.stringify(Object.fromEntries(kept)))
    } else {
      localStorage.setItem(TRACKED_PATHS_KEY, JSON.stringify(tracked))
    }
  } catch {
    // localStorage might be blocked — proceed anyway
  }

  const ua = navigator.userAgent
  const payload: AnalyticsPayload = {
    deviceId,
    sessionId: getOrCreateSessionId(),
    path,
    referrer: document.referrer || '',
    browser: detectBrowser(ua),
    device: detectDevice(ua),
    os: detectOS(ua),
    screen: `${window.screen.width}x${window.screen.height}`,
    tz: typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone || '' : '',
    ts: Date.now(),
  }

  // Use sendBeacon for reliability (works on page unload)
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
      const ok = navigator.sendBeacon('/api/analytics/track', blob)
      if (ok) return
    }
  } catch {
    // fall through to fetch
  }

  // Fallback: fetch with keepalive
  try {
    fetch('/api/analytics/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {})
  } catch {
    // silent — analytics should never break the page
  }
}
