// NeutralWire Service Worker
// Enables PWA install, offline support, and daily notifications.

const CACHE_NAME = 'neutralwire-v2'
const STATIC_ASSETS = ['/', '/manifest.json', '/favicon-32.png']

// Notification schedule: 3 times per day (morning, lunch, evening).
// Times are in the user's local timezone (handled by the browser).
const NOTIFICATION_TIMES = [
  { hour: 8, minute: 0, title: 'Morning News', body: 'Catch up on what happened overnight.' },
  { hour: 13, minute: 0, title: 'Lunch News', body: 'Quick update on the biggest stories today.' },
  { hour: 20, minute: 0, title: 'Evening News', body: 'See how the day was covered across the spectrum.' },
]

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

  // Schedule daily notifications on activation.
  scheduleDailyNotifications()
})

// ---------- Message handler (from client) ----------
let notificationFrequency = 'daily3' // 'daily3' or 'all'

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SCHEDULE_NOTIFICATIONS') {
    scheduleDailyNotifications()
  }
  if (event.data && event.data.type === 'SET_FREQUENCY') {
    notificationFrequency = event.data.frequency || 'daily3'
    // Re-schedule with the new frequency.
    if (notificationFrequency === 'daily3') {
      scheduleDailyNotifications()
    } else {
      // For 'all' mode, set up a more frequent check (every 30 minutes).
      scheduleAllNewsNotifications()
    }
  }
})

// ---------- Notification scheduling ----------
async function scheduleDailyNotifications() {
  // Clear any existing scheduled notifications.
  const existing = await self.registration.getNotifications()
  existing.forEach((n) => n.close())

  // Schedule each notification for today (or tomorrow if the time has passed).
  const now = new Date()
  for (const slot of NOTIFICATION_TIMES) {
    let scheduled = new Date()
    scheduled.setHours(slot.hour, slot.minute, 0, 0)

    // If the time has already passed today, schedule for tomorrow.
    if (scheduled.getTime() <= now.getTime()) {
      scheduled.setDate(scheduled.getDate() + 1)
    }

    const delay = scheduled.getTime() - now.getTime()

    // Use setTimeout to show the notification at the scheduled time.
    // This works while the SW is active. For background delivery, we'd
    // need push notifications (which require a server), but this covers
    // the common case of the app being installed and the device awake.
    setTimeout(() => {
      self.registration.showNotification(slot.title, {
        body: slot.body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: `daily-${slot.hour}`,
        data: { url: '/' },
      })
    }, delay)
  }
}

// ---------- All-news notification mode ----------
// In 'all' mode, check for new stories every 30 minutes and notify
// if there's a new top story.
let allNewsInterval = null
async function scheduleAllNewsNotifications() {
  // Clear daily notifications.
  const existing = await self.registration.getNotifications()
  existing.forEach((n) => n.close())

  // Clear any previous interval.
  if (allNewsInterval) clearInterval(allNewsInterval)

  let lastTopStoryTitle = null

  // Check immediately, then every 30 minutes.
  const check = async () => {
    try {
      const res = await fetch('/api/news?category=top&limit=1&minCoverage=3')
      if (!res.ok) return
      const data = await res.json()
      if (data.topics && data.topics.length > 0) {
        const topStory = data.topics[0]
        if (topStory.title !== lastTopStoryTitle) {
          if (lastTopStoryTitle !== null) {
            // New story — notify.
            self.registration.showNotification('Breaking: ' + topStory.title.slice(0, 60), {
              body: topStory.summary?.slice(0, 100) || 'Tap to read more.',
              icon: '/icon-192.png',
              badge: '/icon-192.png',
              tag: 'breaking-news',
              data: { url: '/?topic=' + topStory.topicId },
            })
          }
          lastTopStoryTitle = topStory.title
        }
      }
    } catch {
      // silent
    }
  }
  check()
  allNewsInterval = setInterval(check, 30 * 60 * 1000) // 30 minutes
}

// ---------- Push event handler ----------
// This is what wakes up the service worker when a push message arrives,
// EVEN IF THE APP IS CLOSED. The push service (FCM/APNs) delivers the
// message to the device, which wakes up the service worker and fires
// this event.
self.addEventListener('push', (event) => {
  let data = {
    title: 'NeutralWire',
    body: 'New update',
    url: '/',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'neutralwire',
  }

  try {
    if (event.data) {
      data = { ...data, ...event.data.json() }
    }
  } catch {
    // If JSON parse fails, try as text
    if (event.data) {
      data.body = event.data.text()
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon,
      badge: data.badge,
      tag: data.tag,
      data: { url: data.url },
    }),
  )
})

// ---------- Notification click ----------
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      // Focus an existing tab if open, otherwise open a new one.
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          return client.focus()
        }
      }
      return self.clients.openWindow(event.notification.data?.url || '/')
    }),
  )
})

// ---------- Fetch strategy ----------
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
