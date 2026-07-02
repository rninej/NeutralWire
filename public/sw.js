// NeutralWire Service Worker
// Enables PWA install + basic offline support (cached pages work offline).

const CACHE_NAME = 'neutralwire-v1'
const STATIC_ASSETS = ['/', '/manifest.json', '/logo.svg']

// Install: pre-cache static assets.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)),
  )
  self.skipWaiting()
})

// Activate: clean up old caches.
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

// Fetch strategy:
// - For API requests (/api/*): network-first, fall back to cache if offline.
// - For navigation/page requests: network-first, fall back to cached "/".
// - For static assets: cache-first (they don't change often).
self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Only handle GET requests.
  if (request.method !== 'GET') return

  // Skip cross-origin requests (images from news sites, etc).
  if (url.origin !== self.location.origin) return

  // API requests: network-first.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache successful GET responses for offline use.
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

  // Navigation requests: network-first, fall back to cached home page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/').then((r) => r || caches.match(request))),
    )
    return
  }

  // Static assets: cache-first.
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
