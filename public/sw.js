// NeutralWire Service Worker
// PWA install, offline support, push notifications, click tracking.

// Bumped to v12: added stale-while-revalidate caching for /api/news so the
// PWA loads INSTANTLY from cache (was waiting 1-2s for the network on every
// open). Also added /api/img caching for instant image proxy.
// v11: fixed "processing notification" stuck on mobile — tracking fetches
// are fire-and-forget. v10: fixed notificationclick, removed duplicate
// fetch handler.
const CACHE_NAME = 'neutralwire-v12'
// Don't cache '/' (the HTML page) — it changes on every deploy and serving
// stale HTML causes hydration mismatches when the JS bundle is updated.
// Only cache truly static assets.
const STATIC_ASSETS = ['/manifest.json', '/favicon-32.png', '/icon-192.png', '/icon-512.png']

// ---------- Install ----------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)),
  )
  self.skipWaiting()
})

// ---------- Activate ----------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)),
      ),
    ),
  )
  self.clients.claim()
})

// ---------- Fetch handler (network-first for HTML) ----------
// Navigation requests (HTML pages) ALWAYS go to the network first.
// This ensures users never see stale HTML after a deploy, which was
// causing hydration mismatches (old HTML + new JS bundle).
// Static assets (JS, CSS, images) use cache-first for speed.
self.addEventListener('fetch', (event) => {
  const req = event.request
  // Only handle GET requests
  if (req.method !== 'GET') return

  // Navigation requests (HTML pages) → network-first
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      (async () => {
        try {
          // Try network first
          const networkRes = await fetch(req, { cache: 'no-store' })
          return networkRes
        } catch {
          // Network failed (offline) — fall back to cached HTML if available
          const cached = await caches.match(req)
          if (cached) return cached
          // No cache either — return a basic offline page
          return new Response(
            '<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>You are offline</h2><p>NeutralWire will load when you reconnect.</p></body></html>',
            { headers: { 'Content-Type': 'text/html' } },
          )
        }
      })(),
    )
    return
  }

  // Static assets (JS, CSS, images, fonts) → cache-first, then network
  if (req.url.includes('/_next/static/') || req.url.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2)$/)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached
        return fetch(req).then((res) => {
          // Cache successful responses
          if (res.ok) {
            const clone = res.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone))
          }
          return res
        })
      }),
    )
    return
  }

  // ── /api/news → STALE-WHILE-REVALIDATE (instant PWA load) ──
  // This is the BIGGEST speed win for the PWA: when the app opens, it
  // requests /api/news. Instead of waiting 1-2s for the network, we serve
  // the CACHED response INSTANTLY (if available), then fetch a fresh copy
  // in the background and update the cache for next time.
  //
  // Flow:
  //   1. First open: no cache → fetch from network, cache it, return it
  //   2. Subsequent opens: serve cache INSTANTLY → fetch fresh in background
  //      → update cache (next open gets the fresh data)
  //   3. Offline: serve cache (or the last-known-good response)
  //
  // We cache each (category, country, limit) combination separately so
  // switching tabs doesn't serve the wrong category's cache.
  if (req.url.includes('/api/news')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME)
        const cached = await cache.match(req)

        // Kick off a background fetch to update the cache (revalidate).
        // Don't await it — we return the cached response immediately.
        const networkFetch = fetch(req, { cache: 'no-store' })
          .then((res) => {
            if (res.ok) {
              cache.put(req, res.clone())
            }
            return res
          })
          .catch(() => null)

        // If we have a cached response, return it INSTANTLY.
        // The network fetch continues in the background to update the cache.
        if (cached) {
          return cached
        }

        // No cache — wait for the network (first-ever load).
        const networkRes = await networkFetch
        if (networkRes) return networkRes

        // Network failed and no cache — return a minimal empty response
        // so the app doesn't crash (it'll show "no stories available").
        return new Response(
          JSON.stringify({ topics: [], sourceCount: 0, articleCount: 0 }),
          { headers: { 'Content-Type': 'application/json' } },
        )
      })(),
    )
    return
  }

  // ── /api/img → cache-first (images don't change) ──
  // Image proxy responses are immutable (same URL = same image). Cache-
  // first means instant image load on repeat visits. Fall back to network
  // if not cached. Cache for 24h (handled by the cache name bump on deploy).
  if (req.url.includes('/api/img')) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached
        return fetch(req).then((res) => {
          if (res.ok) {
            const clone = res.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone))
          }
          return res
        }).catch(() => {
          // Network failed and no cache — return a 503 so the img tag's
          // onError handler shows the placeholder (topic-card handles this).
          return new Response('', { status: 503, headers: { 'Content-Type': 'text/plain' } })
        })
      }),
    )
    return
  }
})

// ---------- Message handler ----------
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'START_SCHEDULE_POLL') {
    startSchedulePolling()
  }
})

// ---------- Scheduled notification polling ----------
let schedulePollInterval = null

function startSchedulePolling() {
  if (schedulePollInterval) return
  checkScheduledNotifications()
  schedulePollInterval = setInterval(checkScheduledNotifications, 30000)
}

async function checkScheduledNotifications() {
  try {
    const res = await fetch('/api/push/schedule', { cache: 'no-store' })
    if (!res.ok) return
    const data = await res.json()
    if (data.pending && data.pending.length > 0) {
      for (const item of data.pending) {
        await fetch(`/api/push/schedule?id=${item.id}`, { cache: 'no-store' })
      }
    }
  } catch {
    // silent
  }
}

// ---------- Push event handler ----------
// Fires when the server sends a push message. Wakes up the device
// even if the app is closed.
self.addEventListener('push', (event) => {
  let data = {
    title: 'NeutralWire',
    body: 'New update',
    url: '/',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    image: null,
    tag: 'neutralwire',
    notifId: null,
  }

  try {
    if (event.data) {
      data = { ...data, ...event.data.json() }
    }
  } catch {
    if (event.data) {
      data.body = event.data.text()
    }
  }

  const options = {
    body: data.body,
    icon: data.icon,
    badge: data.badge,
    tag: data.tag,
    data: {
      url: data.url,
      notifId: data.notifId,
      topicTitle: data.body, // store the title so we can use it for like/dislike tracking
    },
    image: data.image,
    // "Interested" + "Not Interested" action buttons (shown at the bottom of
    // the notification on Android Chrome and desktop Chrome).
    // iOS Safari doesn't support action buttons, so taps still open the story.
    //
    // Behavior:
    //   - Interested      → opens the article (like a regular tap) + tracks positive
    //   - Not Interested → dismisses the notification + tracks negative (doesn't open)
    actions: [
      { action: 'like', title: 'Interested', icon: '/icon-192.png' },
      { action: 'dislike', title: 'Not Interested', icon: '/icon-192.png' },
    ],
  }

  event.waitUntil(
    self.registration.showNotification(data.title, options),
  )
})

// ---------- Notification click ----------
// Opens the specific news story URL (not just the app homepage).
// Also tracks the click for the prediction system.
//
// Handles action buttons (Interested / Not Interested) at the bottom of the notification.
//
// Behavior:
//   - Regular tap (no action)    → opens story, closes notification
//   - "Interested" (like)        → opens story, closes notification, tracks positive
//   - "Not Interested" (dislike) → DOESN'T open story, closes notification, tracks negative
//
// FIX (v11): On mobile, v10 awaited the tracking fetches BEFORE opening the
// article. /api/notification/feedback does up to 5 Firebase read+write calls
// (8s timeout each) — on a slow mobile network that blocked the article from
// opening for seconds, and Android Chrome showed "Processing notification"
// stuck. Desktop was fast enough to hide this.
//
// v11 fix: fire tracking as FIRE-AND-FORGET (no await), open the article
// IMMEDIATELY. Also replaced the flaky client.navigate() (hangs on Android)
// with focus() + postMessage — the client-side 'open-topic' handler opens
// the topic and updates the URL.
//
// REDUNDANCY: Three layers ensure the topic always opens:
//   1. If a client is open: focus it + postMessage 'open-topic'
//   2. If no client is open: openWindow(url)
//   3. If both fail: the client-side topic-watcher catches ?topic= on next load
self.addEventListener('notificationclick', (event) => {
  const isNotInterested = event.action === 'dislike'

  // Close the notification immediately (visual feedback).
  event.notification.close()

  const url = event.notification.data?.url || '/'
  const notifId = event.notification.data?.notifId
  const topicTitle = event.notification.data?.topicTitle || ''

  // Extract topicId from the URL (?topic=xxx)
  let topicId = null
  try {
    const urlObj = new URL(url, self.location.origin)
    topicId = urlObj.searchParams.get('topic')
  } catch {
    const match = url.match(/[?&]topic=([^&]+)/)
    if (match) topicId = match[1]
  }

  event.waitUntil((async () => {
    // ── Fire tracking as FIRE-AND-FORGET (NO await) ──
    // These are best-effort analytics. /api/notification/feedback does up
    // to 5 Firebase read+write calls — awaiting it blocked the article
    // from opening on mobile ("Processing notification" stuck). We start
    // the fetch but don't wait for it. The SW stays alive just long enough
    // for openWindow/focus below; the tracking fetch continues in the
    // background and completes (or is best-effort dropped).
    const trackHeaders = { 'Content-Type': 'application/json' }
    if (event.action) {
      fetch('/api/notification/feedback', {
        method: 'POST',
        headers: trackHeaders,
        body: JSON.stringify({ notifId, action: event.action, title: topicTitle }),
      }).catch(() => {})
    }
    if (!isNotInterested && notifId) {
      fetch('/api/notification/track', {
        method: 'POST',
        headers: trackHeaders,
        body: JSON.stringify({ notifId, action: 'click', title: topicTitle }),
      }).catch(() => {})
    }

    // ── "Not Interested" → dismiss only, don't open the article ──
    if (isNotInterested) {
      return
    }

    // ── Open the article IMMEDIATELY ( Interested or regular tap ) ──
    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    })

    // Find a client on our origin.
    let targetClient = null
    for (const client of clients) {
      if (client.url.includes(self.location.origin)) {
        targetClient = client
        break
      }
    }

    if (targetClient) {
      // ── LAYER 1: App is already open — focus + postMessage ──
      // Don't use client.navigate() — it's flaky on Android (hangs/fails
      // silently). Instead, focus the client and postMessage 'open-topic';
      // the client-side handler opens the topic + updates the URL.
      try {
        targetClient.postMessage({ type: 'open-topic', topicId, url, notifId })
      } catch {
        // silent
      }
      try {
        await targetClient.focus()
      } catch {
        // focus can fail on some browsers
      }
      return
    }

    // ── LAYER 2: No open client — open a new window ──
    try {
      const newClient = await self.clients.openWindow(url)
      if (newClient && topicId) {
        // Post a message to the new client after it loads (backup for the
        // ?topic= URL param, in case the client's topic-watcher is slow)
        setTimeout(() => {
          try {
            newClient.postMessage({ type: 'open-topic', topicId, url, notifId })
          } catch {
            // silent
          }
        }, 1500)
      }
    } catch {
      // openWindow can fail if popups are blocked — the client-side
      // topic-watcher will handle ?topic= on next manual launch
    }
  })())
})

// ---------- Notification close (dismiss) ----------
// Tracks when the user swipes away a notification (for prediction).
self.addEventListener('notificationclose', (event) => {
  const notifId = event.notification.data?.notifId
  if (notifId) {
    fetch('/api/notification/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notifId,
        action: 'dismiss',
        title: event.notification.body || '',
      }),
    }).catch(() => {})
  }
})

// ---------- NOTE: There is only ONE fetch handler (above, near the top).
// The duplicate fetch handler that was here has been REMOVED in v10/v11.
// Having two fetch listeners caused both to call event.respondWith()
// for the same navigation request, which produced undefined behavior
// and broke PWA shortcut navigation (/?category=... was sometimes
// served from a stale cache of '/' without the query param).
