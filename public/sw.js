// NeutralWire Service Worker
// PWA install, offline support, push notifications, click tracking.
//
// v21: STALE-NEWS FIX — /api/news is now NETWORK-FIRST whenever the cached
//      copy is older than 5 minutes. Previously the SW served a cached
//      response INSTANTLY no matter its age and only revalidated in the
//      background — the fresh response updated the CACHE but the user
//      kept staring at the OLD feed (days old if they hadn't visited in
//      days). Now: cache < 5 min old → served instantly with zero network
//      (the invocation saver stays); cache ≥ 5 min → wait for the network
//      (the server answers from the Firebase cache in ~200-600ms), fall
//      back to the cached copy only when offline. Users never see news
//      older than ~5 minutes while online.
// v20: REVALIDATION THROTTLE — SWR handlers no longer fire a background
//      network fetch on EVERY request. A cached response younger than its
//      revalidation threshold is served with ZERO network activity. The
//      Relevant tab previously made ~14 /api/news requests per load, each
//      triggering a serverless revalidation (even when the cache was
//      seconds old) — burning Vercel invocations + Fluid CPU for nothing.
//      Thresholds: news/topic 5 min (matches CDN s-maxage), summary 60 min
//      (summaries are immutable once cached in Firebase).
// v19: CACHE EVICTION — prevents the SW cache from growing unbounded
//      (was hitting 30-99MB on mobile). Caps at MAX_CACHE_ENTRIES with
//      LRU eviction + a 12h max-age sweep on activate. Splits API cache
//      into a separate cache so it can be evicted independently of the
//      app shell. /api/img moved to its own cache with a tighter cap
//      (images are the biggest contributor to cache bloat).
// v18: minimal offline page only. /api/summary + /api/topic SWR caching.
// v17: removed branded loading splash. v16: branded loading screen.
// v15: offline PWA support. v14: force SW update. v13: removed Interested.
const SHELL_CACHE = 'neutralwire-shell-v21'
const API_CACHE = 'neutralwire-api-v21'
const IMG_CACHE = 'neutralwire-img-v21'
// ALL caches from previous versions are purged on activate (any name
// starting with 'neutralwire-' that isn't one of the three current names).
const CURRENT_CACHES = new Set([SHELL_CACHE, API_CACHE, IMG_CACHE])
const STATIC_ASSETS = ['/manifest.json', '/favicon-32.png', '/icon-192.png', '/icon-512.png', '/']

// ── Cache eviction limits ──
// The API cache holds /api/news, /api/topic, /api/summary responses.
// Each can be 50-200KB. Without eviction this grew to 30-99MB on mobile.
// Cap at 60 entries (~6-12MB worst case) with LRU eviction.
const MAX_API_ENTRIES = 60
// Images are the biggest bloat contributor. Cap at 80 (~8-15MB).
// Images are immutable so we can be more aggressive with eviction —
// the SW cache-first will just re-fetch if evicted.
const MAX_IMG_ENTRIES = 80
// Max age: entries older than 12h are considered stale and evicted
// during the activate sweep.
const MAX_AGE_MS = 12 * 60 * 60 * 1000

// ── SWR revalidation thresholds ──
// A cached response younger than its threshold is served with NO network
// revalidation at all. Older than the threshold → serve cache instantly +
// refresh in the background (classic SWR). This stops every page load from
// firing ~14 redundant serverless revalidations that the CDN already has.
const REVALIDATE_NEWS_MS = 5 * 60 * 1000 // /api/news + /api/topic (matches CDN s-maxage)
const REVALIDATE_SUMMARY_MS = 60 * 60 * 1000 // /api/summary (immutable once generated)

/**
 * Age of a cached response in ms, from its Date header. Returns Infinity
 * when the age can't be determined (forces revalidation — safe default).
 */
function cachedAgeMs(cached) {
  try {
    const d = cached.headers.get('date')
    if (!d) return Infinity
    const t = new Date(d).getTime()
    if (!isFinite(t)) return Infinity
    return Date.now() - t
  } catch {
    return Infinity
  }
}

// ---------- Install ----------
// Pre-cache the app shell so the FIRST load is instant when online, and
// the PWA works offline immediately after install.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
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

// ---------- Activate: purge legacy caches + sweep stale entries ----------
// On activate we:
//   1. Delete ALL legacy caches (v18 and older) — forces a clean start
//      with the new eviction logic.
//   2. Sweep the API + IMG caches for entries older than MAX_AGE_MS.
//   3. If still over MAX_*_ENTRIES, evict the oldest until under the cap.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      // Delete EVERY cache from previous SW versions (any 'neutralwire-*'
      // name that isn't one of the three current ones). The stale-news fix
      // needs a clean start — old v19 API entries could still be days old.
      await Promise.all(
        names
          .filter(
            (n) =>
              n.startsWith('neutralwire-') && !CURRENT_CACHES.has(n),
          )
          .map((n) => caches.delete(n)),
      )
      // Sweep stale entries from the current caches
      await sweepCache(API_CACHE, MAX_API_ENTRIES)
      await sweepCache(IMG_CACHE, MAX_IMG_ENTRIES)
    })(),
  )
  self.clients.claim()
})

/**
 * Evict stale + excess entries from a cache.
 * - Entries older than MAX_AGE_MS are deleted.
 * - If the cache still has more than maxEntries, the oldest are evicted
 *   (LRU by the cache's internal insertion order, which Response objects
 *   don't directly expose — we approximate by the Date header if present,
 *   otherwise by the order keys() returns them).
 */
async function sweepCache(cacheName, maxEntries) {
  try {
    const cache = await caches.open(cacheName)
    const keys = await cache.keys()
    if (keys.length === 0) return
    const now = Date.now()
    const toDelete = []
    // First pass: delete entries older than MAX_AGE_MS (using the Date
    // response header if available; otherwise keep — we can't tell age).
    for (const req of keys) {
      try {
        const res = await cache.match(req)
        if (!res) continue
        const dateHeader = res.headers.get('date')
        if (dateHeader) {
          const entryTime = new Date(dateHeader).getTime()
          if (now - entryTime > MAX_AGE_MS) {
            toDelete.push(req)
          }
        }
      } catch {
        // can't read this entry — evict it (corrupt)
        toDelete.push(req)
      }
    }
    // Second pass: if still over the cap, evict oldest (first entries).
    // keys() returns entries in insertion order (oldest first), so we
    // evict from the front until under the cap.
    const remaining = keys.length - toDelete.length
    if (remaining > maxEntries) {
      const excess = remaining - maxEntries
      const notYetDeleted = keys.filter((k) => !toDelete.includes(k))
      for (let i = 0; i < excess && i < notYetDeleted.length; i++) {
        toDelete.push(notYetDeleted[i])
      }
    }
    await Promise.all(toDelete.map((req) => cache.delete(req)))
    if (toDelete.length > 0) {
      console.log(`[SW] evicted ${toDelete.length} entries from ${cacheName} (was ${keys.length})`)
    }
  } catch (err) {
    console.warn('[SW] sweep failed:', err)
  }
}

/**
 * Put a response into a cache AND enforce the max-entries cap.
 * After putting, if the cache exceeds maxEntries, evict the oldest entries.
 * This runs fire-and-forget (not awaited) so it doesn't block the response.
 */
async function putWithEviction(cacheName, request, response, maxEntries) {
  try {
    // Skip non-http(s) requests (chrome-extension://, moz-extension://, etc.)
    // The Cache API only supports http(s) URLs — trying to cache other
    // schemes throws "Request scheme 'chrome-extension' is unsupported".
    const url = request.url || ''
    if (!url.startsWith('http://') && !url.startsWith('https://')) return
    const cache = await caches.open(cacheName)
    await cache.put(request, response)
    // Check count and evict if over the cap
    const keys = await cache.keys()
    if (keys.length > maxEntries) {
      const excess = keys.length - maxEntries
      // Evict the oldest (first N entries)
      const toEvict = keys.slice(0, excess)
      await Promise.all(toEvict.map((req) => cache.delete(req)))
    }
  } catch (err) {
    console.warn('[SW] putWithEviction failed:', err)
  }
}

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
          putWithEviction(SHELL_CACHE, req, networkRes.clone(), 5)
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
            putWithEviction(SHELL_CACHE, req, res.clone(), 20)
          }
          return res
        })
      }),
    )
    return
  }

  // ── /api/news → FRESH-CACHE-FIRST, STALE-NETWORK-FIRST ──
  // Cache younger than REVALIDATE_NEWS_MS: serve it with ZERO network
  // activity (the big Vercel-invocation saver — unchanged from v20).
  // Cache older than that (or missing): go NETWORK-FIRST. The server
  // answers from its Firebase cache in ~200-600ms, so users online never
  // see news older than ~5 minutes. The cached copy is only used as an
  // OFFLINE fallback. (v21 — fixes "site opened with 3-day-old news".)
  if (req.url.includes('/api/news')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(API_CACHE)
        const cached = await cache.match(req)

        // Fresh cache hit → instant, no network at all.
        if (cached && cachedAgeMs(cached) <= REVALIDATE_NEWS_MS) {
          return cached
        }

        // Stale or missing → network first.
        try {
          const res = await fetch(req, { cache: 'no-store' })
          if (res.ok) {
            putWithEviction(API_CACHE, req, res.clone(), MAX_API_ENTRIES)
          }
          return res
        } catch {
          // Offline (or network error) → fall back to the stale cache so
          // the app still works offline; the client's own staleness heal
          // (page-client auto-refresh on old fetchedAt) handles the rest.
          if (cached) return cached
          return new Response(
            JSON.stringify({ topics: [], sourceCount: 0, articleCount: 0 }),
            { headers: { 'Content-Type': 'application/json' } },
          )
        }
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
        const cache = await caches.open(API_CACHE)
        const cached = await cache.match(req)

        // Summaries are effectively immutable (cached in Firebase forever)
        // — revalidate at most once per hour, not on every request.
        let networkFetch = null
        if (!cached || cachedAgeMs(cached) > REVALIDATE_SUMMARY_MS) {
          networkFetch = fetch(req, { cache: 'no-store' })
            .then((res) => {
              if (res.ok) putWithEviction(API_CACHE, req, res.clone(), MAX_API_ENTRIES)
              return res
            })
            .catch(() => null)
        }

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
        const cache = await caches.open(API_CACHE)
        const cached = await cache.match(req)

        // Revalidate only when the cached copy is older than the threshold.
        let networkFetch = null
        if (!cached || cachedAgeMs(cached) > REVALIDATE_NEWS_MS) {
          networkFetch = fetch(req, { cache: 'no-store' })
            .then((res) => {
              if (res.ok) putWithEviction(API_CACHE, req, res.clone(), MAX_API_ENTRIES)
              return res
            })
            .catch(() => null)
        }

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

  // ── /api/img → cache-first with EVICTION (images don't change) ──
  // Images are the biggest cache bloat contributor (hundreds of unique
  // URLs, each 30-200KB). Cache-first with putWithEviction keeps the
  // IMG_CACHE under MAX_IMG_ENTRIES. If evicted, the next request just
  // re-fetches from the network (transparent to the user).
  if (req.url.includes('/api/img')) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached
        return fetch(req).then((res) => {
          if (res.ok) {
            putWithEviction(IMG_CACHE, req, res.clone(), MAX_IMG_ENTRIES)
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
    // Badge icon MUST be monochrome (white on transparent) for Android.
    // Android shows a white square if the badge has color.
    badge: '/badge-96.png',
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
