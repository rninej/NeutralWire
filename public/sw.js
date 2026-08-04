// NeutralWire Service Worker
// PWA install, offline support, push notifications, click tracking.

// v17: removed branded loading splash (user request), kept minimal offline
//      page only. /api/summary + /api/topic SWR caching retained.
// v16: branded loading screen, /api/summary SWR, /api/topic SWR.
// v15: offline PWA support. v14: force SW update. v13: removed Interested.
// v12: SWR. v11: fire-and-forget tracking. v10: fixed notificationclick.
const CACHE_NAME = 'neutralwire-v18'
const STATIC_ASSETS = ['/manifest.json', '/favicon-32.png', '/icon-192.png', '/icon-512.png', '/']

// ---------- Install ----------
// Pre-cache the app shell so the FIRST load is instant when online, and
// the PWA works offline immediately after install.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // addAll is atomic — if any fetch fails, none are cached. We use
      // individual puts with catch so a single failed asset doesn't
      // break the whole install.
      Promise.allSettled(
        STATIC_ASSETS.map((url) =>
          fetch(url, { cache: 'no-store' })
            .then((res) => res.ok ? cache.put(url, res) : null)
            .catch(() => null),
        ),
      ),
    ),
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

// ---------- Minimal offline page (inline HTML) ----------
// Shown only when: offline AND no cached HTML at all. Just a simple
// "waiting for connection" message that auto-reloads when back online.
// (The app's own offline banner handles the normal offline case where
// cached HTML + cached API responses are available.)
const OFFLINE_PAGE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>NeutralWire — Offline</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;text-align:center}
.status{font-size:15px;color:#888}
</style></head><body>
<div class="status" id="status">Waiting for connection… NeutralWire will load automatically when you're back online.</div>
<script>
window.addEventListener('online',function(){window.location.reload()});
setInterval(function(){fetch('/',{method:'HEAD',cache:'no-store'}).then(function(){window.location.reload()}).catch(function(){})},4000);
</script>
</body></html>`

// ---------- Fetch handler ----------
self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  // ── Navigation requests (HTML pages) → network-first, cache fallback ──
  // Network-first ensures users get fresh HTML after a deploy (avoids
  // hydration mismatches). Falls back to cached HTML when offline, then
  // to the branded loading screen if there's no cache at all.
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      (async () => {
        try {
          const networkRes = await fetch(req, { cache: 'no-store' })
          const cache = await caches.open(CACHE_NAME)
          cache.put(req, networkRes.clone())
          return networkRes
        } catch {
          // Network failed (offline) — fall back to cached HTML
          const cached = await caches.match(req)
          if (cached) return cached
          // No cache either — return the minimal offline page.
          return new Response(OFFLINE_PAGE_HTML, {
            headers: { 'Content-Type': 'text/html' },
          })
        }
      })(),
    )
    return
  }

  // ── Static assets (JS, CSS, images, fonts) → cache-first ──
  // Cache-first = instant load on repeat visits. Falls back to network
  // and caches the response for next time.
  if (req.url.includes('/_next/static/') || req.url.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2)$/)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached
        return fetch(req).then((res) => {
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
  // Serves the cached response INSTANTLY (if available), then fetches a
  // fresh copy in the background to update the cache. This is the
  // biggest speed win for the PWA — the feed appears immediately.
  if (req.url.includes('/api/news')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME)
        const cached = await cache.match(req)

        // Kick off a background fetch to update the cache (revalidate).
        const networkFetch = fetch(req, { cache: 'no-store' })
          .then((res) => {
            if (res.ok) cache.put(req, res.clone())
            return res
          })
          .catch(() => null)

        // If we have a cached response, return it INSTANTLY.
        if (cached) return cached

        // No cache — wait for the network (first-ever load).
        const networkRes = await networkFetch
        if (networkRes) return networkRes

        // Network failed and no cache — empty response (app shows
        // "no stories" gracefully).
        return new Response(
          JSON.stringify({ topics: [], sourceCount: 0, articleCount: 0 }),
          { headers: { 'Content-Type': 'application/json' } },
        )
      })(),
    )
    return
  }

  // ── /api/summary → STALE-WHILE-REVALIDATE ──
  // Summaries are expensive to generate (LLM call) and rarely change once
  // cached in Firebase. SWR means:
  //   - Online: serve cache instantly, revalidate in background
  //   - Offline: serve cache (so topic detail works offline!)
  //   - First-ever: fetch from network (which checks Firebase → generates)
  // This makes the "Neutral Summary" section load instantly on repeat
  // visits AND work fully offline (the summary is already in the SW cache).
  if (req.url.includes('/api/summary')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME)
        const cached = await cache.match(req)

        const networkFetch = fetch(req, { cache: 'no-store' })
          .then((res) => {
            if (res.ok) cache.put(req, res.clone())
            return res
          })
          .catch(() => null)

        // Serve cache instantly if we have it.
        if (cached) return cached

        // No cache — wait for network.
        const networkRes = await networkFetch
        if (networkRes) return networkRes

        // Offline + no cache — return an error so the UI shows the
        // fallback (extractive summary / "could not generate").
        return new Response(
          JSON.stringify({ error: 'Offline — summary not cached' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        )
      })(),
    )
    return
  }

  // ── /api/topic/[id] → STALE-WHILE-REVALIDATE (offline topic detail) ──
  // Topic detail pages are opened by ID. Once fetched, the full topic
  // (with articles) is cached so opening the same topic offline works.
  // SWR: serve cache instantly, revalidate in background.
  // Important: only cache & serve successful (200) responses — never
  // cache error responses (503, 404) so a transient offline error
  // doesn't permanently break a topic.
  if (req.url.match(/\/api\/topic\//)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME)
        const cached = await cache.match(req)

        // Kick off a background fetch to update the cache.
        const networkFetch = fetch(req, { cache: 'no-store' })
          .then((res) => {
            if (res.ok) cache.put(req, res.clone())
            return res
          })
          .catch(() => null)

        // Serve cache instantly IF it's a successful response (not an
        // error). We check cached.ok — though cache.match returns a
        // Response without .ok in some browsers, so we also check
        // cached.status.
        if (cached && cached.status >= 200 && cached.status < 300) {
          return cached
        }

        // No valid cache — wait for network.
        const networkRes = await networkFetch
        if (networkRes) return networkRes

        // Offline + no cache — return a 503 so the UI shows a graceful
        // "couldn't load" message. NOT cached.
        return new Response(
          JSON.stringify({ error: 'Offline — topic not cached' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        )
      })(),
    )
    return
  }

  // ── /api/img → cache-first (images don't change) ──
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
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
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
      topicTitle: data.body,
    },
    image: data.image,
    actions: [
      { action: 'dislike', title: 'Not Interested', icon: '/icon-192.png' },
    ],
  }

  event.waitUntil(
    self.registration.showNotification(data.title, options),
  )
})

// ---------- Notification click ----------
self.addEventListener('notificationclick', (event) => {
  const isNotInterested = event.action === 'dislike'
  event.notification.close()

  const url = event.notification.data?.url || '/'
  const notifId = event.notification.data?.notifId
  const topicTitle = event.notification.data?.topicTitle || ''

  let topicId = null
  try {
    const urlObj = new URL(url, self.location.origin)
    topicId = urlObj.searchParams.get('topic')
  } catch {
    const match = url.match(/[?&]topic=([^&]+)/)
    if (match) topicId = match[1]
  }

  event.waitUntil((async () => {
    const trackHeaders = { 'Content-Type': 'application/json' }
    if (isNotInterested) {
      fetch('/api/notification/feedback', {
        method: 'POST',
        headers: trackHeaders,
        body: JSON.stringify({ notifId, action: 'dislike', title: topicTitle }),
      }).catch(() => {})
    } else if (notifId) {
      fetch('/api/notification/track', {
        method: 'POST',
        headers: trackHeaders,
        body: JSON.stringify({ notifId, action: 'click', title: topicTitle }),
      }).catch(() => {})
    }

    if (isNotInterested) return

    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    })

    let targetClient = null
    for (const client of clients) {
      if (client.url.includes(self.location.origin)) {
        targetClient = client
        break
      }
    }

    if (targetClient) {
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

    try {
      const newClient = await self.clients.openWindow(url)
      if (newClient && topicId) {
        setTimeout(() => {
          try {
            newClient.postMessage({ type: 'open-topic', topicId, url, notifId })
          } catch {
            // silent
          }
        }, 1500)
      }
    } catch {
      // openWindow can fail if popups are blocked
    }
  })())
})

// ---------- Notification close (dismiss) ----------
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
