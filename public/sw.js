// NeutralWire Service Worker
// PWA install, offline support, push notifications, click tracking.

// Bumped to v10: fixed notificationclick (Interested now opens article),
// removed duplicate fetch handler that was breaking PWA shortcut navigation.
const CACHE_NAME = 'neutralwire-v10'
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
// FIX (v10): The ENTIRE handler body is wrapped in event.waitUntil() so the
// service worker stays alive until the article is actually opened. Previously,
// the tracking fetches were fire-and-forget BEFORE event.waitUntil was called,
// which let Android Chrome kill the SW before it could open the article —
// so tapping "Interested" just dismissed the notification without opening it.
//
// REDUNDANCY: Three layers ensure the topic always opens:
//   1. If a client is open: navigate it + postMessage
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

  // Wrap EVERYTHING in event.waitUntil so the SW stays alive until the
  // article opens. Without this, Android Chrome kills the SW after the
  // synchronous handler returns, before async openWindow/navigate resolves.
  event.waitUntil((async () => {
    // ── Track feedback for action buttons ──
    // (fire-and-forget but inside waitUntil so SW doesn't die mid-fetch)
    if (event.action) {
      try {
        await fetch('/api/notification/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            notifId,
            action: event.action,
            title: topicTitle,
          }),
        })
      } catch {
        // silent — tracking is best-effort
      }
    }

    // ── "Not Interested" → dismiss only, don't open the article ──
    if (isNotInterested) {
      return
    }

    // ── Regular tap OR "Interested" → track click + open the article ──
    if (notifId) {
      try {
        await fetch('/api/notification/track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            notifId,
            action: 'click',
            title: topicTitle,
          }),
        })
      } catch {
        // silent — tracking is best-effort
      }
    }

    // ── Open the article ──
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
      // ── LAYER 1: App is already open — navigate + focus ──
      let navigated = false
      try {
        await targetClient.navigate(url)
        navigated = true
      } catch {
        // navigate can fail if the client is mid-navigation or crashed
      }
      // Post a message as backup (in case navigate didn't trigger React)
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
      // If navigate failed, try openWindow as a last resort
      if (!navigated) {
        try {
          await self.clients.openWindow(url)
        } catch {
          // silent
        }
      }
      return
    }

    // ── LAYER 2: No open client — open a new window ──
    try {
      const newClient = await self.clients.openWindow(url)
      if (newClient && topicId) {
        // Post a message to the new client after it loads
        setTimeout(() => {
          try {
            newClient.postMessage({ type: 'open-topic', topicId, url, notifId })
          } catch {
            // silent
          }
        }, 1500)
      }
    } catch {
      // openWindow can fail if popups are blocked — nothing more we can do
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
// The duplicate fetch handler that was here has been REMOVED in v10.
// Having two fetch listeners caused both to call event.respondWith()
// for the same navigation request, which produced undefined behavior
// and broke PWA shortcut navigation (/?category=... was sometimes
// served from a stale cache of '/' without the query param).
