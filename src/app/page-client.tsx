'use client'

import * as React from 'react'
import { useState, useEffect } from 'react'
import {
  RefreshCw,
  Search,
  AlertCircle,
  Loader2,
  TrendingUp,
  Filter,
  Info,
  Cloud,
  X,
  DollarSign,
  Heart,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import {
  CATEGORY_LABELS,
  PRIMARY_CATEGORIES,
  SECONDARY_CATEGORIES,
  type Category,
} from '@/lib/news-sources'
import { ThemeToggle } from '@/components/theme-toggle'
import { TopicCard } from '@/components/topic-card'
import { TopicDetail } from '@/components/topic-detail'
import { PwaInstallPrompt } from '@/components/pwa-install-prompt'
import { IosNotificationPrompt } from '@/components/ios-notification-prompt'
import { PwaOnboarding } from '@/components/pwa-onboarding'
import { ReferralDialog } from '@/components/referral-dialog'
import { BiasColumns } from '@/components/bias-columns'
import { SourceList } from '@/components/source-list'
import { CountryPicker } from '@/components/country-picker'
import { SearchResults } from '@/components/search-results'
import { cn } from '@/lib/utils'
import type { TopicArticle } from '@/lib/news-aggregator'
import type { CountryInfo } from '@/lib/country-detect'
import { detectCountryClient, DEFAULT_COUNTRY } from '@/lib/country-detect'
import { getDeviceId } from '@/lib/referral'
import {
  getInterests,
  getEngagement,
  personalizationBoost,
  bumpEngagementForTopic,
  getSeenTopics,
  markTopicSeen,
  type EngagementStats,
} from '@/lib/user-interests'

/**
 * Subscribe to push notifications via the Push API.
 *
 * This gets a push subscription from the browser and sends it to the
 * server (/api/push/subscribe) which stores it in Firebase. The cron
 * endpoint (/api/push/send) then uses it to send real background push
 * messages that wake up the device even when the app is closed.
 *
 * This is the ONLY reliable way to send notifications when the PWA is
 * not open — service worker setTimeout doesn't work because the SW gets
 * killed by the browser.
 */
async function subscribeToPush(deviceId: string): Promise<void> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
  if (!('PushManager' in window)) return

  // Guard: only attempt subscription once per page load (prevents the
  // "blocked → retry → blocked" loop where subscribe() fails and the
  // next page load tries again).
  if ((window as unknown as { __pushSubscribed?: boolean }).__pushSubscribed) return
  ;(window as unknown as { __pushSubscribed?: boolean }).__pushSubscribed = true

  try {
    const reg = await navigator.serviceWorker.ready

    // Detect if we're running in the installed PWA (standalone mode).
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true

    // Check if we already have a subscription.
    let subscription = await reg.pushManager.getSubscription()
    if (!subscription) {
      // Fetch the VAPID public key from the server.
      const vapidRes = await fetch('/api/push/vapid')
      if (!vapidRes.ok) return
      const { publicKey } = await vapidRes.json()
      if (!publicKey) return

      // Convert the VAPID key to a Uint8Array for the subscribe() call.
      const applicationServerKey = urlBase64ToUint8Array(publicKey)
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      })
    }

    // Send the subscription to the server with the isStandalone flag.
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        subscription: subscription.toJSON(),
        isStandalone,
      }),
    })
  } catch (err) {
    // If subscribe() fails (e.g. permission denied, push blocked),
    // do NOT retry. The user needs to fix their browser settings.
    console.warn('[push] subscribe failed (will not retry):', err)
  }
}

/**
 * Convert a base64 URL string to a Uint8Array (needed for the Push API).
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const output = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    output[i] = rawData.charCodeAt(i)
  }
  return output
}

type View = 'feed' | 'columns' | 'sources'

interface NewsResponse {
  category: string
  country?: string
  countryName?: string
  topics: TopicArticle[]
  cached: boolean
  fresh?: boolean
  staleMs?: number
  fetchedAt: string
  sourceCount: number
  articleCount?: number
  ms?: number
  error?: string
  detail?: string
}

interface SearchResponse {
  query: string
  hits: Array<{
    topic: TopicArticle
    article: TopicArticle['articles'][number]
    matchedField: 'title' | 'summary' | 'source'
    snippet: string
  }>
  total: number
  categoriesSearched: number
  ms: number
}

export default function Home() {
  // --- Country detection ---
  const [country, setCountry] = useState<CountryInfo | null>(null)
  // Only render time-dependent values after mount (avoids hydration mismatch
  // — server uses UTC, client uses local timezone).
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // --- Category / view state ---
  // On mount, check URL for ?category= param (set by PWA shortcuts or
  // user sharing a subtopic link). This lets each subtopic have its own URL
  // (e.g. /?category=sports) that survives page refresh.
  const [category, setCategoryState] = useState<Category>(() => {
    if (typeof window === 'undefined') return 'relevant'
    const params = new URLSearchParams(window.location.search)
    const cat = params.get('category') as Category | null
    const validCategories: Category[] = [
      'relevant', 'mycountry', 'top', 'world', 'politics',
      'business', 'technology', 'science', 'health', 'sports',
    ]
    return cat && validCategories.includes(cat) ? cat : 'relevant'
  })
  const [view, setView] = useState<View>('feed')

  // ── Category ref (always-current value, used by URL listeners + fetch guard) ──
  // Declared here (before the URL-listener useEffect) so the listener can
  // read the latest category without re-subscribing on every change.
  const categoryRef = React.useRef(category)
  useEffect(() => {
    categoryRef.current = category
  }, [category])

  // ── Click guard: suppress URL-driven state updates briefly after a click ──
  // This eliminates the race where visibilitychange/pageshow fires right
  // after a tab click and overrides the click with a stale URL read.
  // Set to a timestamp when a click happens; URL listeners ignore events
  // for 400ms after.
  const lastClickAtRef = React.useRef(0)

  // Wrapper that updates BOTH state AND the URL.
  // This fixes:
  //   1. Double-highlight glitch (state + URL were out of sync)
  //   2. Refresh losing the subtopic (URL now has ?category=)
  //   3. Each subtopic having its own shareable link
  const setCategory = React.useCallback((cat: Category) => {
    // Record the click time so URL listeners don't override it
    lastClickAtRef.current = Date.now()
    setCategoryState(cat)
    categoryRef.current = cat // update ref immediately (not just via effect)
    // Update the URL without triggering a full page reload.
    // Use replaceState (not pushState) so the back button doesn't cycle
    // through every category the user tapped.
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href)
      // Remove ?topic= if present (we're switching categories, not opening a topic)
      url.searchParams.delete('topic')
      if (cat === 'relevant') {
        // 'relevant' is the default — remove the param for a clean URL
        url.searchParams.delete('category')
      } else {
        url.searchParams.set('category', cat)
      }
      window.history.replaceState({}, '', url.toString())
    }
  }, [])

  // Listen for popstate (back/forward) to update category from URL.
  // Also listen for visibilitychange + pageshow — when a PWA is launched via
  // a home-screen shortcut while already running, the browser navigates the
  // existing client to the shortcut URL (e.g. /?category=world). The
  // useState initializer does NOT re-run (React already mounted), so we must
  // manually re-read the ?category= param when the page becomes visible again.
  //
  // RACE-CONDITION GUARDS (eliminate double-highlight + click-revert bugs):
  //   1. Click guard: if a tab was clicked <400ms ago, IGNORE the URL event.
  //      This stops visibilitychange (which can fire spuriously on mobile when
  //      the address bar shows/hides or keyboard appears) from reverting a
  //      user's click.
  //   2. No-redundant-set: only call setCategoryState if the URL category
  //      DIFFERS from the current categoryRef value. Redundant sets can
  //      trigger unnecessary re-renders that race with pending clicks.
  useEffect(() => {
    const validCategories: Category[] = [
      'relevant', 'mycountry', 'top', 'world', 'politics',
      'business', 'technology', 'science', 'health', 'sports',
    ]
    const readCategoryFromUrl = () => {
      // Click guard: if a click happened very recently, the URL was already
      // updated by setCategory — don't let a spurious visibility/pageshow
      // event override it with a (possibly stale) URL read.
      if (Date.now() - lastClickAtRef.current < 400) return

      const params = new URLSearchParams(window.location.search)
      // Don't override if a topic is open (/?topic= takes priority)
      if (params.has('topic')) return
      const cat = params.get('category') as Category | null
      const resolved = cat && validCategories.includes(cat) ? cat : 'relevant'
      // No-redundant-set: only update if the URL differs from current state.
      // This prevents unnecessary re-renders that could race with a click.
      if (resolved !== categoryRef.current) {
        setCategoryState(resolved)
      }
    }
    const handlePopState = () => readCategoryFromUrl()
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') readCategoryFromUrl()
    }
    const handlePageshow = () => {
      // pageshow fires on initial load AND on BFCache restore (PWA resume)
      readCategoryFromUrl()
    }
    window.addEventListener('popstate', handlePopState)
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('pageshow', handlePageshow)
    return () => {
      window.removeEventListener('popstate', handlePopState)
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('pageshow', handlePageshow)
    }
  }, [])

  // --- Search state ---
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [apiSearchLoading, setApiSearchLoading] = useState(false)
  const [apiSearchResult, setApiSearchResult] = useState<SearchResponse | null>(null)
  const [localSearchAttempted, setLocalSearchAttempted] = useState(false)

  // --- News data state ---
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [topics, setTopics] = useState<TopicArticle[]>([])
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null)
  const [isCached, setIsCached] = useState(false)
  const [isFresh, setIsFresh] = useState(true)
  const [articleCount, setArticleCount] = useState(0)
  const [minCoverage, setMinCoverage] = useState(1)
  const [loadMs, setLoadMs] = useState<number | null>(null)

  // --- Infinite scroll state ---
  // The API returns 24 topics per fetch. When the user scrolls to the
  // bottom, we increase displayCount by 24 and fetch the next page
  // (?offset=24, ?offset=48, etc.). This continues until no more topics.
  const [displayCount, setDisplayCount] = useState(24)
  const [olderTopics, setOlderTopics] = useState<TopicArticle[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const sentinelRef = React.useRef<HTMLDivElement | null>(null)

  // Reset infinite scroll when category/country changes
  useEffect(() => {
    setDisplayCount(24)
    setOlderTopics([])
    setHasMore(true)
  }, [category, country, minCoverage])

  // --- Infinite scroll: fetch older topics when sentinel is visible ---
  const loadMore = React.useCallback(async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const offset = topics.length + olderTopics.length
      const params = new URLSearchParams({
        category,
        limit: '24',
        minCoverage: String(minCoverage),
        offset: String(offset),
      })
      if (country && (category === 'relevant' || category === 'mycountry')) {
        params.set('country', country.code)
      }
      const res = await fetch(`/api/news?${params.toString()}`, { cache: 'no-store' })
      const json: NewsResponse = await res.json()
      if (!res.ok || json.error) {
        setHasMore(false)
        return
      }
      const newTopics = json.topics || []
      if (newTopics.length === 0) {
        setHasMore(false)
      } else {
        // Dedup: don't add topics we already have
        const existingIds = new Set([
          ...topics.map((t) => t.topicId),
          ...olderTopics.map((t) => t.topicId),
        ])
        const unique = newTopics.filter((t) => !existingIds.has(t.topicId))
        if (unique.length === 0) {
          setHasMore(false)
        } else {
          setOlderTopics((prev) => [...prev, ...unique])
          if (unique.length < 24) setHasMore(false)
        }
      }
    } catch {
      setHasMore(false)
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, hasMore, topics, olderTopics, category, minCoverage, country])

  // IntersectionObserver — triggers loadMore when sentinel is visible
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMore()
        }
      },
      { rootMargin: '200px' }, // start loading 200px before reaching the bottom
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [loadMore])

  // --- Detail overlay state ---
  const [detailTopic, setDetailTopic] = useState<TopicArticle | null>(null)
  const detailTopicRef = React.useRef<TopicArticle | null>(null)
  useEffect(() => {
    detailTopicRef.current = detailTopic
  }, [detailTopic])

  // --- User interests + engagement + seen-topics (for personalization) ---
  const [interests, setInterestsState] = useState<string[]>([])
  const [engagement, setEngagement] = useState<EngagementStats>({})
  const [seenTopics, setSeenTopics] = useState<Record<string, number>>({})

  // Load interests + engagement + seen-topics from localStorage on mount,
  // and refresh whenever the onboarding flow saves new interests.
  useEffect(() => {
    const load = () => {
      setInterestsState(getInterests())
      setEngagement(getEngagement())
      setSeenTopics(getSeenTopics())
    }
    load()
    window.addEventListener('neutralwire:interests-changed', load)
    window.addEventListener('neutralwire:engagement-changed', load)
    // Refresh engagement every 30s so the boost stays fresh while reading
    const interval = setInterval(load, 30000)
    return () => {
      window.removeEventListener('neutralwire:interests-changed', load)
      window.removeEventListener('neutralwire:engagement-changed', load)
      clearInterval(interval)
    }
  }, [])

  // Track engagement when a user opens a topic detail.
  // Also marks the topic as "seen" so it gets demoted in the feed (users
  // see fresh content instead of stories they already read).
  const handleOpenDetail = React.useCallback((topic: TopicArticle) => {
    setDetailTopic(topic)
    markTopicSeen(topic.topicId)
    setSeenTopics(getSeenTopics())
    const deviceId = typeof window !== 'undefined' ? getDeviceId() : ''
    if (deviceId) {
      bumpEngagementForTopic(deviceId, topic.title, topic.summary || '', 'click')
      // Update local state shortly so the boost is visible next render
      setTimeout(() => {
        setEngagement(getEngagement())
        window.dispatchEvent(new CustomEvent('neutralwire:engagement-changed'))
      }, 200)
    }
  }, [])

  // Keep a ref so async functions (fetchData) can call the latest
  // handleOpenDetail without re-triggering the fetchData effect.
  const handleOpenDetailRef = React.useRef(handleOpenDetail)
  useEffect(() => {
    handleOpenDetailRef.current = handleOpenDetail
  }, [handleOpenDetail])

  // --- REDUNDANT topic-open watcher (foolproof) ---
  // Multiple layers ensure the topic ALWAYS opens when ?topic= is in the URL
  // or when the SW posts an 'open-topic' message.
  //
  // Failure modes this covers:
  //   1. App already open + SW navigate() doesn't trigger React re-render
  //      → SW posts 'open-topic' message, caught here
  //   2. ?topic= param present but fetchData hasn't loaded the topic yet
  //      → this effect polls the /api/topic/[id] endpoint with retry
  //   3. Topic not in current category's cache
  //      → /api/topic/[id] searches ALL categories + the archive
  //   4. /api/topic/[id] fails transiently
  //      → retries with backoff (1s, 2s, 4s)
  //   5. User navigates back/forward changing the URL
  //      → popstate listener re-triggers the topic-open flow
  useEffect(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const openTopicFromUrl = async () => {
      const urlParams = new URLSearchParams(window.location.search)
      const topicId = urlParams.get('topic')
      if (!topicId) return

      // Already open? Don't re-open.
      if (detailTopicRef.current?.topicId === topicId) return

      // First, check if the topic is already in the loaded topics list
      // (fastest path — no API call needed).
      const found = topics.find((t) => t.topicId === topicId)
      if (found) {
        handleOpenDetailRef.current?.(found)
        return
      }

      // Not in the loaded list — fetch from /api/topic/[id]
      // Retry with exponential backoff: 0ms, 1000ms, 2000ms, 4000ms
      const delays = [0, 1000, 2000, 4000]
      for (let i = 0; i < delays.length; i++) {
        if (cancelled) return
        if (i > 0) {
          await new Promise((resolve) => {
            retryTimer = setTimeout(resolve, delays[i])
          })
          if (cancelled) return
        }

        try {
          const topicRes = await fetch(`/api/topic/${topicId}`, { cache: 'no-store' })
          if (!topicRes.ok) {
            // 404 = topic doesn't exist at all, stop retrying
            if (topicRes.status === 404) {
              console.warn(`[topic-watcher] Topic ${topicId} not found (404)`)
              return
            }
            // 5xx = transient, retry
            continue
          }
          const topicJson = await topicRes.json()
          if (cancelled) return
          if (topicJson.topic) {
            handleOpenDetailRef.current?.(topicJson.topic)
            return
          }
        } catch {
          // network error — retry
          continue
        }
      }

      // All retries failed — last resort, the topic just isn't available.
      console.warn(`[topic-watcher] Failed to open topic ${topicId} after ${delays.length} attempts`)
    }

    // Trigger on mount (covers ?topic= in initial URL)
    openTopicFromUrl()

    // Trigger on URL changes (popstate — back/forward, SW navigate)
    const popstateHandler = () => openTopicFromUrl()
    window.addEventListener('popstate', popstateHandler)

    // Trigger on SW 'open-topic' message (covers app-already-open case)
    const messageHandler = (event: MessageEvent) => {
      if (event.data?.type === 'open-topic' && event.data?.topicId) {
        // The topicId might not be in our current `topics` array (different
        // category loaded), so always go through the full openTopicFromUrl
        // flow which falls back to /api/topic/[id].
        // But first, ensure the URL has ?topic= so the topic-open history
        // entry is correct.
        if (!window.location.search.includes(`topic=${event.data.topicId}`)) {
          const url = new URL(window.location.href)
          url.searchParams.set('topic', event.data.topicId)
          window.history.pushState({ detailOpen: true }, '', url.toString())
        }
        openTopicFromUrl()
      }
    }
    navigator.serviceWorker?.addEventListener('message', messageHandler)
    window.addEventListener('message', messageHandler)

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
      window.removeEventListener('popstate', popstateHandler)
      navigator.serviceWorker?.removeEventListener('message', messageHandler)
      window.removeEventListener('message', messageHandler)
    }
  }, [topics])

  // --- Referral dialog state ---
  const [referralOpen, setReferralOpen] = useState(false)

  // --- Referral + session tracking ---
  useEffect(() => {
    const deviceId = getDeviceId()
    const urlParams = new URLSearchParams(window.location.search)
    const refCode = urlParams.get('ref')

    // Track the referral click + register device.
    fetch('/api/referral/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, referralCode: refCode }),
    }).catch(() => {})

    // Track session activity every 15 seconds.
    let sessionInterval: ReturnType<typeof setInterval>
    const startSessionTracking = () => {
      sessionInterval = setInterval(() => {
        fetch('/api/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId, seconds: 15, referralCode: refCode }),
        }).catch(() => {})
      }, 15000)
    }
    startSessionTracking()

    // Detect PWA install and report it.
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      // iOS Safari standalone check
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true

    if (isStandalone) {
      fetch('/api/pwa-installed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, referralCode: refCode }),
      }).catch(() => {})
    }

    // Also listen for the appinstalled event.
    const installedHandler = () => {
      fetch('/api/pwa-installed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, referralCode: refCode }),
      }).catch(() => {})

      // Auto-open the PWA as soon as it's installed.
      // The browser already installed it; we just need to navigate to it
      // in standalone mode. On Android/Chrome, the install prompt opens
      // the PWA automatically. On iOS, we can't programmatically open
      // the PWA, but we can reload the page in standalone context.
      // The best we can do is reload — if the user opens the PWA from
      // the home screen, it will be standalone.
      try {
        // Small delay to let the install complete
        setTimeout(() => {
          window.location.reload()
        }, 500)
      } catch {
        // silent
      }
    }
    window.addEventListener('appinstalled', installedHandler)

    // --- Notification permission + push subscription ---
    // On iOS: the IosNotificationPrompt component handles the permission
    // request (requires a user tap). But AFTER permission is granted
    // (on any subsequent page load), we still need to create the push
    // subscription.
    //
    // On Android/Chrome: auto-request permission IMMEDIATELY (no delay).
    // If permission is 'denied' (blocked in site settings), do NOT retry —
    // just stop. The user must unblock in site settings manually.
    const NOTIF_ASKED_KEY = 'neutralwire:notif-asked'
    const NOTIF_DENIED_KEY = 'neutralwire:notif-denied'

    // Detect iOS
    const ua = window.navigator.userAgent.toLowerCase()
    const isIOS = /iphone|ipad|ipod/.test(ua) && !(window as unknown as { MSStream?: unknown }).MSStream

    // Auto-request permission only in PWA (standalone mode), not browser tabs.
    // Desktop browsers are also skipped.
    const isStandaloneMode =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true

    const isDesktopBrowser =
      window.innerWidth >= 1024 &&
      !/android|mobile|iphone|ipad|ipod|windows phone/i.test(ua) &&
      !('ontouchstart' in window)

    // Only request notifications in PWA (standalone) on mobile
    if (isStandaloneMode && !isIOS && !isDesktopBrowser && 'Notification' in window && 'serviceWorker' in navigator) {
      // If permission is already granted or denied, don't ask again.
      if (Notification.permission === 'default') {
        // Request permission IMMEDIATELY (no setTimeout delay).
        // Wrap in a microtask so it doesn't block the first render.
        Promise.resolve().then(async () => {
          try {
            const permission = await Notification.requestPermission()
            localStorage.setItem(NOTIF_ASKED_KEY, 'true')
            const enabled = permission === 'granted'
            if (permission === 'denied') {
              localStorage.setItem(NOTIF_DENIED_KEY, 'true')
            }
            fetch('/api/notifications', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ deviceId, enabled, frequency: 'daily3' }),
            }).catch(() => {})
            if (enabled) {
              await subscribeToPush(deviceId)
            }
          } catch {
            localStorage.setItem(NOTIF_ASKED_KEY, 'true')
          }
        })
      }
    }

    // ── PUSH SUBSCRIPTION (only in PWA, not browser tabs) ──
    if (
      isStandaloneMode &&
      'Notification' in window &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      Notification.permission === 'granted'
    ) {
      fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, enabled: true }),
      }).catch(() => {})
      // Wait for SW to be ready, then subscribe to push.
      navigator.serviceWorker.ready.then(() => {
        subscribeToPush(deviceId).catch(() => {})
      }).catch(() => {})
    }

    return () => {
      clearInterval(sessionInterval)
      window.removeEventListener('appinstalled', installedHandler)
    }
  }, [])

  // --- Refs for race-condition protection ---
  // NOTE: categoryRef is declared earlier (near setCategory) so the URL
  // listener useEffect can read the latest category. reqIdRef guards the
  // async fetch against stale responses when the user switches categories.
  const reqIdRef = React.useRef(0)

  // --- Country detection on first load ---
  // Client-side detection is PRIMARY (runs in the user's browser, sees
  // their real public IP). Server-side detection is unreliable behind
  // the Caddy gateway which may not forward the real client IP.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // Check localStorage for a manual override first.
      try {
        const manual = localStorage.getItem('neutralwire:country-manual')
        if (manual) {
          const parsed = JSON.parse(manual) as CountryInfo
          if (!cancelled) {
            setCountry(parsed)
            return
          }
        }
      } catch {
        // ignore
      }

      // Client-side auto-detection (ipwho.is → reallyfreegeoip → cloudflare trace).
      const client = await detectCountryClient()
      if (!cancelled) setCountry(client || DEFAULT_COUNTRY)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // --- Manual country override ---
  const handleCountryChange = React.useCallback((c: CountryInfo) => {
    setCountry(c)
    try {
      localStorage.setItem('neutralwire:country-manual', JSON.stringify(c))
    } catch {
      // ignore
    }
  }, [])

  // --- Debounced search ---
  useEffect(() => {
    setLocalSearchAttempted(false)
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim())
    }, 250)
    return () => clearTimeout(t)
  }, [search])

  // --- Filter topics locally for instant feedback ---
  // For the "relevant" tab (default), we also apply a personalization
  // boost based on the user's selected interests + per-sector engagement
  // scores. The boost RE-ORDERS topics (high-coverage stories still rank
  // well, but stories matching user interests rise to the top).
  const filteredTopics = React.useMemo(() => {
    let list = topics
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase()
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.summary.toLowerCase().includes(q) ||
          t.articles.some(
            (a) =>
              a.title.toLowerCase().includes(q) ||
              a.sourceName.toLowerCase().includes(q),
          ),
      )
    }

    // ── Seen-topic demotion ──
    // Topics the user has already opened get pushed DOWN in the feed so
    // they see fresh content. We apply a score penalty (-15) to seen
    // topics. This runs even without interests/engagement so all users
    // benefit. Seen topics are NOT hidden (they still appear, just lower).
    const seenTopicIds = new Set(Object.keys(seenTopics))

    // Only personalise when there's no active search (otherwise the user
    // is looking for something specific and we shouldn't hide results).
    const hasInterests = interests.length > 0
    const hasEngagement = Object.keys(engagement).length > 0
    if (debouncedSearch || (!hasInterests && !hasEngagement && seenTopicIds.size === 0)) {
      return list
    }

    // Compute boost for each topic and sort descending. Stable sort
    // preserves original order for ties (so equal-boost stories keep
    // their aggregator ordering, which already prioritises local + fresh).
    //
    // Seen topics get a -15 penalty (demoted below unseen stories of
    // similar coverage).
    // Topics with very negative scores (< -10) are HIDDEN — the user has
    // strongly disliked this sector, so we don't show them at all.
    const scored = list
      .map((t) => ({
        topic: t,
        score: personalizationBoost(t, interests, engagement) - (seenTopicIds.has(t.topicId) ? 15 : 0),
      }))
      .sort((a, b) => b.score - a.score)

    // Hide heavily-disliked topics (score < -10)
    const visible = scored.filter((entry) => entry.score > -10)
    // If hiding everything would leave nothing, show all (better than empty)
    const finalList = visible.length > 0 ? visible : scored
    return finalList.map((entry) => entry.topic)
  }, [topics, debouncedSearch, interests, engagement, seenTopics])

  // Track whether local search yielded no results — triggers API search.
  useEffect(() => {
    if (debouncedSearch && filteredTopics.length === 0 && topics.length > 0) {
      setLocalSearchAttempted(true)
    } else if (debouncedSearch && filteredTopics.length > 0) {
      setApiSearchResult(null)
      setLocalSearchAttempted(false)
    }
  }, [debouncedSearch, filteredTopics.length, topics.length])

  // --- API search fallback (when local search yields nothing) ---
  useEffect(() => {
    if (!localSearchAttempted || !debouncedSearch) return
    let cancelled = false
    setApiSearchLoading(true)
    ;(async () => {
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(debouncedSearch)}&limit=30`,
          { cache: 'no-store' },
        )
        const json: SearchResponse = await res.json()
        if (!cancelled) setApiSearchResult(json)
      } catch {
        if (!cancelled) setApiSearchResult(null)
      } finally {
        if (!cancelled) setApiSearchLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [localSearchAttempted, debouncedSearch])

  // --- Fetch news (cache-first from Firebase) ---
  const fetchData = React.useCallback(
    async (cat: Category, mc: number, country?: CountryInfo | null) => {
      // For virtual categories, wait until country is detected.
      // This prevents fetching with the wrong country on initial load.
      const isVirtual = cat === 'relevant' || cat === 'mycountry'
      if (isVirtual && !country) return

      const reqId = ++reqIdRef.current
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({
          category: cat,
          limit: '24',
          minCoverage: String(mc),
        })
        if (country && isVirtual) {
          params.set('country', country.code)
        }
        const res = await fetch(`/api/news?${params.toString()}`, { cache: 'no-store' })
        const json: NewsResponse = await res.json()
        if (reqId !== reqIdRef.current) return
        if (!res.ok || json.error) {
          throw new Error(json.error || `Failed (${res.status})`)
        }
        // Progressive loading: show first 5 topics immediately, then the
        // rest after a tiny delay. This makes the page feel instant —
        // the user sees content right away while the full list renders.
        const allTopics = json.topics
        const firstBatch = allTopics.slice(0, 5)

        setTopics(firstBatch)
        setFetchedAt(new Date(json.fetchedAt))
        setIsCached(!!json.cached)
        setIsFresh(json.fresh !== false)
        setArticleCount(json.articleCount ?? 0)
        setLoadMs(json.ms ?? null)

        // Append the rest after a 0ms timeout (lets browser paint first 5).
        if (allTopics.length > 5) {
          setTimeout(() => {
            if (reqId === reqIdRef.current) {
              setTopics(allTopics)
            }
          }, 0)
        }

        // If there's a ?topic= URL param (from a shared link), auto-open
        // that topic's detail view.
        const urlParams = new URLSearchParams(window.location.search)
        const topicParam = urlParams.get('topic')
        if (topicParam && !detailTopicRef.current) {
          const found = allTopics.find((t) => t.topicId === topicParam)
          if (found) {
            // Use handleOpenDetail to track engagement
            handleOpenDetailRef.current?.(found)
          } else {
            // Search ALL categories via API.
            try {
              const topicRes = await fetch(`/api/topic/${topicParam}`, { cache: 'no-store' })
              if (topicRes.ok) {
                const topicJson = await topicRes.json()
                if (topicJson.topic) handleOpenDetailRef.current?.(topicJson.topic)
              }
            } catch {
              // silent
            }
          }
        }
      } catch (e) {
        if (reqId !== reqIdRef.current) return
        setError(e instanceof Error ? e.message : 'Failed to load news')
        setTopics([])
      } finally {
        if (reqId === reqIdRef.current) setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    fetchData(category, minCoverage, country)
  }, [category, minCoverage, country, fetchData])

  // --- Background refresh when stale ---
  const bgRefresh = React.useCallback(
    async (cat: Category, mc: number, country?: CountryInfo | null) => {
      setRefreshing(true)
      try {
        const params = new URLSearchParams({
          category: cat,
          limit: '24',
          minCoverage: String(mc),
        })
        if (country && (cat === 'relevant' || cat === 'mycountry')) {
          params.set('country', country.code)
        }
        const res = await fetch(`/api/refresh?${params.toString()}`, { cache: 'no-store' })
        const json: NewsResponse = await res.json()
        if (!res.ok || json.error) return
        if (cat !== categoryRef.current) return
        setTopics(json.topics)
        setFetchedAt(new Date(json.fetchedAt))
        setIsCached(false)
        setIsFresh(true)
        setArticleCount(json.articleCount ?? 0)
      } catch {
        // silent
      } finally {
        setRefreshing(false)
      }
    },
    [],
  )

  // Auto-trigger silent background refresh when stale (no UI indication).
  useEffect(() => {
    if (!isFresh && !loading) {
      const t = setTimeout(async () => {
        try {
          const params = new URLSearchParams({
            category,
            limit: '24',
            minCoverage: String(minCoverage),
          })
          if (country && (category === 'relevant' || category === 'mycountry')) {
            params.set('country', country.code)
          }
          const res = await fetch(`/api/refresh?${params.toString()}`, { cache: 'no-store' })
          const json: NewsResponse = await res.json()
          if (!res.ok || json.error) return
          if (category !== categoryRef.current) return
          setTopics(json.topics)
          setFetchedAt(new Date(json.fetchedAt))
          setIsCached(false)
          setIsFresh(true)
          setArticleCount(json.articleCount ?? 0)
        } catch {
          // silent
        }
      }, 2000)
      return () => clearTimeout(t)
    }
  }, [isFresh, loading, category, minCoverage, country])

  const handleClearSearch = () => {
    setSearch('')
    setDebouncedSearch('')
    setApiSearchResult(null)
    setLocalSearchAttempted(false)
  }

  const featured = filteredTopics[0]
  const rest = filteredTopics.slice(1)
  const showApiSearch = localSearchAttempted && debouncedSearch

  return (
    <div className="flex min-h-screen flex-col">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
          <a href="/" className="flex items-center gap-2 font-bold">
            <img
              src="/icon-192.png"
              alt="NeutralWire"
              className="h-7 w-7 rounded"
            />
            <span className="hidden sm:inline">NeutralWire</span>
          </a>

          {/* Country picker (clickable, with manual override) */}
          <CountryPicker country={country} onChange={handleCountryChange} />

          {/* Cache indicator */}
          <Badge
            variant="outline"
            className="hidden gap-1 text-[10px] font-normal sm:inline-flex"
            title={isFresh ? 'Data is fresh' : 'Showing cached data — refreshing'}
          >
            {isFresh ? (
              <>
                <Cloud className="h-3 w-3 text-emerald-500" />
                Fresh
              </>
            ) : (
              <>
                <Cloud className="h-3 w-3 text-amber-500" />
                Cached
              </>
            )}
            {loadMs !== null && !loading && (
              <span className="ml-1 opacity-60">{loadMs}ms</span>
            )}
          </Badge>

          <div className="ml-auto flex items-center gap-2">
            <a
              href="https://ko-fi.com/neutralwire"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-pink-500 hover:bg-pink-500/10 transition-colors"
              title="Support NeutralWire on Ko-fi"
            >
              <Heart className="h-4 w-4 fill-pink-400 text-pink-500" strokeWidth={2} />
              <span className="hidden sm:inline">Support</span>
            </a>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setReferralOpen(true)}
              className="gap-1.5"
            >
              <DollarSign className="h-4 w-4" />
              <span className="hidden sm:inline">Refer</span>
            </Button>
            <ThemeToggle />
          </div>
        </div>

        {/* Category nav: all categories shown flat (no "More" expandable) */}
        <div className="mx-auto max-w-7xl px-4 pb-2">
          <div className="flex flex-wrap items-center gap-1">
            {PRIMARY_CATEGORIES.map((c) => (
              <CategoryTab
                key={c}
                cat={c}
                active={category === c}
                onClick={() => setCategory(c)}
                country={country}
              />
            ))}

            <div className="mx-1 h-5 w-px bg-border" />

            {SECONDARY_CATEGORIES.map((c) => (
              <CategoryTab
                key={c}
                cat={c}
                active={category === c}
                onClick={() => setCategory(c)}
                country={country}
              />
            ))}
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        {/* Search bar */}
        <div className="mb-4 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search all cached articles across the spectrum…"
              className="pl-8 pr-8"
            />
            {search && (
              <button
                type="button"
                onClick={handleClearSearch}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Search results (full-catalog API search) — replaces the normal view
            when local search yields nothing and an API search is running. */}
        {showApiSearch ? (
          <SearchResults
            query={debouncedSearch}
            loading={apiSearchLoading}
            result={apiSearchResult}
            onOpenTopic={handleOpenDetail}
          />
        ) : (
          <>
            {/* View switcher + meta */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <Tabs value={view} onValueChange={(v) => setView(v as View)}>
                <TabsList>
                  <TabsTrigger value="feed" className="gap-1.5 text-xs">
                    <TrendingUp className="h-3.5 w-3.5" /> Feed
                  </TabsTrigger>
                  <TabsTrigger value="columns" className="gap-1.5 text-xs">
                    <Filter className="h-3.5 w-3.5" /> Bias Split
                  </TabsTrigger>
                  <TabsTrigger value="sources" className="gap-1.5 text-xs">
                    Sources
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                <span>
                  {loading
                    ? 'Loading…'
                    : refreshing
                      ? 'Refreshing from RSS…'
                      : `${filteredTopics.length} topics · ${articleCount} articles`}
                </span>
                {fetchedAt && (
                  <span className="hidden items-center gap-1 sm:inline-flex">
                    · updated {mounted ? fetchedAt.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}
                    {isCached && !isFresh && (
                      <span className="text-amber-500">(cached)</span>
                    )}
                  </span>
                )}
                <select
                  value={minCoverage}
                  onChange={(e) => setMinCoverage(Number(e.target.value))}
                  className="rounded-md border bg-background px-1.5 py-1 text-xs"
                  aria-label="Minimum coverage filter"
                  title="Minimum sources per topic"
                >
                  <option value={1}>All stories</option>
                  <option value={2}>2+ sources</option>
                  <option value={3}>3+ sources</option>
                  <option value={4}>4+ sources</option>
                </select>
              </div>
            </div>

            {/* Bias legend */}
            <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
              <span className="font-semibold text-foreground">Bias legend:</span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-blue-500" />
                Left
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-zinc-500" />
                Center
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
                Right
              </span>
              <span className="ml-auto hidden items-center gap-1 sm:inline-flex">
                <Info className="h-3 w-3" />
                Bias ratings are community approximations, not authoritative.
              </span>
            </div>

            {/* Content */}
            {error ? (
              <Card className="flex flex-col items-center gap-3 p-12 text-center">
                <AlertCircle className="h-8 w-8 text-destructive" />
                <div>
                  <div className="font-semibold">Could not load news</div>
                  <div className="mt-1 text-sm text-muted-foreground">{error}</div>
                </div>
                <Button onClick={handleRefreshClick} variant="outline" size="sm">
                  <RefreshCw className="h-4 w-4" /> Try again
                </Button>
              </Card>
            ) : view === 'sources' ? (
              <SourceList />
            ) : loading ? (
              <LoadingState />
            ) : filteredTopics.length === 0 ? (
              <Card className="flex flex-col items-center gap-2 p-12 text-center text-muted-foreground">
                <AlertCircle className="h-6 w-6" />
                <div>
                  {debouncedSearch
                    ? `No topics match "${debouncedSearch}" — searching full catalog…`
                    : 'No topics found. Try a different category or lower the minimum coverage filter.'}
                </div>
              </Card>
            ) : view === 'columns' ? (
              <BiasColumns topics={filteredTopics} />
            ) : (
              <>
                {/* Topic grid — featured story is the first card, same size as others */}
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {featured && (
                    <TopicCard
                      key={featured.topicId + (featured.imageUrl || '')}
                      topic={featured}
                      variant="featured"
                      onOpenDetail={handleOpenDetail}
                    />
                  )}
                  {rest.map((t) => (
                    <TopicCard
                      key={t.topicId + (t.imageUrl || '')}
                      topic={t}
                      onOpenDetail={handleOpenDetail}
                    />
                  ))}
                  {/* Older topics loaded via infinite scroll */}
                  {olderTopics.map((t) => (
                    <TopicCard
                      key={t.topicId + (t.imageUrl || '')}
                      topic={t}
                      onOpenDetail={handleOpenDetail}
                    />
                  ))}
                </div>

                {/* Infinite scroll sentinel + loading animation */}
                <div ref={sentinelRef} className="flex justify-center py-8">
                  {loadingMore && (
                    <div className="grid w-full max-w-7xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="h-64 animate-pulse rounded-lg bg-muted/40" />
                      ))}
                    </div>
                  )}
                  {!loadingMore && !hasMore && (
                    <div className="text-sm text-muted-foreground">
                      You've reached the end of the news.
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t bg-muted/30 py-4 mt-auto">
        <div className="mx-auto max-w-7xl px-4 text-center text-xs text-muted-foreground">
          NeutralWire
        </div>
      </footer>

      {/* PWA install prompt (mobile only, dismissible) */}
      <PwaInstallPrompt />
      <IosNotificationPrompt />
      <PwaOnboarding />

      {/* Referral dialog */}
      {referralOpen && <ReferralDialog onClose={() => setReferralOpen(false)} />}

      {/* Detail overlay */}
      {detailTopic && (
        <TopicDetail
          topic={detailTopic}
          onClose={() => {
            // Clean up the ?topic= URL param when closing.
            const url = new URL(window.location.href)
            if (url.searchParams.has('topic')) {
              url.searchParams.delete('topic')
              // If we were opened via a shared link, we pushed a history
              // entry; go back to clean up. Otherwise just replace the URL.
              if (window.history.state?.detailOpen) {
                window.history.back()
              } else {
                window.history.replaceState({}, '', url.toString())
              }
            }
            setDetailTopic(null)
          }}
        />
      )}
    </div>
  )
}

function CategoryTab({
  cat,
  active,
  onClick,
  country,
}: {
  cat: Category
  active: boolean
  country?: CountryInfo | null
  onClick: () => void
}) {
  // For 'mycountry', show the user's actual country code (e.g. "UK", "US")
  // instead of the generic "My Country" label.
  const label = cat === 'mycountry'
    ? (country?.code && country.code !== 'INT' ? country.code.toUpperCase() : 'My Country')
    : CATEGORY_LABELS[cat]

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // Smaller text + tighter padding on mobile so all 10 categories
        // (Relevant, UK, Top Stories, World, Politics, Business,
        // Tech, Science, Health, Sports) fit in 2 lines.
        // sm: restores normal size on wider screens.
        'inline-flex items-center gap-1 rounded-md whitespace-nowrap text-[11px] px-2 py-1 sm:px-3 sm:py-1.5 sm:text-xs font-medium transition-colors',
        active
          ? 'bg-foreground text-background'
          : 'hover:bg-muted text-foreground/80',
      )}
    >
      {label}
    </button>
  )
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <Card className="h-72 animate-pulse bg-muted/40" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="h-64 animate-pulse bg-muted/40" />
        ))}
      </div>
      <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading from Firebase cache…
      </div>
    </div>
  )
}
