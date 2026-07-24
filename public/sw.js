// NeutralWire Service Worker
// PWA install, offline support, push notifications, click tracking.

const CACHE_NAME = 'neutralwire-v7'
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
    // Like + Dislike action buttons (shown at the bottom of the notification
    // on Android Chrome and desktop Chrome).
    // iOS Safari doesn't support action buttons, so taps still open the story.
    actions: [
      { action: 'like', title: '👍 Like', icon: '/icon-192.png' },
      { action: 'dislike', title: '👎 Dislike', icon: '/icon-192.png' },
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
// Handles action buttons (Like/Dislike) at the bottom of the notification.
//
// REDUNDANCY: Three layers ensure the topic always opens:
//   1. If a client is open: post a 'open-topic' message AND navigate it
//   2. If no client is open: openWindow(url)
//   3. If both fail: the client-side topic-watcher effect will catch the
//      ?topic= param on next page load
self.addEventListener('notificationclick', (event) => {
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
    // url might be relative — try parsing it
    const match = url.match(/[?&]topic=([^&]+)/)
    if (match) topicId = match[1]
  }

  // Handle action buttons (Like / Dislike)
  if (event.action === 'like' || event.action === 'dislike') {
    fetch('/api/notification/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notifId,
        action: event.action,
        title: topicTitle,
      }),
    }).catch(() => {})
    return
  }

  // Track the click (fire and forget).
  if (notifId) {
    fetch('/api/notification/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notifId,
        action: 'click',
        title: topicTitle,
      }),
    }).catch(() => {})
  }

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })

      // Find a client that's on our origin.
      let targetClient = null
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          targetClient = client
          break
        }
      }

      if (targetClient) {
        // ── LAYER 1: App is already open ──
        // Post a message so the client knows to open the topic (works even
        // if navigate() silently fails or doesn't trigger a React re-render).
        try {
          targetClient.postMessage({
            type: 'open-topic',
            topicId,
            url,
            notifId,
          })
        } catch {
          // postMessage might fail if client is unresponsive
        }

        // ALSO navigate the client to the URL (redundancy — if postMessage
        // works, great; if not, navigate ensures the URL changes).
        try {
          await targetClient.navigate(url)
        } catch {
          // navigate can fail if the client is mid-navigation or crashed.
          // The client-side topic-watcher will handle it on next load.
        }

        try {
          await targetClient.focus()
        } catch {
          // focus can fail on some browsers — silent
        }
        return
      }

      // ── LAYER 2: No open client — open a new window ──
      try {
        const newClient = await self.clients.openWindow(url)
        // Post a message to the new client too (in case it loads fast
        // enough to receive it before the page renders).
        if (newClient && topicId) {
          // Wait a moment for the client to be ready
          setTimeout(() => {
            try {
              newClient.postMessage({
                type: 'open-topic',
                topicId,
                url,
                notifId,
              })
            } catch {
              // silent
            }
          }, 1500)
        }
      } catch {
        // openWindow can fail if popups are blocked. In that case the
        // client-side topic-watcher won't help either — nothing more we
        // can do.
      }
    })(),
  )
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

// ---------- Fetch strategy ----------
self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  if (request.method !== 'GET') return
  if (url.origin !== self.location.origin) return

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
          }
          return response
        })
        .catch(() => caches.match(request).then((r) => r || new Response('Offline', { status: 503 }))),
    )
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/').then((r) => r || caches.match(request))),
    )
    return
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
          }
          return response
        }),
    ),
  )
})
