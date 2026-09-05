'use client'

import * as React from 'react'
import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { AnimatePresence, motion } from 'framer-motion'
import {
  RefreshCw,
  Search,
  AlertCircle,
  X,
  UserCircle,
  Heart,
  WifiOff,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import {
  CATEGORY_LABELS,
  PRIMARY_CATEGORIES,
  SECONDARY_CATEGORIES,
  type Category,
} from '@/lib/news-sources'
import { ThemeToggle } from '@/components/theme-toggle'
import { TopicCard } from '@/components/topic-card'
import { PwaInstallPrompt } from '@/components/pwa-install-prompt'
import { CookieConsent } from '@/components/cookie-consent'
import { DEFAULT_POPUP_MODE, type PopupMode } from '@/lib/popup-mode'
import { CountryPicker } from '@/components/country-picker'
import { CategoryNav } from '@/components/category-nav'
import {
  SubtopicTabs,
  SubtopicTiles,
  SubtopicSheetNav,
  SubtopicDock,
  SubtopicMaxiPills,
  SubtopicHeaderDock,
} from '@/components/subtopic-navs'
import { cn, safeImageUrl } from '@/lib/utils'
import type { TopicArticle } from '@/lib/news-aggregator'
import type { CountryInfo } from '@/lib/country-detect'
import { detectCountryClient, detectCountryClientFresh, DEFAULT_COUNTRY } from '@/lib/country-detect'
import { getDeviceId } from '@/lib/referral'
import { trackPageView } from '@/lib/analytics-tracker'
import { reportInstallMetric, reportActiveMetric, reportAppOpenMetric } from '@/lib/pwa-metrics'
import { gateAllows, markGate } from '@/lib/client-call-gate'
import { usePlatform } from '@/lib/use-platform'
import { NAV_STYLE_EVENT, readNavOverride, type NavMode } from '@/lib/nav-override'
import { restoreGradient } from '@/lib/use-theme-reveal'
import { archiveTopicsInBackground } from '@/lib/background-archiver'
import {
  getInterests,
  getEngagement,
  personalizationBoost,
  bumpEngagementForTopic,
  getSeenTopics,
  markTopicSeen,
  getCountryNewsCount,
  bumpCountryNewsCount,
  type EngagementStats,
} from '@/lib/user-interests'
import { ScrollToTop } from '@/components/scroll-to-top'
// NOTE: ScrollToTop is no longer mounted — user requested the floating
// scroll-up button be removed. The component file is kept for reference.
// (The import above is what keeps the chunk alive in dev tooling — it is
// tree-shaken from the production bundle since nothing renders it.)

// ── Code splitting — heavy, interaction-gated UI ─────────────────────────
// These components total ~5,000 lines (~150KB+ gzipped). Loading them
// lazily takes them off the initial bundle so the PWA paints faster and
// cold-start JS parse time drops hard on mobile. The idle-preload effect
// in Home() warms the two hottest chunks (topic-detail + user-page)
// right after first paint, so the first tap still feels instant — and
// the service worker keeps every chunk cached for offline use.
// PwaInstallPrompt stays EAGER: it's the default-mode component and its
// research-timed engine needs to observe the session from t=0.
const TopicDetail = dynamic(
  () => import('@/components/topic-detail').then((m) => m.TopicDetail),
  { ssr: false, loading: () => <div className="fixed inset-0 z-50 bg-background" aria-hidden /> },
)
const UserPage = dynamic(
  () => import('@/components/user-page').then((m) => m.UserPage),
  { ssr: false, loading: () => <div className="fixed inset-0 z-50 bg-background/40 backdrop-blur-sm" aria-hidden /> },
)
const BiasColumns = dynamic(
  () => import('@/components/bias-columns').then((m) => m.BiasColumns),
  { ssr: false },
)
const SourceList = dynamic(
  () => import('@/components/source-list').then((m) => m.SourceList),
  { ssr: false },
)
const SearchResults = dynamic(
  () => import('@/components/search-results').then((m) => m.SearchResults),
  { ssr: false },
)
const PwaInstallPromptLegacy = dynamic(
  () => import('@/components/pwa-install-prompt-legacy').then((m) => m.PwaInstallPromptLegacy),
  { ssr: false },
)
const DonatePopupLegacy = dynamic(
  () => import('@/components/donate-popup-legacy').then((m) => m.DonatePopupLegacy),
  { ssr: false },
)
const IosNotificationPrompt = dynamic(
  () => import('@/components/ios-notification-prompt').then((m) => m.IosNotificationPrompt),
  { ssr: false },
)
const PwaOnboarding = dynamic(
  () => import('@/components/pwa-onboarding').then((m) => m.PwaOnboarding),
  { ssr: false },
)
const MilestoneCelebration = dynamic(
  () => import('@/components/milestone-celebration').then((m) => m.MilestoneCelebration),
  { ssr: false },
)

// ── Client call-gate keys (see src/lib/client-call-gate.ts) ──
// Skip provably-redundant idempotent server calls (Fluid CPU). The TTLs
// are heartbeats: a call still fires when its fields change OR when the
// TTL lapses, so server-side data loss self-heals within the window.
const GATE_DEVICE_REGISTER = 'device-register' // /api/referral/track (no ?ref=)
const DEVICE_REGISTER_TTL_MS = 24 * 60 * 60 * 1000
const GATE_SESSION_PING = 'session-ping' // /api/session immediate tz ping
const SESSION_PING_TTL_MS = 4.5 * 60 * 1000
const GATE_PUSH_SUB = 'push-sub' // /api/push/subscribe
const PUSH_SUB_TTL_MS = 24 * 60 * 60 * 1000
const GATE_NOTIF_BOOT = 'notif-boot' // /api/notifications {enabled:true} on boot
const NOTIF_BOOT_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000 // effectively once-ever
const GATE_PWA_INSTALLED = 'pwa-installed' // /api/pwa-installed on PWA launch
const PWA_INSTALLED_TTL_MS = 24 * 60 * 60 * 1000

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
    //
    // ── CPU GATE (Fluid) ── /api/push/subscribe performs a full device
    // read + full write in Firebase. It used to run on EVERY PWA launch
    // even though the subscription was byte-identical to the one already
    // stored. Now it only fires when the endpoint or the standalone flag
    // CHANGED, or once per 24h as a heartbeat (heals any server-side
    // data loss within a day). New/rotated endpoints (getSubscription()
    // returning a different value) and the first launch after install
    // (standalone flips) always post immediately.
    const subscribeFields = {
      endpoint: subscription.endpoint,
      standalone: isStandalone,
    }
    if (gateAllows(GATE_PUSH_SUB, subscribeFields, PUSH_SUB_TTL_MS)) {
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId,
          subscription: subscription.toJSON(),
          isStandalone,
        }),
      })
      if (res.ok) {
        markGate(GATE_PUSH_SUB, subscribeFields)
      }
    }
  } catch (err) {
    // If subscribe() fails (e.g. permission denied, push blocked),
    // do NOT retry. The user needs to fix their browser settings.
    console.warn('[push] subscribe failed (will not retry):', err)
  }
}

/**
 * Convert a base64 URL string to a Uint8Array (needed for the Push API).
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
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
  /** Blindspot sections grouped by source category (only for blindspots) */
  sections?: Record<string, TopicArticle[]>
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

// Which category-header design this visitor sees. Flipped for ALL users
// from /debug (POST /api/flags → Firebase). The INITIAL value comes from
// the server (page.tsx reads the flag during SSR) so the first paint is
// always the selected design — no default-then-swap flash on refresh.
type NavVariant =
  | 'cards' | 'classic' | 'tabs' | 'tiles' | 'sheet' | 'dock'
  | 'maxipills' | 'headerdock' | 'tabsarrow' | 'cardsarrow'

export default function Home({
  initialSubtopicNav,
  popupSystem = DEFAULT_POPUP_MODE,
}: {
  initialSubtopicNav?: NavVariant
  popupSystem?: PopupMode
}) {
  // --- Platform detection (Android / Apple / Other) ---
  // Sets body.platform-{android|apple|other} so the CSS glass rules in
  // globals.css apply the right backdrop-blur + bg opacity to sticky
  // elements. The return value is unused here — the side effect of
  // setting the body class is what matters.
  usePlatform()

  // ── Restore saved gradient on mount ──
  // If the user previously applied a custom gradient theme, re-apply it
  // so it persists across page refreshes. The solid theme is handled by
  // next-themes (stored in localStorage:neutralwire:theme), but the
  // gradient overlay needs manual restoration.
  useEffect(() => {
    restoreGradient()
  }, [])

  // ── Idle-preload the lazy chunks ──
  // The heavy overlays (topic detail, user page) are code-split above.
  // Right after the first paint, while the browser is idle, pull those
  // two chunks down so the first article tap / account tap renders with
  // ZERO chunk-load delay. Never runs before paint, so it can't compete
  // with the critical path; on slow connections it's simply later/never,
  // and the dynamic import itself is the fallback.
  useEffect(() => {
    const preload = () => {
      import('@/components/topic-detail')
      import('@/components/user-page')
    }
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(preload, { timeout: 3000 })
      return () => window.cancelIdleCallback(id)
    }
    const t = window.setTimeout(preload, 1500)
    return () => window.clearTimeout(t)
  }, [])

  // --- Country detection ---
  const [country, setCountry] = useState<CountryInfo | null>(null)
  // Only render time-dependent values after mount (avoids hydration mismatch
  // — server uses UTC, client uses local timezone).
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // --- Category / view state ---
  // Category state. ALWAYS initialized to 'relevant' (no lazy initializer
  // that reads window) — this ensures the server render and client
  // hydration produce the SAME initial value, avoiding hydration mismatches.
  // The correct category from the URL (?category=politics) is applied AFTER
  // hydration by the mount effect's readCategoryFromUrl() call.
  //
  // Previous approach used a lazy initializer that read window.location.search
  // on the client. This caused a hydration mismatch: server rendered
  // 'relevant' (no window), client expected 'politics' (from URL). React 19
  // used the server value and the client value was lost — the "Relevant" tab
  // stayed highlighted even when the URL said ?category=politics.
  const [category, setCategoryState] = useState<Category>('relevant')
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
      // ── Scroll to top when switching categories ──
      // If the user scrolled down in one subtopic (e.g. World) and taps
      // another (e.g. Politics), jump to the top so they see the new
      // section's first stories, not mid-scroll position from the old tab.
      // Uses 'instant' behavior for an immediate jump (smooth scrolling
      // 2000px takes ~2s and feels sluggish on a tab switch).
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
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
      'business', 'technology', 'science', 'health', 'sports', 'blindspots',
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

    // ── MOUNT SYNC: read category from URL on mount ──
    // CRITICAL FIX: In the production build (SSR), the useState initializer
    // returns 'relevant' on the server (no window). The server-rendered HTML
    // has "Relevant" highlighted. On client hydration, React uses the server
    // value to match the HTML — the client's URL-read ('politics') may NOT
    // take effect automatically (React 19 hydration mismatch behavior).
    // The pageshow event that should fix this can fire BEFORE this effect
    // registers the listener (timing race on page load).
    //
    // Calling readCategoryFromUrl() directly here (after registering
    // listeners) guarantees the URL category is applied on mount, regardless
    // of whether pageshow already fired or the useState initializer was
    // overridden by hydration. This runs AFTER hydration completes.
    readCategoryFromUrl()

    return () => {
      window.removeEventListener('popstate', handlePopState)
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('pageshow', handlePageshow)
    }
  }, [])

  // --- Search state ---
  const [search, setSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [apiSearchLoading, setApiSearchLoading] = useState(false)
  const [apiSearchResult, setApiSearchResult] = useState<SearchResponse | null>(null)
  const [localSearchAttempted, setLocalSearchAttempted] = useState(false)

  // --- Subtopic header style (server-side feature flag + personal override) ---
  // Which of the 10 category-header designs this visitor sees. The server
  // passes the EFFECTIVE value as initialSubtopicNav — the visitor's own
  // pick (nw_nav cookie) when set, otherwise the site-wide flag — so SSR
  // renders it directly (no flash). A lightweight client fetch still runs
  // so a flag flip reaches already-loaded pages on their next visit; any
  // fetch failure keeps the server-provided value. A personal override
  // always WINS: the fetch result is ignored for that visitor.
  const [subtopicNav, setSubtopicNav] = useState<NavVariant>(
    initialSubtopicNav ?? 'cards',
  )
  useEffect(() => {
    // The server already rendered the right design, so this fetch is a
    // safety net (e.g. the SSR Firebase read failed → server fell back to
    // 'cards'). When the values agree, the functional setState returns the
    // SAME value → React skips the re-render entirely → no flash.
    let cancelled = false
    fetch('/api/flags')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const v = d?.subtopicNav
        if (
          !cancelled &&
          ['classic', 'tabs', 'tiles', 'sheet', 'dock', 'maxipills', 'headerdock', 'tabsarrow', 'cardsarrow'].includes(v)
        ) {
          // Personal override (Account → Feature Flags → "Your header
          // style") beats the site default — never stomp the visitor's
          // own choice with the global flag.
          if (readNavOverride()) return
          setSubtopicNav((prev) => (prev === v ? prev : (v as NavVariant)))
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // --- Live nav-style changes from Account → Feature Flags ---
  // The Feature Flags card dispatches NAV_STYLE_EVENT when the visitor
  // picks their own header design (or returns to "Follow site default").
  // Applying it here means the change is visible IMMEDIATELY while the
  // Account overlay is still open — no refresh needed. Future page loads
  // render the same design server-side (page.tsx reads the nw_nav cookie
  // during SSR), so there's no flash on refresh either.
  useEffect(() => {
    const onNavStyle = (e: Event) => {
      const v = (e as CustomEvent<NavMode>).detail
      if (v) setSubtopicNav(v)
    }
    window.addEventListener(NAV_STYLE_EVENT, onNavStyle)
    return () => window.removeEventListener(NAV_STYLE_EVENT, onNavStyle)
  }, [])

  // --- News data state ---
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [topics, setTopics] = useState<TopicArticle[]>([])
  // My Country topics fetched separately for interspersing in the Relevant tab.
  // These are GDELT-sourced country stories (topicId starts with 'g').
  const [myCountryTopics, setMyCountryTopics] = useState<TopicArticle[]>([])
  // Dynamic count of country stories to show in Relevant (adapts to engagement).
  const [countryNewsCount, setCountryNewsCount] = useState(3)
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null)
  const [isCached, setIsCached] = useState(false)
  const [isFresh, setIsFresh] = useState(true)
  const [articleCount, setArticleCount] = useState(0)
  const [minCoverage, setMinCoverage] = useState(1)

  // --- Infinite scroll state ---
  // The API returns 24 topics per fetch. When the user scrolls to the
  // bottom, we increase displayCount by 24 and fetch the next page
  // (?offset=24, ?offset=48, etc.). This continues until no more topics.
  const [displayCount, setDisplayCount] = useState(24)
  const [olderTopics, setOlderTopics] = useState<TopicArticle[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const sentinelRef = React.useRef<HTMLDivElement | null>(null)
  // Blindspot sections (grouped by source category) — only set when
  // category === 'blindspots'. Used by BlindspotSectionedFeed.
  const [blindspotSections, setBlindspotSections] = useState<Record<string, TopicArticle[]>>({})

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
          slim: '1',
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

  // ── Notification Like auto-press ──
  // When the user taps LIKE on a push notification, the SW opens the
  // article with &like=1 (cold start) or posts an open-topic message with
  // autoLike: true (app already open). Both land here: pendingAutoLikeRef
  // holds the TOPIC ID whose next open should auto-press its like button;
  // autoLikeTopicId is the id actually passed into <TopicDetail>, cleared
  // when the overlay closes (one shot — reopening the article normally
  // never re-likes).
  //
  // The marker is STICKY PER TOPIC because TWO async flows can race to
  // open the same ?topic= URL: the topic-watcher effect (openTopicFromUrl)
  // AND the fetchData effect's own auto-open (which calls handleOpenDetail
  // WITHOUT autoLike). Whichever wins, a plain boolean marker would be
  // reset by the loser — killing the 650ms auto-press timer mid-flight.
  // Keying the marker by topic id makes the second call a no-op.
  const pendingAutoLikeRef = React.useRef<string | null>(null)
  const [autoLikeTopicId, setAutoLikeTopicId] = useState<string | null>(null)
  const autoLikeTopicIdRef = React.useRef<string | null>(null)
  useEffect(() => {
    autoLikeTopicIdRef.current = autoLikeTopicId
  }, [autoLikeTopicId])

  // ── topics ref ──
  // Lets the topic-open watcher below read the latest topics WITHOUT
  // re-subscribing its popstate/message listeners on every feed update
  // (the old [topics] dep array re-ran the whole effect — listener churn
  // + a redundant openTopicFromUrl() call on every fetch/append).
  const topicsRef = React.useRef<TopicArticle[]>([])
  useEffect(() => {
    topicsRef.current = topics
  }, [topics])

  // --- User interests + engagement + seen-topics (for personalization) ---
  const [interests, setInterestsState] = useState<string[]>([])
  const [engagement, setEngagement] = useState<EngagementStats>({})
  const [seenTopics, setSeenTopics] = useState<Record<string, number>>({})

  // Load interests + engagement + seen-topics + country-news-count from
  // localStorage on mount, and refresh whenever the onboarding flow saves
  // new interests.
  useEffect(() => {
    const load = () => {
      setInterestsState(getInterests())
      setEngagement(getEngagement())
      setSeenTopics(getSeenTopics())
      setCountryNewsCount(getCountryNewsCount())
    }
    load()
    window.addEventListener('neutralwire:interests-changed', load)
    window.addEventListener('neutralwire:engagement-changed', load)
    // Refresh engagement every 2 minutes (was 30s — was causing excessive
    // localStorage reads + unnecessary re-renders)
    const interval = setInterval(load, 120000)
    return () => {
      window.removeEventListener('neutralwire:interests-changed', load)
      window.removeEventListener('neutralwire:engagement-changed', load)
      clearInterval(interval)
    }
  }, [])

  // Track engagement when a user opens a topic detail.
  // Also marks the topic as "seen" so it gets demoted in the feed (users
  // see fresh content instead of stories they already read).
  // If the topic is a My Country story (GDELT-sourced, topicId starts with
  // 'g') opened from the Relevant tab, bump the country-news count up (+1)
  // so more country stories appear in Relevant next time.
  const handleOpenDetail = React.useCallback((topic: TopicArticle, autoLike?: boolean) => {
    setDetailTopic(topic)
    // ── Notification Like auto-press (sticky per topic id) ──
    // - If THIS topic is already armed → keep it armed (the racing second
    //   open of the same ?topic= must not reset the marker).
    // - Else consume the pending flag (set from ?like=1 or the SW message)
    //   when it matches THIS topic; a pending id for a DIFFERENT topic is
    //   discarded (the user opened something else first — never auto-like
    //   the wrong story).
    if (autoLikeTopicIdRef.current === topic.topicId) {
      // already armed for this exact topic — keep
    } else {
      const pendingId = pendingAutoLikeRef.current
      pendingAutoLikeRef.current = null
      const wanted = autoLike === true ? topic.topicId : pendingId
      const next = wanted === topic.topicId ? topic.topicId : null
      // Update the ref SYNCHRONOUSLY (a racing second open — e.g. the
      // fetchData auto-open — can call this before React flushes the
      // state update and its ref-sync effect; the ref must already know).
      autoLikeTopicIdRef.current = next
      setAutoLikeTopicId(next)
    }
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
    // ── Dynamic country-news count ──
    // If the user clicked a GDELT-sourced country story (topicId starts
    // with 'g') while on the Relevant tab, increase the count of country
    // stories to show in Relevant (max 5). This adapts the mix based on
    // user interest — clicking country stories → more appear.
    if (
      typeof window !== 'undefined' &&
      topic.topicId.startsWith('g') &&
      window.location.search.includes('category=relevant') === false &&
      !window.location.search.includes('category=')
    ) {
      // On the default relevant tab (no ?category= param), a click on a
      // country story means the user is interested → bump up.
      const newCount = bumpCountryNewsCount(1)
      setCountryNewsCount(newCount)
    }
  }, [])

  // Keep a ref so async functions (fetchData) can call the latest
  // handleOpenDetail without re-triggering the fetchData effect.
  const handleOpenDetailRef = React.useRef(handleOpenDetail)
  useEffect(() => {
    handleOpenDetailRef.current = handleOpenDetail
  }, [handleOpenDetail])

  // ── Swipe-to-dismiss handler ──
  // Called when a user swipes a feed card to the left past the 50% threshold.
  // This performs the SAME actions as clicking the dislike (thumbs-down)
  // button in the topic detail overlay:
  //   1. Saves the dislike vote to localStorage (so it persists + syncs)
  //   2. Calls bumpEngagementForTopic with 'dislike' (−15 per matched sector,
  //      strong negative signal for personalization)
  //   3. POSTs to /api/engagement with topicVote='disliked' (syncs the vote
  //      to Firebase so it's visible across devices)
  //   4. Removes the topic from ALL local feed state arrays (topics,
  //      olderTopics, myCountryTopics, blindspotSections) so it disappears
  //      from every view instantly.
  // The card's own exit animation (slide off-screen left) has ALREADY run
  // by the time this is called — TopicCard awaits the animation before
  // invoking onDismiss — so the removal is invisible to the user.
  const handleDismissTopic = React.useCallback((topic: TopicArticle) => {
    const deviceId = typeof window !== 'undefined' ? getDeviceId() : ''

    // 1. Persist the dislike vote to localStorage (matches topic-detail.tsx
    //    saveVote so the detail overlay would show the dislike as active
    //    if the user ever re-encountered this topic).
    try {
      localStorage.setItem(`neutralwire:vote:${topic.topicId}`, 'disliked')
    } catch {
      // silent — localStorage may be unavailable (private mode, etc.)
    }

    // 2 + 3. Bump engagement locally + sync the vote to Firebase.
    //    bumpEngagementForTopic handles both the localStorage engagement
    //    update AND its own /api/engagement POST for the sector stats.
    //    We ALSO fire a separate /api/engagement call with type='topicVote'
    //    so the per-topic vote is recorded (same as the detail overlay).
    if (deviceId) {
      bumpEngagementForTopic(
        deviceId,
        topic.title,
        topic.summary || '',
        'dislike',
      ).catch(() => {})
      fetch('/api/engagement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'topicVote',
          deviceId,
          topicId: topic.topicId,
          vote: 'disliked',
        }),
      }).catch(() => {})
    }

    // 4. Remove from ALL local feed state. A topic can appear in multiple
    //    arrays simultaneously (e.g. in `topics` AND in a SectionedFeed's
    //    fetched categoryTopics, or in `myCountryTopics` AND interspersed
    //    in Relevant), so we filter every array to be safe.
    setTopics((prev) => prev.filter((t) => t.topicId !== topic.topicId))
    setOlderTopics((prev) => prev.filter((t) => t.topicId !== topic.topicId))
    setMyCountryTopics((prev) => prev.filter((t) => t.topicId !== topic.topicId))
    setBlindspotSections((prev) => {
      const next: Record<string, TopicArticle[]> = {}
      let changed = false
      for (const [key, list] of Object.entries(prev)) {
        const filtered = list.filter((t) => t.topicId !== topic.topicId)
        if (filtered.length !== list.length) changed = true
        next[key] = filtered
      }
      return changed ? next : prev
    })

    // Refresh the engagement state so the personalization boost takes
    // effect on the next render (the disliked topic's sectors get −15,
    // which demotes similar topics in the feed).
    setTimeout(() => {
      setEngagement(getEngagement())
      window.dispatchEvent(new CustomEvent('neutralwire:engagement-changed'))
    }, 200)
  }, [])

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
    let historyFixed = false

    const openTopicFromUrl = async () => {
      const urlParams = new URLSearchParams(window.location.search)
      const topicId = urlParams.get('topic')
      if (!topicId) return

      // ── Notification Like auto-press (?like=1) ──
      // The SW appends like=1 when the user tapped the notification's Like
      // button. Read it, arm the pending auto-like (keyed by topic id so a
      // racing second open can't apply it to the wrong story), and strip it
      // from the URL IMMEDIATELY (replaceState — no history churn) so a
      // refresh or a share of this URL can never re-trigger the like.
      let autoLikeFromUrl = false
      if (urlParams.get('like') === '1') {
        autoLikeFromUrl = true
        pendingAutoLikeRef.current = topicId
        try {
          const cleanUrl = new URL(window.location.href)
          cleanUrl.searchParams.delete('like')
          window.history.replaceState(
            window.history.state || {},
            '',
            cleanUrl.toString(),
          )
        } catch {
          // URL API unavailable — leave the param; TopicDetail's own
          // one-shot guard still prevents double-liking.
        }
      }

      // ── Fix back-button history for notification/shared-link opens ──
      // When the app is opened via a notification tap or a shared link,
      // the initial URL is `/?topic=xxx`. The browser history has only
      // this ONE entry, so pressing back exits the app entirely.
      //
      // Fix: on the first call, REPLACE the current entry with a clean
      // home URL (`/`), then PUSH `/?topic=xxx` on top. Now the history
      // stack is: [/] → [/?topic=xxx]. Pressing back from the topic
      // detail goes to the home screen instead of closing the app.
      //
      // We only do this ONCE per page load (guarded by `historyFixed`)
      // to avoid interfering with normal topic-open navigation.
      if (!historyFixed) {
        historyFixed = true
        const currentUrl = window.location.href
        const url = new URL(currentUrl)
        const hadTopicParam = url.searchParams.has('topic')
        if (hadTopicParam) {
          // Step 1: Replace current entry with clean home URL (no topic param)
          const homeUrl = new URL(currentUrl)
          homeUrl.searchParams.delete('topic')
          window.history.replaceState({ notificationBackFix: true }, '', homeUrl.toString())
          // Step 2: Push the topic URL back on top
          window.history.pushState({ detailOpen: true }, '', currentUrl)
        }
      }

      // Already open? Don't re-open.
      if (detailTopicRef.current?.topicId === topicId) return

      // First, check if the topic is already in the loaded topics list
      // (fastest path — no API call needed).
      const found = topicsRef.current.find((t) => t.topicId === topicId)
      if (found) {
        handleOpenDetailRef.current?.(found, autoLikeFromUrl)
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
            handleOpenDetailRef.current?.(topicJson.topic, autoLikeFromUrl)
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
        // The SW sets autoLike: true when the user tapped the
        // notification's Like button — arm the one-shot auto-press,
        // keyed to this topic id.
        if (event.data.autoLike === true) {
          pendingAutoLikeRef.current = event.data.topicId
        }
        // The topicId might not be in our current `topics` array (different
        // category loaded), so always go through the full openTopicFromUrl
        // flow which falls back to /api/topic/[id].
        // But first, ensure the URL has ?topic= so the topic-open history
        // entry is correct.
        if (!window.location.search.includes(`topic=${event.data.topicId}`)) {
          const url = new URL(window.location.href)
          url.searchParams.set('topic', event.data.topicId)
          // Warm-app like: the URL never had like=1 — keep the marker in
          // the history state? No — the pendingAutoLikeRef above carries
          // it; do NOT write like=1 into the URL (a refresh would re-arm).
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
    // NOTE: runs ONCE. topics changes are picked up via topicsRef above.
  }, [])

  // ── NOTE: Client-side summary pre-generation was REMOVED to avoid
  // burning Vercel Fluid Compute CPU. Every page visit was firing 12
  // /api/summary calls (each potentially calling the AI = 2-5s CPU).
  // The cron job (api/cron/refresh-all) now handles summary pre-generation
  // server-side, once per hour. When a user opens a topic, the summary
  // generates on-demand (1 call, cached forever in Firebase).

  // --- User page state (account / referral / interests / themes) ---
  const [userPageOpen, setUserPageOpen] = useState(false)

  // ── Offline mode detection ──
  // Tracks whether the browser is offline. When offline, a big banner is
  // shown at the top of the page saying "Offline Mode — showing cached
  // news". The SW serves cached /api/news, /api/summary, and /api/topic
  // responses so the app remains fully functional offline.
  const [isOffline, setIsOffline] = useState(false)
  useEffect(() => {
    // Set initial state (navigator.onLine is false when offline)
    setIsOffline(!navigator.onLine)
    const goOffline = () => setIsOffline(true)
    const goOnline = () => setIsOffline(false)
    window.addEventListener('offline', goOffline)
    window.addEventListener('online', goOnline)
    return () => {
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('online', goOnline)
    }
  }, [])

  // --- Referral + session tracking ---
  useEffect(() => {
    const deviceId = getDeviceId()
    const urlParams = new URLSearchParams(window.location.search)
    const refCode = urlParams.get('ref')

    // ── Analytics: track this page view ──
    // Fire-and-forget beacon to /api/analytics/track. Throttled to once
    // per session per path (see analytics-tracker.ts).
    trackPageView(deviceId)

    // Track the referral click + register device.
    // ── CPU GATE (Fluid) ── Loads WITH a ?ref= code ALWAYS fire (referral
    // attribution is the money moment — never gated). Loads WITHOUT one
    // only register/refresh the device record: a full Firebase
    // read-modify-write that used to run on EVERY page view. It's now
    // gated to a 24h heartbeat — first visit still registers, and the
    // record still heals daily. lastSeen/ipHash freshness has no
    // sub-day consumer (notifications use timezone + countryCode, which
    // come from the session ping / country detection instead).
    const hasRefCode = !!refCode
    if (
      hasRefCode ||
      gateAllows(GATE_DEVICE_REGISTER, {}, DEVICE_REGISTER_TTL_MS)
    ) {
      fetch('/api/referral/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, referralCode: refCode }),
      })
        .then((r) => {
          if (r.ok && !hasRefCode) markGate(GATE_DEVICE_REGISTER)
        })
        .catch(() => {})
    }

    // ── Send timezone IMMEDIATELY on page load ──
    // This ensures even first-time visitors get their timezone stored in
    // Firebase right away, so the notification cron can send them briefings
    // at the correct local time. Without this, the timezone is only sent
    // during the session ping — which means a user who opens the app and
    // closes it within 5 minutes never gets their timezone stored.
    //
    // ── CPU GATE (Fluid) ── A reload within 4.5 min of ANY session ping
    // with the SAME timezone skips this call — the server already has
    // the timezone and the streak's daily qualification comes from the
    // 5-minute pings (this 1-second ping alone never qualifies a day,
    // which needs 15s). First visits and timezone changes always fire.
    const userTimezone = typeof Intl !== 'undefined'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || ''
      : ''
    if (
      userTimezone &&
      gateAllows(GATE_SESSION_PING, { tz: userTimezone }, SESSION_PING_TTL_MS)
    ) {
      fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, seconds: 1, referralCode: refCode, tz: userTimezone }),
      })
        .then((r) => {
          if (r.ok) markGate(GATE_SESSION_PING, { tz: userTimezone })
        })
        .catch(() => {})
    }

    // ── Track session activity every 5 MINUTES (was 2 min) ──
    // The streak only needs 15s/day to qualify, so 5 min is plenty.
    // Also sends the user's IANA timezone so notifications can be scheduled
    // at the correct local time.
    //
    // ── VISIBILITY-AWARE: only pings when the tab is VISIBLE ──
    // When the user switches tabs or minimizes the browser, we STOP
    // pinging. This prevents wasted Function Invocations + Firebase
    // writes when the user isn't actually looking at the page.
    // A hidden tab sending 30 pings/hour = 720/day of pure waste.
    //
    // CPU impact: 5min interval = 12 pings/hour (was 30/hour at 2min).
    // Each ping = 2 Firebase reads + 2 patches = ~300ms CPU.
    // Saving: 18 pings/hour × 300ms = 5.4s CPU/hour per active user.
    // Over a month = ~40 minutes CPU per user saved.
    let sessionInterval: ReturnType<typeof setInterval> | null = null
    const SESSION_PING_MS = 5 * 60 * 1000 // 5 minutes
    const SESSION_SECONDS = 300 // 5 min of accumulated time per ping

    const pingSession = () => {
      // Don't ping if the tab is hidden — the user isn't actively reading
      if (document.hidden) return
      fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, seconds: SESSION_SECONDS, referralCode: refCode, tz: userTimezone }),
      })
        .then((r) => {
          // Mark the gate so a reload right after this ping skips the
          // redundant immediate tz ping (same timezone → nothing to send).
          if (r.ok) markGate(GATE_SESSION_PING, { tz: userTimezone })
        })
        .catch(() => {})
    }

    const startSessionTracking = () => {
      if (sessionInterval) return
      sessionInterval = setInterval(pingSession, SESSION_PING_MS)
    }
    const stopSessionTracking = () => {
      if (sessionInterval) {
        clearInterval(sessionInterval)
        sessionInterval = null
      }
    }

    // Start tracking only when the tab is visible; pause when hidden.
    if (document.hidden) {
      // Tab started hidden — wait until it's visible to start
    } else {
      startSessionTracking()
    }
    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopSessionTracking()
      } else {
        // Tab became visible — ping immediately (catches the "just came back"
        // moment) then resume the interval.
        pingSession()
        startSessionTracking()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    // ── PWA growth metrics (unique-IP install / DAU / app-open) ──
    // 'active' = this IP used NeutralWire today (consent-gated).
    reportActiveMetric()

    // Detect PWA install and report it.
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      // iOS Safari standalone check
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true

    if (isStandalone) {
      // ── CPU GATE (Fluid) ── /api/pwa-installed re-marks an immutable
      // flag (pwaInstalled=true + referral qualification). It fired on
      // EVERY standalone launch; now it's a 24h heartbeat. The real
      // `appinstalled` event below still always reports (and re-arms
      // this gate), and first launches always fire.
      if (gateAllows(GATE_PWA_INSTALLED, {}, PWA_INSTALLED_TTL_MS)) {
        fetch('/api/pwa-installed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId, referralCode: refCode }),
        })
          .then((r) => {
            if (r.ok) markGate(GATE_PWA_INSTALLED)
          })
          .catch(() => {})
      }
      // First launch in the installed app = the install moment; also
      // counts today's app-open (consent-gated, 1/day).
      reportInstallMetric()
      reportAppOpenMetric()
    }

    // Also listen for the appinstalled event.
    const installedHandler = () => {
      // The REAL install moment — always reported, never gated.
      fetch('/api/pwa-installed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, referralCode: refCode }),
      })
        .then((r) => {
          if (r.ok) markGate(GATE_PWA_INSTALLED)
        })
        .catch(() => {})
      reportInstallMetric()

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
      // ── CPU GATE (Fluid) ── This boot POST re-asserts enabled=true on
      // every PWA launch — a no-op write when notifications are already
      // on (the permission-grant flow and every settings toggle always
      // POST for real, ungated). Gated to once-ever; the real toggles
      // keep the server state correct.
      if (gateAllows(GATE_NOTIF_BOOT, {}, NOTIF_BOOT_TTL_MS)) {
        fetch('/api/notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId, enabled: true }),
        })
          .then((r) => {
            if (r.ok) markGate(GATE_NOTIF_BOOT)
          })
          .catch(() => {})
      }
      // Wait for SW to be ready, then subscribe to push.
      navigator.serviceWorker.ready.then(() => {
        subscribeToPush(deviceId).catch(() => {})
      }).catch(() => {})
    }

    return () => {
      stopSessionTracking()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('appinstalled', installedHandler)
    }
  }, [])

  // --- Refs for race-condition protection ---
  // NOTE: categoryRef is declared earlier (near setCategory) so the URL
  // listener useEffect can read the latest category. reqIdRef guards the
  // async fetch against stale responses when the user switches categories.
  const reqIdRef = React.useRef(0)

  // --- Country detection on first load (OPTIMISTIC + background refresh) ---
  // Two-phase detection for the fastest possible first paint:
  //
  //   Phase 1 (INSTANT, ~0ms): manual override from localStorage, else the
  //   24h-TTL cached detection. Repeat visitors get their feed fetch going
  //   immediately — no network round-trip before content starts loading.
  //
  //   Phase 2 (BACKGROUND): a FRESH detection (bypasses cache) so travellers
  //   are picked up on every page load, exactly as before. If the fresh
  //   result differs from what we optimistically used, the country state
  //   updates and the feed refetches with the correct country.
  //
  // While country is still null (very first visit ever), fetchData sends the
  // request WITHOUT a country param — the server detects from IP (cached 1h
  // per IP) — so even first-timers see content immediately instead of
  // waiting up to 6s for the client-side geolocation API.
  useEffect(() => {
    let cancelled = false

    // ── Phase 1: instant from localStorage ──
    try {
      const manual = localStorage.getItem('neutralwire:country-manual')
      if (manual) {
        const parsed = JSON.parse(manual) as CountryInfo
        if (parsed?.code) setCountry(parsed)
      } else {
        detectCountryClient().then((cachedInfo) => {
          if (cancelled || !cachedInfo) return
          setCountry(cachedInfo)
        })
      }
    } catch {
      // ignore — fall through to background detection
    }

    // ── Phase 2: fresh detection (travel check, every page load) ──
    ;(async () => {
      const client = await detectCountryClientFresh()
      if (cancelled || !client) return

      const manual = localStorage.getItem('neutralwire:country-manual')
      if (manual) {
        // Manual override always wins — just refresh the auto-detect cache
        // so it's fresh for next time (same behaviour as before).
        try {
          localStorage.setItem(
            'neutralwire:country',
            JSON.stringify({ ts: Date.now(), info: client }),
          )
        } catch {
          // ignore
        }
        return
      }

      // No manual override — adopt the fresh result. Functional update
      // returns the SAME object when the code is unchanged, so React skips
      // the re-render (and the feed refetch) when nothing actually changed.
      setCountry((prev) =>
        prev && prev.code === client.code ? prev : client,
      )
    })()

    return () => {
      cancelled = true
    }
  }, [])

  // --- Manual country override ---
  const handleCountryChange = React.useCallback((c: CountryInfo) => {
    // IMMEDIATELY clear all topics so the old country's news doesn't
    // flash on screen while the new country's news loads. This prevents
    // the glitch where switching to India briefly shows UK news.
    setTopics([])
    setOlderTopics([])
    setMyCountryTopics([])
    setBlindspotSections({})
    setLoading(true)
    setError(null)
    setCountry(c)
    try {
      localStorage.setItem('neutralwire:country-manual', JSON.stringify(c))
      // Also clear the auto-detected country cache so it doesn't
      // override the manual selection on next page load
      localStorage.removeItem('neutralwire:country')
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
  //
  // ── Local city news boosting ──
  // If the user's city is detected, topics mentioning that city get a
  // boost so a few local stories appear in the feed. Capped at <20% of
  // the visible feed so local news is a supplement, not a flood.
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
    // A topic the user JUST opened (within RECENT_SEEN_MS) keeps its
    // ranking untouched — the story they were just reading must still be
    // on screen (no scroll hunt) when they come back out; reading is not
    // a demotion during the session. OLDER seen topics slide down the
    // feed, but a read story is NEVER hidden for being read — the
    // visibility gate below tests the score WITHOUT the seen penalty, so
    // only genuine dislike signals can remove a topic.
    const seenTopicIds = new Set(Object.keys(seenTopics))
    const now = Date.now()
    const RECENT_SEEN_MS = 10 * 60 * 1000
    const SEEN_DEMOTE = 15
    const seenPenaltyFor = (topicId: string): number => {
      const at = seenTopics[topicId]
      if (!at) return 0
      return now - at < RECENT_SEEN_MS ? 0 : SEEN_DEMOTE
    }

    // ── Local city detection ──
    // Scan topics for mentions of the user's detected city. These get a
    // boost so a few local stories surface in the feed (capped at <20%).
    const cityName = country?.city?.trim()
    const cityNameLower = cityName?.toLowerCase()
    const isLocalTopic = (t: TopicArticle): boolean => {
      if (!cityNameLower || cityNameLower.length < 3) return false
      const text = `${t.title} ${t.summary}`.toLowerCase()
      return text.includes(cityNameLower)
    }

    // ── Deduplicate by title or image (always runs, no search only) ──
    // Sometimes the same story appears twice with slightly different
    // topicIds (e.g. one from RSS and one from GDELT, or a story clustered
    // differently). When two topics have the same title (case-insensitive,
    // trimmed) or the same image URL (query params stripped), we remove the
    // duplicate — keeping the one with MORE sources (coverage). If both have
    // the same source count, remove one at random.
    if (!debouncedSearch && list.length > 1) {
      // Normalize title: lowercase, strip ALL punctuation, collapse whitespace
      const normTitle = (t: string) =>
        t.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
      const titleGroups = new Map<string, TopicArticle[]>()
      const imageGroups = new Map<string, TopicArticle[]>()
      for (const t of list) {
        const nt = normTitle(t.title)
        if (nt) {
          const arr = titleGroups.get(nt) || []
          arr.push(t)
          titleGroups.set(nt, arr)
        }
        const imgUrl = safeImageUrl(t.imageUrl)?.split('?')[0]?.trim()
        if (imgUrl) {
          const arr = imageGroups.get(imgUrl) || []
          arr.push(t)
          imageGroups.set(imgUrl, arr)
        }
      }
      const toRemove = new Set<string>()
      const pickKeeper = (group: TopicArticle[]): TopicArticle => {
        const sorted = [...group].sort((a, b) => b.coverage - a.coverage)
        const maxCov = sorted[0].coverage
        const tied = sorted.filter((t) => t.coverage === maxCov)
        return tied[Math.floor(Math.random() * tied.length)]
      }
      for (const group of titleGroups.values()) {
        if (group.length > 1) {
          const keeper = pickKeeper(group)
          for (const t of group) {
            if (t.topicId !== keeper.topicId) toRemove.add(t.topicId)
          }
        }
      }
      for (const group of imageGroups.values()) {
        if (group.length > 1) {
          const keeper = pickKeeper(group)
          for (const t of group) {
            if (t.topicId !== keeper.topicId) toRemove.add(t.topicId)
          }
        }
      }
      if (toRemove.size > 0) {
        list = list.filter((t) => !toRemove.has(t.topicId))
      }
    }

    // Only personalise when there's no active search (otherwise the user
    // is looking for something specific and we shouldn't hide results).
    const hasInterests = interests.length > 0
    const hasEngagement = Object.keys(engagement).length > 0
    if (debouncedSearch || (!hasInterests && !hasEngagement && seenTopicIds.size === 0 && !cityNameLower)) {
      return list
    }

    // Compute boost for each topic and sort descending. Stable sort
    // preserves original order for ties (so equal-boost stories keep
    // their aggregator ordering, which already prioritises local + fresh).
    //
    // Seen topics (read >10 min ago) get a -15 penalty (demoted below
    // unseen stories of similar coverage); ones read within the last
    // 10 minutes keep their full score (they stay on screen).
    // Local-city topics get a +18 boost (surfaces them above non-local
    // stories of similar coverage, but the cap below limits how many
    // appear in the final feed).
    // Topics with very negative BASE scores (< -10, before the seen
    // penalty) are HIDDEN — the user has strongly disliked this sector.
    // The seen penalty can demote but never hide: a story is not removed
    // just because it was read.
    //
    // ── Notification-like ranking signals ──
    // boostScore: the GLOBAL signal — every like on a notification adds
    //   +6 (max 24) server-side; the user's own liked topics ALSO carry a
    //   direct +40 here (localStorage vote) so a story they liked from a
    //   notification ranks clearly higher for THEM, outweighing the -15
    //   seen-penalty that opening it incurred.
    const LOCAL_BOOST = 18
    const LIKED_DIRECT_BOOST = 40
    const likedTopicIds = new Set<string>()
    if (typeof window !== 'undefined') {
      try {
        for (const t of list) {
          if (localStorage.getItem(`neutralwire:vote:${t.topicId}`) === 'liked') {
            likedTopicIds.add(t.topicId)
          }
        }
      } catch {
        // localStorage unavailable (private mode) — skip the direct boost
      }
    }
    const scored = list
      .map((t) => {
        const base =
          personalizationBoost(t, interests, engagement) +
          (isLocalTopic(t) ? LOCAL_BOOST : 0) +
          (t.boostScore || 0) +
          (likedTopicIds.has(t.topicId) ? LIKED_DIRECT_BOOST : 0)
        return {
          topic: t,
          base,
          score: base - seenPenaltyFor(t.topicId),
          isLocal: isLocalTopic(t),
        }
      })
      .sort((a, b) => b.score - a.score)

    // Hide heavily-disliked topics (BASE score < -10). The seen penalty
    // is excluded on purpose: a read story ranks lower but is never
    // REMOVED for being read — it only disappears if the user actually
    // disliked its sectors.
    const visible = scored.filter((entry) => entry.base > -10)
    // If hiding everything would leave nothing, show all (better than empty)
    const finalScored = visible.length > 0 ? visible : scored

    // ── Cap local-city topics at <20% of the feed ──
    // The boost surfaces local topics, but we don't want them to dominate.
    // After sorting, we allow at most 20% of the returned topics to be
    // local-city topics. Extra local topics are demoted to their natural
    // position (they still appear, just not all at the top).
    const maxLocal = Math.max(1, Math.floor(finalScored.length * 0.2))
    let localCount = 0
    const capped = finalScored.map((entry) => {
      if (entry.isLocal) {
        localCount++
        if (localCount > maxLocal) {
          // Demote this local topic — remove the boost by restoring its
          // non-boosted score so it falls to its natural position.
          return {
            ...entry,
            score: entry.score - LOCAL_BOOST,
          }
        }
      }
      return entry
    })
    // Re-sort after demoting excess local topics
    capped.sort((a, b) => b.score - a.score)

    let result = capped.map((entry) => entry.topic)

    // ── Intersperse My Country topics into the Relevant feed ──
    // A few GDELT-sourced country stories are placed at strategic positions:
    //   - 1 story at position 2 (index 1) — high visibility
    //   - 1 story at mid-rank (index = length/2) — mid visibility
    //   - 1 story at the bottom — low visibility
    // The count adapts: if countryNewsCount is 0, none are shown; if 5, more
    // are interspersed. This only runs on the 'relevant' category (not
    // mycountry, since that's ALL country news already) and only when there's
    // no active search.
    if (
      category === 'relevant' &&
      !debouncedSearch &&
      myCountryTopics.length > 0 &&
      countryNewsCount > 0 &&
      result.length >= 6
    ) {
      const mcAvailable = myCountryTopics.slice(0, countryNewsCount)
      if (mcAvailable.length > 0) {
        // Build the interspersed list. We insert country stories at:
        //   pos 2 (index 1), pos mid (index = floor(len/2)), pos bottom (index = len-1)
        // For counts > 3, we spread them more evenly.
        const insertPositions: number[] = []
        if (countryNewsCount >= 1) insertPositions.push(1) // position 2
        if (countryNewsCount >= 2) insertPositions.push(Math.floor(result.length / 2)) // mid
        if (countryNewsCount >= 3) insertPositions.push(result.length - 1) // bottom
        // For counts 4-5, add positions at 1/4 and 3/4
        if (countryNewsCount >= 4) insertPositions.push(Math.floor(result.length / 4))
        if (countryNewsCount >= 5) insertPositions.push(Math.floor(result.length * 3 / 4))

        // Sort positions descending so inserting at later positions first
        // doesn't shift earlier positions
        insertPositions.sort((a, b) => b - a)
        const interspersed = [...result]
        const usedMcIds = new Set<string>()
        let mcIdx = 0
        for (const pos of insertPositions) {
          // Find the next available mycountry topic (not already used)
          while (mcIdx < mcAvailable.length && usedMcIds.has(mcAvailable[mcIdx].topicId)) {
            mcIdx++
          }
          if (mcIdx >= mcAvailable.length) break
          const mcTopic = mcAvailable[mcIdx]
          usedMcIds.add(mcTopic.topicId)
          mcIdx++
          // Insert at position (clamped to valid range)
          const clampedPos = Math.max(0, Math.min(interspersed.length, pos))
          interspersed.splice(clampedPos, 0, mcTopic)
        }
        result = interspersed
      }
    }

    // ── Final dedup pass after My Country interspersing ──
    // The My Country topics come from GDELT and the main feed from RSS —
    // they could have the same story with different topicIds. Run one
    // final dedup to catch any cross-source duplicates that appeared.
    if (result.length > 1) {
      const seenTitles = new Set<string>()
      const seenImages = new Set<string>()
      const norm = (t: string) =>
        t.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
      result = result.filter((t) => {
        const nt = norm(t.title)
        const imgUrl = safeImageUrl(t.imageUrl)?.split('?')[0]?.trim()
        let isDup = false
        if (nt && seenTitles.has(nt)) isDup = true
        if (imgUrl && seenImages.has(imgUrl)) isDup = true
        if (nt) seenTitles.add(nt)
        if (imgUrl) seenImages.add(imgUrl)
        return !isDup
      })
    }

    return result
  }, [topics, debouncedSearch, interests, engagement, seenTopics, country, category, myCountryTopics, countryNewsCount])

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
  // SILENT REFETCH (v24): when re-fetching the SAME category while the
  // feed already has content, we do NOT blank it to the skeleton — the
  // near-identical payload swaps in when it arrives. This matters most
  // on a PWA cold start: the first fetch lands (splash releases into a
  // loaded feed), then country detection completes and triggers a refine
  // fetch — previously that flipped `loading` back on and flashed the
  // shadow-loader skeleton over the already-visible feed. Now the
  // refetch is invisible. Category switches, manual country changes and
  // the first load still show the skeleton (different category / topics
  // were just cleared / nothing to keep).
  const lastFetchCatRef = React.useRef<Category | null>(null)
  const fetchData = React.useCallback(
    async (cat: Category, mc: number, country?: CountryInfo | null) => {
      // For virtual categories, include the country param ONLY when we
      // already know it (manual override or cached detection). When country
      // is still null (very first visit), the request goes out WITHOUT the
      // param — the server detects from IP — so the feed starts loading
      // immediately instead of blocking on the client geolocation API.
      // When the fresh detection lands and differs, the effect re-runs with
      // the correct country param.
      const isVirtual = cat === 'relevant' || cat === 'mycountry'

      const reqId = ++reqIdRef.current
      const silent = lastFetchCatRef.current === cat && topicsRef.current.length > 0
      lastFetchCatRef.current = cat
      if (!silent) setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({
          category: cat,
          limit: '24',
          slim: '1',
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
        // NOTE: json.ms / json.refreshing are intentionally ignored here —
        // the cache-freshness badge was removed from the header (users
        // found it noisy); the server refreshes stale caches in the
        // background on its own.
        // Store blindspot sections (if present) for sectioned display
        setBlindspotSections(json.sections || {})

        // Append the rest after a 0ms timeout (lets browser paint first 5).
        if (allTopics.length > 5) {
          setTimeout(() => {
            if (reqId === reqIdRef.current) {
              setTopics(allTopics)
            }
          }, 0)
        }

        // ── Background: archive all topics so sources persist forever ──
        // The client sends each topic to /api/archive-topic which saves
        // the full topic (with articles) to Firebase. This runs on the
        // user's device — spreads work across users, saves Vercel CPU.
        // Only archives topics that haven't been archived yet (tracked
        // in localStorage). The visitor's country is sent along so the
        // server can search their relevant__CC / mycountry__CC caches.
        archiveTopicsInBackground(allTopics, country?.code)

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

        // ── Fetch My Country topics for interspersing in Relevant ──
        // When on the 'relevant' tab and we have a country, also fetch a
        // few mycountry stories (GDELT-sourced). These are interspersed
        // into the relevant feed at positions 2, mid, and bottom by the
        // filteredTopics memo. The count adapts based on user engagement
        // (clicking a country story → +1, disliking → -1).
        if (cat === 'relevant' && country && country.code !== 'INT') {
          try {
            const mcParams = new URLSearchParams({
              category: 'mycountry',
              limit: '5',
              minCoverage: '1',
              slim: '1',
              country: country.code,
            })
            const mcRes = await fetch(`/api/news?${mcParams.toString()}`, { cache: 'no-store' })
            if (mcRes.ok) {
              const mcJson: NewsResponse = await mcRes.json()
              if (reqId === reqIdRef.current && mcJson.topics) {
                // Filter out any that are already in the relevant topics
                // (dedup by topicId)
                const existingIds = new Set(allTopics.map((t) => t.topicId))
                const unique = mcJson.topics.filter((t) => !existingIds.has(t.topicId))
                setMyCountryTopics(unique)
              }
            }
          } catch {
            // silent — mycountry interspersing is best-effort
          }
        } else {
          // Clear mycountry topics when not on relevant tab
          setMyCountryTopics([])
        }
      } catch (e) {
        if (reqId !== reqIdRef.current) return
        if (!silent) {
          setError(e instanceof Error ? e.message : 'Failed to load news')
          setTopics([])
        }
        // Silent-refetch failure: the visible feed is already good content
        // — keep it on screen (no error card, no blanking). The stale-feed
        // heal effect refreshes it in the background.
      } finally {
        if (reqId === reqIdRef.current) setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    fetchData(category, minCoverage, country)
  }, [category, minCoverage, country, fetchData])

  // ── Adaptive splash handoff (PWA cold start only) ──
  // The inline controller in layout.tsx holds the launch splash on screen
  // (the full brand sequence LOOPS — converge, sweeping hold, dissolve —
  // so there is always motion) until it gets this signal. `loading` flips
  // false in the same commit that renders the first real feed content
  // (success, empty feed, or error — all better than a skeleton), so
  // ready() fires exactly when there is something worth revealing. The
  // controller then waits out the 1100ms minimum brand beat (the full
  // entrance, always visible), double-rAFs (content actually painted),
  // and adds html.nw-release → splash fades out while globals.css fades
  // the app in; 800ms later it adds nw-settled so touch scrolling in
  // fixed overlays works. Result: a cold-started PWA goes NW splash →
  // fully loaded Relevant tab; the shadow-loader skeleton only ever
  // appears on genuinely slow connections (the controller's 2.6s cap
  // falls back to it).
  // In a browser tab window.__NW_LAUNCH.ready is undefined → no-op.
  const splashHandoffRef = React.useRef(false)
  useEffect(() => {
    if (splashHandoffRef.current) return
    if (!loading || error) {
      splashHandoffRef.current = true
      try {
        window.__NW_LAUNCH?.ready?.()
      } catch {
        // controller absent (browser tab / gate didn't play) — nothing to do
      }
    }
  }, [loading, error])

  // ── Splash safety net ──
  // If the inline controller ever failed to run (script error, blocked),
  // the splash would hold forever with no one to release it. The feed is
  // definitely rendered 5s in — force the release ourselves, then settle
  // 800ms later (clears the filled nw-app-reveal animation whose identity
  // matrix breaks touch scrolling in fixed overlays — see globals.css).
  // In a browser tab (no nw-launch class) this is a no-op.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const el = document.documentElement
        if (el.classList.contains('nw-launch') && !el.classList.contains('nw-release')) {
          el.classList.add('nw-release')
          setTimeout(() => {
            try { el.classList.add('nw-settled') } catch { /* no-op */ }
          }, 800)
        }
      } catch {
        // no-op
      }
    }, 5000)
    return () => clearTimeout(t)
  }, [])

  // --- Background refresh when stale ---
  const bgRefresh = React.useCallback(
    async (cat: Category, mc: number, country?: CountryInfo | null) => {
      setRefreshing(true)
      try {
        const params = new URLSearchParams({
          category: cat,
          limit: '24',
          slim: '1',
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
  //
  // TWO staleness triggers (belt + braces — fixes "opened the site to
  // 3-day-old Relevant news"):
  //   1. `!isFresh` — the server explicitly marked the payload stale.
  //      12s delay: gives the server's own `after()` background refresh
  //      time to COMPLETE first, so this /api/refresh call usually finds
  //      the cache already fresh instead of re-aggregating.
  //   2. `fetchedAt` older than 10 min — the payload may have CLAIMED to
  //      be fresh when it was cached (e.g. served by the service worker
  //      or CDN from a days-old cache entry that said fresh:true at the
  //      time it was stored). /api/refresh is NOT intercepted by the SW,
  //      so it always hits the server → reads Firebase directly → swaps
  //      the real current topics into the UI seconds after load.
  //      Short 3s delay: the server-side Firebase read is fast (~300ms).
  //
  // No-loop safety: after a successful refresh, isFresh=true AND fetchedAt
  // updates (breaking the trigger). If the refresh returns the SAME old
  // fetchedAt (Firebase cache itself is old), the deps don't change, so
  // the effect never re-fires — at most ONE heal per state change.
  const FEED_HEAL_STALE_MS = 10 * 60 * 1000
  const feedAgeMs = fetchedAt ? Date.now() - fetchedAt.getTime() : 0
  const feedTooOld = fetchedAt !== null && feedAgeMs > FEED_HEAL_STALE_MS
  useEffect(() => {
    if (loading) return
    if (!isFresh || feedTooOld) {
      const delay = feedTooOld && isFresh ? 3000 : 12000
      const t = setTimeout(async () => {
        try {
          const params = new URLSearchParams({
            category,
            limit: '24',
          slim: '1',
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
      }, delay)
      return () => clearTimeout(t)
    }
  }, [isFresh, loading, feedTooOld, category, minCoverage, country])

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
    // #nw-app-root — the adaptive-splash reveal target (globals.css:
    // html.nw-release #nw-app-root fades/rises the whole app in the same
    // beat the PWA launch splash fades out, so a cold start goes
    // splash → fully loaded feed with no skeleton flash in between).
    <div id="nw-app-root" className="flex min-h-screen flex-col">
      {/* ── Offline mode banner ──
          Big, prominent banner shown when the browser is offline. The SW
          serves cached /api/news, /api/summary, and /api/topic responses
          so the app remains fully functional — this banner just tells the
          user they're seeing cached content. Disappears automatically when
          the connection returns (via the 'online' event listener).
          Slides down from the top on appear; slides back up on disappear. */}
      <AnimatePresence>
        {isOffline && (
          <motion.div
            initial={{ y: -40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -40, opacity: 0 }}
            // Spring transition for a smoother, more natural slide-down
            // than a linear ease. Low stiffness + high damping keeps it
            // snappy (~250ms effective) without bouncing past the target.
            transition={{ type: 'spring', stiffness: 320, damping: 30, mass: 0.7 }}
            className="sticky top-0 z-[60] flex items-center justify-center gap-2 bg-amber-500 px-4 py-2.5 text-center text-sm font-semibold text-black shadow-lg"
          >
            <WifiOff className="h-4 w-4 flex-shrink-0" />
            <span>Offline Mode — showing cached news. Summaries & sources still work.</span>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Header */}
      {/* Entrance: the whole header slides down + fades in over 0.35s.
          Framer clears the transform to `none` once the animation lands
          (identity values), so sticky positioning + any fixed-position
          children behave exactly as before afterwards. */}
      {/* The .glass class activates the platform-specific backdrop blur + bg
          opacity (frosted on Android, liquid on Apple, fallback to the
          inline bg-background/95 backdrop-blur on other platforms). */}
      <motion.header
        className="glass sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
        initial={{ y: -16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-4">
          <a href="/" className="flex items-center gap-2 font-bold">
            {/* Logo entrance: fade in + scale from 0.9 → 1 over 0.4s.
                The whileHover scale-up is preserved (1.15 with a spring). */}
            <motion.img
              src="/icon-192.png"
              alt="NeutralWire"
              className="h-7 w-7 rounded"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              whileHover={{ scale: 1.15 }}
            />
            {/* NeutralWire wordmark — clear brand recognition next to the
                logo on every screen size (was hidden on mobile). Geist
                ExtraBold + light tracking reads as a proper mixed-case
                wordmark. */}
            <motion.span
              className="text-sm font-extrabold tracking-[0.02em] whitespace-nowrap select-none sm:text-base"
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
            >
              NeutralWire
            </motion.span>
          </a>

          {/* Cache indicator removed — was a "Fresh · 1602ms" badge here.
              The server now serves cached news instantly and refreshes
              stale caches in the background, so the indicator had nothing
              actionable to say. */}

          <div className="ml-auto flex items-center gap-1.5">
            {/* Donate button — opens Ko-fi in a new tab.
                Always red (rose-500) so it stands out. The heart icon gets a
                gentle "heartbeat" pulse on hover (see .nw-heart in
                globals.css) — a subtle emotional nudge without being pushy. */}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => window.open('https://ko-fi.com/neutralwire', '_blank')}
              className="nw-heart-btn transition-transform duration-150 active:scale-95 text-rose-500 hover:text-rose-600"
              aria-label="Support NeutralWire on Ko-fi"
              title="Support NeutralWire"
            >
              <Heart className="nw-heart-icon h-5 w-5" fill="currentColor" />
            </Button>

            {/* Combined Account + Country button group — looks like one
                pill-shaped button with 2 sub-buttons separated by a divider.
                Left half: Account (opens user page)
                Right half: Country (opens country picker)
                Order: Account → Country → Theme */}
            <div className="flex items-center rounded-full border border-border bg-muted/50 overflow-hidden">
              {/* Account sub-button */}
              <button
                onClick={() => setUserPageOpen(true)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-muted transition-colors active:scale-95"
                aria-label="Open account"
                title="Account, referrals, themes"
              >
                <UserCircle className="h-4 w-4" />
              </button>

              {/* Divider */}
              <div className="h-4 w-px bg-border" />

              {/* Country sub-button — opens the country picker popover */}
              <CountryPicker
                country={country}
                onChange={handleCountryChange}
                compact
              />
            </div>

            <ThemeToggle />
          </div>
        </div>

        {/* Category nav — TEN selectable designs (server-side flag), one
            click from /debug flips it for ALL users:
            - 'cards' (default): big icon chips in a scrollable row, 40px
              touch targets, active chip auto-centres.
            - 'tabs':  bold text tabs + animated underline (Google-News feel)
            - 'tiles': wrapping grid of icon tiles — every topic visible
            - 'sheet': one wide button that opens a sheet of 56px tiles
            - 'dock':  floating bottom app dock — the header nav is hidden
              entirely (the dock + spacer render near the footer instead)
            - 'classic': the original flat wrapping text pills.
            - 'maxipills': classic pills at the biggest size that fits in
              exactly TWO rows (adaptive font) with every row filled
              edge-to-edge — same header height as classic.
            - 'headerdock': the app-dock item style inline in the header.
            - 'tabsarrow': bold tabs + a floating (non-clickable) swipe
              hint arrow over the right edge of the row.
            - 'cardsarrow': big chips + the same floating swipe hint. */}
        <div className="mx-auto max-w-[1440px] px-4 pb-2">
          {subtopicNav === 'dock' ? null : subtopicNav === 'classic' ? (
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

              {/* Search button — hidden on mobile (moved to section headers).
                  Visible on desktop (lg+) next to Sports. */}
              <button
                type="button"
                onClick={() => setShowSearch(true)}
                className="hidden lg:inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-foreground/80 hover:bg-muted/80 transition-colors text-xs font-medium"
                aria-label="Search"
                title="Search news"
              >
                <Search className="h-3.5 w-3.5" />
                <span>Search</span>
              </button>
            </div>
          ) : subtopicNav === 'maxipills' ? (
            <div className="flex flex-wrap items-center gap-2">
              <SubtopicMaxiPills
                category={category}
                onSelect={(c) => setCategory(c)}
                country={country}
              />

              {/* Search button — hidden on mobile (moved to section
                  headers). Shown at xl+ where the maxi pills collapse to
                  a single row, so it sits inline beside them (between
                  lg and xl the pills use two filled rows and the button
                  would wrap onto a third). */}
              <button
                type="button"
                onClick={() => setShowSearch(true)}
                className="hidden xl:inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted px-3.5 py-2 text-foreground/80 hover:bg-muted/80 transition-colors text-sm font-medium"
                aria-label="Search"
                title="Search news"
              >
                <Search className="h-4 w-4" />
                <span>Search</span>
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                {subtopicNav === 'cards' && (
                  <CategoryNav
                    category={category}
                    onSelect={(c) => setCategory(c)}
                    country={country}
                  />
                )}
                {subtopicNav === 'cardsarrow' && (
                  <CategoryNav
                    category={category}
                    onSelect={(c) => setCategory(c)}
                    country={country}
                    showArrow
                  />
                )}
                {subtopicNav === 'tabs' && (
                  <SubtopicTabs
                    category={category}
                    onSelect={(c) => setCategory(c)}
                    country={country}
                  />
                )}
                {subtopicNav === 'tabsarrow' && (
                  <SubtopicTabs
                    category={category}
                    onSelect={(c) => setCategory(c)}
                    country={country}
                    showArrow
                  />
                )}
                {subtopicNav === 'headerdock' && (
                  <SubtopicHeaderDock
                    category={category}
                    onSelect={(c) => setCategory(c)}
                    country={country}
                  />
                )}
                {subtopicNav === 'tiles' && (
                  <SubtopicTiles
                    category={category}
                    onSelect={(c) => setCategory(c)}
                    country={country}
                  />
                )}
                {subtopicNav === 'sheet' && (
                  <SubtopicSheetNav
                    category={category}
                    onSelect={(c) => setCategory(c)}
                    country={country}
                  />
                )}
              </div>
              {/* Search button — hidden on mobile (moved to section headers).
                  Visible on desktop (lg+) at the end of the nav row. */}
              <button
                type="button"
                onClick={() => setShowSearch(true)}
                className="hidden lg:inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted px-3.5 py-2 text-foreground/80 hover:bg-muted/80 transition-colors text-sm font-medium"
                aria-label="Search"
                title="Search news"
              >
                <Search className="h-4 w-4" />
                <span>Search</span>
              </button>
            </div>
          )}
        </div>
      </motion.header>

      {/* Main */}
      {/* Page-load animation: the entire main content area fades in + slides
          up slightly (8px) on initial render. The animation runs ONCE —
          it's on the outer wrapper, not on category-switch transitions
          (those are handled by the inner AnimatePresence below). */}
      <motion.main
        className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      >
        {/* Search bar — expands open with a width + opacity animation.
            Wrapped in AnimatePresence so closing it also animates out
            (collapses + fades) rather than popping away. */}
        <AnimatePresence>
        {showSearch && (
          <motion.div
            initial={{ opacity: 0, height: 0, marginBottom: 0 }}
            animate={{ opacity: 1, height: 'auto', marginBottom: 16 }}
            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
            transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
          <div className="flex items-center gap-2">
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.22, delay: 0.04, ease: 'easeOut' }}
              className="relative flex-1"
            >
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search all cached articles across the spectrum…"
                className="pl-8 pr-8"
                autoFocus
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
            </motion.div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setShowSearch(false); setSearch('') }}
              className="gap-1"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          </motion.div>
        )}
        </AnimatePresence>

        {/* Search results (full-catalog API search) — replaces the normal view
            when local search yields nothing and an API search is running.
            Wrapped in a motion.div so the transition from feed → search
            results is smooth (fade + slight slide-up). The individual result
            cards stagger inside SearchResults via their own motion. */}
        {showApiSearch ? (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
          >
            <SearchResults
              query={debouncedSearch}
              loading={apiSearchLoading}
              result={apiSearchResult}
              onOpenTopic={handleOpenDetail}
            />
          </motion.div>
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={category}
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            >
            {/* Content */}
            {error ? (
              <motion.div
                initial={{ opacity: 0, y: 10, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              >
              <Card className="flex flex-col items-center gap-3 p-12 text-center">
                <motion.div
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ duration: 0.3, delay: 0.06, ease: [0.34, 1.56, 0.64, 1] }}
                >
                  <AlertCircle className="h-8 w-8 text-destructive" />
                </motion.div>
                <div>
                  <div className="font-semibold">Could not load news</div>
                  <div className="mt-1 text-sm text-muted-foreground">{error}</div>
                </div>
                <Button
                  onClick={() => {
                    // BUGFIX: this handler previously called an undefined
                    // handleRefreshClick — tapping "Try again" crashed with a
                    // ReferenceError and the feed could never recover. Re-run
                    // the real fetch for the current category instead.
                    setError(null)
                    fetchData(category, minCoverage, country)
                  }}
                  variant="outline"
                  size="sm"
                >
                  <RefreshCw className="h-4 w-4" /> Try again
                </Button>
              </Card>
              </motion.div>
            ) : view === 'sources' ? (
              <SourceList />
            ) : loading ? (
              <LoadingState />
            ) : filteredTopics.length === 0 ? (
              <motion.div
                initial={{ opacity: 0, y: 8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              >
              <Card className="flex flex-col items-center gap-2 p-12 text-center text-muted-foreground">
                <motion.div
                  initial={{ scale: 0.7, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ duration: 0.3, delay: 0.08, ease: [0.34, 1.56, 0.64, 1] }}
                >
                  <AlertCircle className="h-6 w-6" />
                </motion.div>
                <div>
                  {debouncedSearch
                    ? `No topics match "${debouncedSearch}" — searching full catalog…`
                    : 'No topics found. Try a different category or lower the minimum coverage filter.'}
                </div>
              </Card>
              </motion.div>
            ) : view === 'columns' ? (
              <BiasColumns topics={filteredTopics} />
            ) : (
              <>
                {/* ── Sectioned layouts ──
                    Rendered ONCE with responsive grid classes inside each
                    layout component (was: duplicate lg:hidden + hidden
                    lg:block instances, which doubled the DOM, image
                    requests, and SectionedFeed's API fetch effect). */}
                {!debouncedSearch ? (
                  <>
                    {category === 'relevant' ? (
                      /* Relevant: sector-grouped sections (Top Headlines + World + Politics + etc.) */
                      <SectionedFeed
                        topics={filteredTopics}
                        olderTopics={olderTopics}
                        onOpenDetail={handleOpenDetail}
                        onDismiss={handleDismissTopic}
                        country={country}
                        interests={interests}
                        engagement={engagement}
                        myCountryTopics={myCountryTopics}
                        onSearchClick={() => setShowSearch(true)}
                      />
                    ) : category === 'blindspots' ? (
                      /* Blindspots: per-category sections showing top blindspot stories */
                      <BlindspotSectionedFeed
                        sections={blindspotSections}
                        onOpenDetail={handleOpenDetail}
                        onDismiss={handleDismissTopic}
                        onSearchClick={() => setShowSearch(true)}
                      />
                    ) : (
                      <MobileTopicLayout
                        topics={filteredTopics}
                        olderTopics={olderTopics}
                        onOpenDetail={handleOpenDetail}
                        onDismiss={handleDismissTopic}
                        label={CATEGORY_LABELS[category] || category}
                        onSearchClick={() => setShowSearch(true)}
                      />
                    )}
                  </>
                ) : (
                  /* Default grid for other categories / search */
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {featured && (
                      <TopicCard
                        key={featured.topicId + (featured.imageUrl || '')}
                        topic={featured}
                        variant="featured"
                        onOpenDetail={handleOpenDetail}
                        onDismiss={handleDismissTopic}
                        index={0}
                      />
                    )}
                    {rest.map((t, i) => (
                      <TopicCard
                        key={t.topicId + (t.imageUrl || '')}
                        topic={t}
                        onOpenDetail={handleOpenDetail}
                        onDismiss={handleDismissTopic}
                        index={i + 1}
                      />
                    ))}
                    {olderTopics.map((t, i) => (
                      <TopicCard
                        key={t.topicId + (t.imageUrl || '')}
                        topic={t}
                        onOpenDetail={handleOpenDetail}
                        onDismiss={handleDismissTopic}
                        index={rest.length + 1 + i}
                      />
                    ))}
                  </div>
                )}

                {/* Infinite scroll sentinel + loading animation */}
                <div ref={sentinelRef} className="flex justify-center py-8">
                  {loadingMore && (
                    <div className="grid w-full max-w-[1440px] grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <motion.div
                          key={i}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.28, delay: i * 0.04, ease: 'easeOut' }}
                          className="h-64 shimmer rounded-lg bg-muted"
                        />
                      ))}
                    </div>
                  )}
                  {!loadingMore && !hasMore && (
                    <motion.div
                      initial={{ opacity: 0, y: 6 }}
                      whileInView={{ opacity: 1, y: 0 }}
                      viewport={{ once: true, margin: '-20px' }}
                      transition={{ duration: 0.4, ease: 'easeOut' }}
                      className="text-sm text-muted-foreground"
                    >
                      You've reached the end of the news.
                    </motion.div>
                  )}
                </div>
              </>
            )}
            </motion.div>
          </AnimatePresence>
        )}
      </motion.main>

      {/* Footer */}
      <motion.footer
        className="border-t bg-muted/30 py-4 mt-auto"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.15, ease: 'easeOut' }}
      >
        <div className="mx-auto max-w-[1440px] px-4 text-center text-xs text-muted-foreground">
          NeutralWire
        </div>
      </motion.footer>

      {/* ── 'dock' nav variant — floating bottom app dock ──
          Rendered here (NOT in the sticky header) so it floats above the
          page bottom like a native tab bar. The spacer keeps the dock from
          covering the footer text when scrolled to the very end. */}
      {subtopicNav === 'dock' && (
        <>
          <SubtopicDock
            category={category}
            onSelect={(c) => setCategory(c)}
            country={country}
            onSearch={() => setShowSearch(true)}
          />
          <div className="h-[84px]" aria-hidden="true" />
        </>
      )}

      {/* Cookie consent — FIRST popup a new visitor ever sees (the PWA
          install prompt + onboarding below are gated on this decision). */}
      <CookieConsent />

      {/* ── Popup system (switchable for ALL users from /debug) ──

          'original'          → the classic install banner (early triggers,
                                1-hour re-ask) + the Ko-fi donate popup
                                inside the PWA. No smart sheet, no milestone
                                celebrations.

          'smart'             → the research-timed install sheet + milestone
                                celebrations (no donate popup) — the default.

          'smart-firstvisit'  → the smart system, but a brand-new visitor's
                                very first visit shows the classic install
                                popup instead (the smart engine stands down
                                for that session — one ask per visit). */}
      {popupSystem === 'original' ? (
        <PwaInstallPromptLegacy variant="original" />
      ) : (
        <>
          <PwaInstallPrompt popupSystem={popupSystem} />
          {popupSystem === 'smart-firstvisit' && (
            <PwaInstallPromptLegacy variant="first-visit" />
          )}
        </>
      )}
      <IosNotificationPrompt />
      <PwaOnboarding />

      {/* In the PWA: the ORIGINAL mode brings back the classic Ko-fi
          donation popup; the smart modes celebrate milestones instead
          (never an ask). The two are mutually exclusive by design — both
          count stories opened on this surface. */}
      {popupSystem === 'original' ? (
        <DonatePopupLegacy />
      ) : (
        <MilestoneCelebration />
      )}

      {/* User page (account / referral / personalization / themes / support)
          — wrapped in AnimatePresence so the entrance + exit animations
          run (fade + slide up/down, matching the topic-detail overlay). */}
      <AnimatePresence>
        {userPageOpen && <UserPage onClose={() => setUserPageOpen(false)} />}
      </AnimatePresence>

      {/* Detail overlay — wrapped in AnimatePresence so the TopicDetail
          can run its exit animation (slide-down + fade-out) when closing. */}
      <AnimatePresence>
        {detailTopic && (
          <TopicDetail
            key={detailTopic.topicId}
            topic={detailTopic}
            autoLike={autoLikeTopicId === detailTopic.topicId}
            onClose={() => {
              // One-shot: clear the auto-like marker with the overlay so a
              // later manual open of the same article never re-likes.
              setAutoLikeTopicId(null)
              // Clean up the ?topic= URL param when closing.
              const url = new URL(window.location.href)
              // Defensive: also drop a lingering like=1 (should already have
              // been stripped on open, but never let it survive a close).
              url.searchParams.delete('like')
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
            onReportBroken={(topicId) => {
              // Remove the broken topic from ALL feed arrays so it
              // doesn't bother other users. Same logic as handleDismissTopic
              // but without the dislike engagement bump.
              setTopics((prev) => prev.filter((t) => t.topicId !== topicId))
              setOlderTopics((prev) => prev.filter((t) => t.topicId !== topicId))
              setMyCountryTopics((prev) => prev.filter((t) => t.topicId !== topicId))
              setBlindspotSections((prev) => {
                const next: Record<string, TopicArticle[]> = {}
                let changed = false
                for (const [key, list] of Object.entries(prev)) {
                  const filtered = list.filter((t) => t.topicId !== topicId)
                  if (filtered.length !== list.length) changed = true
                  next[key] = filtered
                }
                return changed ? next : prev
              })
              // Also mark it as seen so it doesn't reappear on refresh
              markTopicSeen(topicId)
            }}
          />
        )}
      </AnimatePresence>
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
  // NOTE: The ISO 3166-1 alpha-2 code for the United Kingdom is "GB", but
  // users expect to see "UK" (the common abbreviation). We map GB → UK for
  // display only; the API still uses "GB" under the hood.
  const displayCode = (code: string): string => {
    if (code === 'GB') return 'UK'
    return code.toUpperCase()
  }
  const label = cat === 'mycountry'
    ? (country?.code && country.code !== 'INT' ? displayCode(country.code) : 'My Country')
    : CATEGORY_LABELS[cat]

  return (
    <motion.button
      type="button"
      onClick={onClick}
      // Subtle tap scale on every tab — feels responsive on mobile.
      whileTap={{ scale: 0.94 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className={cn(
        // Smaller text + tighter padding on mobile so all 11 categories
        // (Relevant, UK, Top Stories, World, Politics, Business, Tech,
        // Science, Health, Sports, Blindspots) fit in 2 lines on a 320px
        // iPhone screen. sm: restores normal size on wider screens.
        //
        // The .tab-pill-text class adds a smooth color transition (0.2s
        // ease-out) so the text color doesn't snap when active changes —
        // it cross-fades alongside the sliding pill.
        'relative inline-flex items-center gap-0.5 rounded-md whitespace-nowrap text-[10px] px-1.5 py-1 sm:gap-1 sm:px-3 sm:py-1.5 sm:text-xs font-medium transition-colors tab-pill-text',
        active
          ? 'text-background'
          : 'hover:bg-muted text-foreground/80',
      )}
    >
      {active && (
        // Sliding pill indicator — uses layoutId so Framer Motion animates
        // it from the previously-active tab's position to this one when the
        // active tab changes. Spring physics give it a snappy but smooth
        // slide (~280ms effective duration) with a small overshoot for a
        // lively feel.
        //
        // Tuned for "premium tab bar" feel: stiffness 380 gives a fast
        // initial sweep; damping 28 = one small bounce on landing (not
        // too springy); mass 0.85 makes it feel light/snappy.
        <motion.span
          layoutId="category-tab-pill"
          className="absolute inset-0 rounded-md bg-foreground"
          transition={{ type: 'spring', stiffness: 380, damping: 28, mass: 0.85 }}
          style={{ zIndex: 0 }}
        />
      )}
      <span className="relative z-10">{label}</span>
      {/* ── Blindspots Venn diagram icon (RIGHT of text) ──
          Two overlapping circles (blue left, red right) arranged like a
          Venn diagram. Visually communicates "blindspots" — what one side
          sees that the other doesn't. Only shown for the 'blindspots' tab.
          Colors stay blue/red even when the tab is active (so the icon is
          always recognizable, not invisible on the dark pill background). */}
      {cat === 'blindspots' && (
        <span className="relative z-10 flex-shrink-0">
          <svg
            width="14"
            height="10"
            viewBox="0 0 14 10"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            {/* Blue circle (left) — always blue, even when active */}
            <circle cx="4.5" cy="5" r="3.5" className="fill-blue-500" opacity="0.85" />
            {/* Red circle (right) — always red, even when active */}
            <circle cx="9.5" cy="5" r="3.5" className="fill-red-500" opacity="0.85" />
          </svg>
        </span>
      )}
    </motion.button>
  )
}

/**
 * LoadingState — skeleton feed that MIRRORS the real layout it stands in
 * for: a hero card (image block + meta row + title + bias bar) followed
 * by a grid of mini cards. Each skeleton pops in with a small stagger so
 * the loading state itself feels designed rather than a gray rectangle
 * farm — the shimmer sweep (globals.css) runs across every block.
 * Skeletons use solid bg-card (not card-glass) on purpose: in the PWA
 * every .card-glass gets backdrop-blur, and 7 blurred placeholder
 * surfaces during load is expensive GPU work for something that vanishes.
 */
function LoadingState() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading news">
      {/* Hero skeleton */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        className="overflow-hidden rounded-lg border bg-card"
      >
        <div className="aspect-[16/10] w-full shimmer" />
        <div className="space-y-3 p-4 pb-3">
          <div className="flex items-center gap-2">
            <div className="h-4 w-16 rounded-full shimmer bg-muted" />
            <div className="h-3 w-24 rounded-full shimmer bg-muted" />
          </div>
          <div className="h-6 w-11/12 rounded-md shimmer bg-muted" />
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div className="flex h-full">
              <div className="w-[38%] bg-blue-500/25" />
              <div className="w-[24%] bg-zinc-500/25" />
              <div className="w-[38%] bg-red-500/25" />
            </div>
          </div>
        </div>
      </motion.div>

      {/* Mini card grid skeleton */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{
              duration: 0.3,
              delay: 0.06 + i * 0.045,
              ease: [0.16, 1, 0.3, 1],
            }}
            className="flex gap-2.5 overflow-hidden rounded-lg border bg-card p-2.5"
          >
            <div className="h-20 w-20 shrink-0 rounded-md shimmer bg-muted" />
            <div className="flex flex-1 flex-col gap-2 py-0.5">
              <div className="h-3.5 w-4/5 rounded shimmer bg-muted" />
              <div className="h-3 w-3/5 rounded shimmer bg-muted" />
              <div className="mt-auto h-2 w-full rounded-full shimmer bg-muted" />
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  )
}

/**
 * useIsDesktop — true once the viewport reaches the lg breakpoint
 * (1024px). Used by the feed layouts to switch between the mobile
 * hero+minis layout (which users love) and the desktop magazine grid.
 * SSR renders the mobile layout (false default); desktop swaps once
 * after hydration — masked by the card entrance animations.
 */
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = React.useState(false)
  React.useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const update = () => setIsDesktop(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return isDesktop
}

// ── Sector detection for sectioned layout ──
// Mirrors the SECTOR_KEYWORDS in user-interests.ts but simplified for
// client-side sectioning. Topics are grouped into sections by their
// primary sector so the Relevant tab shows category headers (like BBC).
const SECTOR_KEYWORDS_FEED: Record<string, string[]> = {
  politics: ['trump', 'biden', 'starmer', 'parliament', 'congress', 'senate', 'election', 'vote', 'labour', 'conservative', 'democrat', 'republican', 'government', 'minister', 'prime minister', 'president', 'policy', 'cabinet', 'downing street', 'white house', 'supreme court', 'court ruling', 'lawmaker', 'legislation'],
  world: ['ukraine', 'russia', 'putin', 'china', 'israel', 'gaza', 'hamas', 'iran', 'middle east', 'europe', 'nato', 'united nations', 'refugee', 'ceasefire', 'nuclear', 'war', 'conflict'],
  business: ['stock', 'market', 'economy', 'inflation', 'interest rate', 'federal reserve', 'gdp', 'recession', 'tariff', 'trade war', 'merger', 'acquisition', 'earnings', 'ipo', 'oil price', 'wall street', 'banking', 'finance', 'profit', 'billion'],
  technology: ['ai ', 'artificial intelligence', 'openai', 'google', 'apple', 'microsoft', 'meta ', 'facebook', 'amazon', 'tesla', 'nvidia', 'chip', 'semiconductor', 'tiktok', 'elon musk', 'iphone', 'android', 'startup', 'crypto', 'bitcoin', 'cyber', 'hack'],
  science: ['nasa', 'spacex', 'rocket', 'mars', 'moon', 'space', 'astronaut', 'telescope', 'physics', 'chemistry', 'biology', 'genome', 'dna', 'researchers', 'scientists', 'discovery', 'breakthrough', 'climate', 'carbon', 'earthquake', 'volcano'],
  health: ['covid', 'pandemic', 'who ', 'vaccine', 'hospital', 'nhs', 'fda', 'medicine', 'drug', 'pharma', 'cancer', 'disease', 'outbreak', 'virus', 'flu', 'mental health', 'diabetes', 'heart', 'stroke'],
  sports: ['premier league', 'champions league', 'world cup', 'nba', 'nfl', 'arsenal', 'chelsea', 'liverpool', 'man city', 'barcelona', 'real madrid', 'cricket', 'rugby', 'golf', 'f1', 'formula 1', 'boxing', 'ufc', 'olympics', 'football', 'tennis'],
}

function detectSectorForFeed(title: string, summary: string = ''): string {
  const text = `${title} ${summary}`.toLowerCase()
  // Count how many keywords match for EACH sector, then pick the sector
  // with the most matches. This prevents a business story from being
  // classified as politics just because it mentions "government" once.
  let bestSector = 'general'
  let bestScore = 0
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS_FEED)) {
    let matches = 0
    for (const kw of keywords) {
      if (text.includes(kw)) matches++
    }
    if (matches > bestScore) {
      bestScore = matches
      bestSector = sector
    }
  }
  return bestSector
}

const SECTOR_LABELS: Record<string, string> = {
  politics: 'Politics',
  world: 'World News',
  business: 'Business',
  technology: 'Technology',
  science: 'Science',
  health: 'Health',
  sports: 'Sports',
  general: 'More News',
}

/**
 * SectionedFeed — BBC-style layout for the Relevant tab.
 *
 * Splits topics into sections by sector (Headlines, World, Business, Politics,
 * Technology, Science, etc.). Each section has a header label and a mix of
 * card sizes (hero, default, mini). On mobile, this shows 4+ stories at once
 * (using mini cards in 2-column rows) instead of one-by-one scroll.
 *
 * Personalized: sections matching the user's interests appear first.
 */
// ── In-memory cache for per-category section topics ──
// The Relevant tab fires 7 section fetches (world, politics, …) on mount.
// Without a cache, every tab switch back to Relevant re-fetched all 7 —
// even seconds apart. This module-level cache serves them instantly for
// SECTION_CACHE_TTL (5 min, matching the API's CDN s-maxage) and then
// refetches. Survives tab switches (same JS context), cutting Vercel
// invocations hard.
const SECTION_CACHE_TTL_MS = 5 * 60 * 1000
const sectionTopicsCache = new Map<string, { ts: number; topics: TopicArticle[] }>()

function SectionedFeed({
  topics,
  olderTopics,
  onOpenDetail,
  onDismiss,
  country,
  interests,
  engagement,
  myCountryTopics,
  onSearchClick,
}: {
  topics: TopicArticle[]
  olderTopics: TopicArticle[]
  onOpenDetail: (topic: TopicArticle) => void
  onDismiss?: (topic: TopicArticle) => void
  country?: CountryInfo | null
  interests: string[]
  engagement: EngagementStats
  /** GDELT-sourced country stories — passed from the parent (already
   * fetched for interspersing) so this component doesn't duplicate that
   * /api/news?category=mycountry request. */
  myCountryTopics?: TopicArticle[]
  onSearchClick: () => void
}) {
  // Desktop (lg+) renders a uniform 3-column magazine grid instead of the
  // mobile hero+minis layout (see the grid below).
  const isDesktop = useIsDesktop()
  const allTopics = [...topics, ...olderTopics]
  const [categoryTopics, setCategoryTopics] = React.useState<Record<string, TopicArticle[]>>({})
  const [loadingCategories, setLoadingCategories] = React.useState(true)

  // ── Section-local dismiss handler ──
  // SectionedFeed fetches its OWN topics from each subtopic category
  // (world, politics, etc.) into `categoryTopics` — these are NOT in the
  // parent's `topics` array. So when a card is dismissed here, we must
  // ALSO remove it from this component's internal state, otherwise the
  // card would reappear on the next render (parent state change wouldn't
  // touch categoryTopics).
  //
  // The wrapped handler:
  //   1. Filters the dismissed topic out of every category list
  //   2. Calls the parent's onDismiss (which bumps dislike engagement +
  //      removes from the parent's topics/olderTopics/myCountryTopics)
  const handleDismissInSection = React.useCallback((topic: TopicArticle) => {
    setCategoryTopics((prev) => {
      let changed = false
      const next: Record<string, TopicArticle[]> = {}
      for (const [key, list] of Object.entries(prev)) {
        const filtered = list.filter((t) => t.topicId !== topic.topicId)
        if (filtered.length !== list.length) changed = true
        next[key] = filtered
      }
      return changed ? next : prev
    })
    onDismiss?.(topic)
  }, [onDismiss])

  // ── Fetch top news directly from each subtopic category ──
  // Instead of using keyword detection on the relevant feed's own topics
  // (which was unreliable and put unrelated news in wrong categories),
  // we fetch the actual top stories from each category's API endpoint.
  // This guarantees that the "World News" section shows actual world news,
  // "Politics" shows actual politics, etc.
  //
  // PERF NOTES:
  //  - Served from the module-level sectionTopicsCache when younger than
  //    5 min → tab switches don't refetch anything.
  //  - Deferred via requestIdleCallback (fallback setTimeout) so the main
  //    feed paints FIRST; section fetches never compete with first paint.
  //  - The My Country section reuses the parent's myCountryTopics — no
  //    duplicate mycountry API call (the parent already fetched it for
  //    interspersing).
  React.useEffect(() => {
    let cancelled = false

    // ── Fetch ALL subtopic categories ──
    // Always fetch all standard categories (world, politics, business,
    // technology, science, health, sports) so every subcategory has its
    // own section in the Relevant feed. User interests just affect the
    // ORDER (interested categories appear first), not which are shown.
    const ALL_CATEGORIES = [
      'world', 'politics', 'business', 'technology',
      'science', 'health', 'sports',
    ]

    // Kick off AFTER first paint — idle callback when available.
    const start = () => {
      if (cancelled) return
      ;(async () => {
        // Serve any cache entries that are still fresh instantly.
        const now = Date.now()
        const toFetch: string[] = []
        const freshFromCache: Record<string, TopicArticle[]> = {}
        for (const cat of ALL_CATEGORIES) {
          const hit = sectionTopicsCache.get(cat)
          if (hit && now - hit.ts < SECTION_CACHE_TTL_MS) {
            freshFromCache[cat] = hit.topics
          } else {
            toFetch.push(cat)
          }
        }
        if (Object.keys(freshFromCache).length > 0) {
          setCategoryTopics((prev) => ({ ...prev, ...freshFromCache }))
          setLoadingCategories(false)
        }
        if (toFetch.length === 0) return

        try {
          const results = await Promise.allSettled(
            toFetch.map(async (cat) => {
              const params = new URLSearchParams({
                category: cat,
                limit: '3',
                minCoverage: '1',
                slim: '1',
              })
              const res = await fetch(`/api/news?${params.toString()}`, { cache: 'no-store' })
              if (!res.ok) return { cat, topics: [] }
              const json = await res.json()
              return { cat, topics: (json.topics || []) as TopicArticle[] }
            }),
          )
          if (cancelled) return
          const fetched: Record<string, TopicArticle[]> = {}
          const cacheTs = Date.now()
          // Extract each element to a local first — indexing results[i]
          // twice does NOT narrow PromiseRejectedResult away in TS.
          for (const result of results) {
            if (result.status === 'fulfilled') {
              const { cat, topics: t } = result.value
              fetched[cat] = t
              sectionTopicsCache.set(cat, { ts: cacheTs, topics: t })
            }
          }
          setCategoryTopics((prev) => ({ ...prev, ...fetched }))
        } catch {
          // silent
        } finally {
          if (!cancelled) setLoadingCategories(false)
        }
      })()
    }

    const idleId: number =
      typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback(start, { timeout: 800 })
        : window.setTimeout(start, 150)

    return () => {
      cancelled = true
      if (typeof idleId === 'number') {
        if (typeof window.cancelIdleCallback === 'function' && typeof window.requestIdleCallback === 'function') {
          window.cancelIdleCallback(idleId)
        } else {
          window.clearTimeout(idleId)
        }
      }
    }
  }, [])

  if (allTopics.length === 0 && loadingCategories) return null

  // ── Top Headlines: heavily personalized ──
  // For non-US users: HEAVILY demote US domestic news so country/world/
  // other subtopic news rises to the top. US news is still shown but
  // pushed way down unless it's a major international event.
  const hasPersonalization = interests.length > 0 || Object.keys(engagement || {}).length > 0
  const isUSUser = country?.code === 'US'

  // Broad US news detection — catches ANY US-focused story, not just Trump
  const usNewsKw = [
    // US politics
    'trump', 'biden', 'harris', 'obama', 'gop', 'republican', 'democrat',
    'us congress', 'us senate', 'us house', 'us supreme court', 'scotus',
    'senate hearing', 'house hearing', 'senator', 'congressman', 'congresswoman',
    'us poll', 'us approval', 'us election', 'us primary', 'us governor',
    // US domestic
    'us state', 'us law', 'us federal', 'us military', 'us troops',
    'white house', 'capitol', 'pentagon', 'fbi', 'cia', 'doj',
    // US cities (when the story is about US local news)
    'new york', 'los angeles', 'chicago', 'houston', 'phoenix', 'philadelphia',
    'san antonio', 'san diego', 'dallas', 'san jose', 'austin', 'jacksonville',
    'fort worth', 'columbus', 'indianapolis', 'charlotte', 'san francisco',
    'seattle', 'denver', 'boston', 'el paso', 'nashville', 'detroit',
    'portland', 'memphis', 'oklahoma city', 'las vegas', 'louisville',
    'baltimore', 'milwaukee', 'albuquerque', 'tucson', 'fresno',
    // US-specific terms
    'us weekly', 'us news', 'us marshals', 'us border', 'us customs',
    'us citizen', 'us nationals', 'us embassy',
  ]

  // World news keywords — boosted for ALL users
  const worldKw = ['ukraine', 'russia', 'putin', 'china', 'israel', 'gaza',
    'hamas', 'iran', 'middle east', 'nato', 'united nations', 'europe',
    'war', 'ceasefire', 'nuclear', 'un security', 'climate summit',
    'cop ', 'g20', 'g7', 'un general assembly', 'european union',
    'north korea', 'south korea', 'japan', 'india', 'modi', 'africa',
    'asia', 'latin america', 'refugee', 'migrant', 'air strike',
    'france', 'germany', 'macron', 'merz', 'turkey', 'erdogan',
    'australia', 'canada', 'brazil', 'argentina', 'mexico']

  function headlineScore(topic: TopicArticle): number {
    let score = personalizationBoost(topic, interests, engagement || {})

    const titleLower = topic.title.toLowerCase()

    // ── For NON-US users: heavily demote US domestic news ──
    // US news gets -80 (pushes it way down) so country/world/other news
    // naturally rises to the top of the headlines.
    if (!isUSUser) {
      let isUSNews = false
      for (const kw of usNewsKw) {
        if (titleLower.includes(kw)) {
          isUSNews = true
          break
        }
      }
      if (isUSNews) {
        score -= 80
      }
      // Extra blanket Trump demotion for non-US users
      if (titleLower.includes('trump')) {
        score -= 40
      }
    }

    // ── Boost world news for ALL users ──
    for (const kw of worldKw) {
      if (titleLower.includes(kw)) {
        score += 25
        break
      }
    }

    // ── Boost country-specific news (user's own country) ──
    if (country?.code && !isUSUser) {
      const cc = country.code.toLowerCase()
      const countryName = (country.name || '').toLowerCase()
      // Boost if the title mentions the user's country name or code
      if (titleLower.includes(countryName) || titleLower.includes(cc + ' ')) {
        score += 30
      }
      // UK-specific keywords
      if (country.code === 'GB' || country.code === 'UK') {
        const ukKw = ['uk ', 'britain', 'british', 'england', 'london', 'scotland',
          'wales', 'parliament', 'westminster', 'downing street', 'nhs',
          'starmer', 'burnham', 'labour', 'conservative', 'tories',
          'council tax', 'met police', 'heathrow', 'gatwick', 'bbc']
        for (const kw of ukKw) {
          if (titleLower.includes(kw)) {
            score += 30
            break
          }
        }
      }
      // India-specific keywords
      if (country.code === 'IN') {
        const inKw = ['india', 'indian', 'modi', 'delhi', 'mumbai', 'bengaluru',
          'chennai', 'kolkata', 'hyderabad', 'lok sabha', 'rajya sabha',
          'bjp', 'congress', 'parliament', 'supreme court of india', 'rbi', 'isro']
        for (const kw of inKw) {
          if (titleLower.includes(kw)) {
            score += 30
            break
          }
        }
      }
    }

    return score
  }

  let headlines: TopicArticle[]
  if (hasPersonalization) {
    const scored = allTopics
      .map((t) => ({ topic: t, score: headlineScore(t) }))
      .sort((a, b) => b.score - a.score)
    headlines = scored.slice(0, 5).map((s) => s.topic)
  } else {
    // New visitor — still demote US politics, boost world + UK
    const scored = allTopics
      .map((t) => ({ topic: t, score: headlineScore(t) }))
      .sort((a, b) => b.score - a.score)
    headlines = scored.slice(0, 5).map((s) => s.topic)
  }
  // Guarantee the FIRST headline has an image (hero card needs one).
  // If the top story has no image, swap it with the first story that
  // DOES have an image. The imageless story moves to position 2 (not
  // buried at the bottom) so important news without images still gets
  // high visibility.
  if (headlines.length > 0 && !headlines[0].imageUrl) {
    const firstWithImageIdx = headlines.findIndex((t, i) => i >= 1 && t.imageUrl)
    if (firstWithImageIdx > 0) {
      const imageTopic = headlines[firstWithImageIdx]
      // Remove the image topic from its position, then place it first.
      // The original first topic (imageless, important) goes to position 2.
      headlines = [
        imageTopic,           // position 1: has image (hero)
        headlines[0],         // position 2: the important imageless story
        ...headlines.slice(1, firstWithImageIdx),
        ...headlines.slice(firstWithImageIdx + 1),
      ]
    }
  }

  // ── Build sections ──
  // Top Headlines from the relevant feed, then each category's actual top news.
  const interestSet = new Set(interests)
  const allSections: Array<{
    key: string
    label: string
    topics: TopicArticle[]
    isInterested: boolean
  }> = []

  // ── Track all topicIds + titles + images already shown to prevent
  // duplicates across sections ──
  // If a story appears in Top Headlines, it won't appear again in World
  // News, Politics, etc. Each story shows only once, in the first section
  // it appears. We track not just topicId but also normalized title and
  // image URL — so the same story from different aggregators (RSS vs
  // GDELT, different topicIds) is still deduped.
  const shownTopicIds = new Set<string>()
  const shownTitles = new Set<string>()
  const shownImages = new Set<string>()
  // Normalize title for comparison: lowercase, collapse whitespace, strip
  // ALL punctuation (so smart quotes, apostrophes, etc. don't prevent
  // matching). e.g. "Spain's" → "spains" matches "Spains".
  const normTitle = (t: string) =>
    t.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
  const isDuplicate = (t: TopicArticle): boolean => {
    if (shownTopicIds.has(t.topicId)) return true
    const nt = normTitle(t.title)
    if (nt && shownTitles.has(nt)) return true
    const imgUrl = safeImageUrl(t.imageUrl)?.split('?')[0]?.trim()
    if (imgUrl && shownImages.has(imgUrl)) return true
    return false
  }
  const markShown = (t: TopicArticle) => {
    shownTopicIds.add(t.topicId)
    const nt = normTitle(t.title)
    if (nt) shownTitles.add(nt)
    const imgUrl = safeImageUrl(t.imageUrl)?.split('?')[0]?.trim()
    if (imgUrl) shownImages.add(imgUrl)
  }

  // Top Headlines
  if (headlines.length > 0) {
    for (const t of headlines) markShown(t)
    allSections.push({
      key: 'headlines',
      label: 'Top Headlines',
      topics: headlines,
      isInterested: false,
    })
  }

  // Category sections — sorted by user interests first, then default order
  // Filter out any topics already shown in Top Headlines or earlier sections.
  const categoryOrder = ['world', 'politics', 'business', 'technology', 'science', 'health']
  const sortedCategories = [...categoryOrder].sort((a, b) => {
    const aInterest = interestSet.has(a) ? 1 : 0
    const bInterest = interestSet.has(b) ? 1 : 0
    return bInterest - aInterest
  })

  for (const cat of sortedCategories) {
    const catTopics = categoryTopics[cat]
    if (!catTopics || catTopics.length === 0) continue
    // Filter out topics already shown in earlier sections (by topicId,
    // title, or image)
    const uniqueTopics = catTopics.filter((t) => !isDuplicate(t))
    if (uniqueTopics.length === 0) continue
    for (const t of uniqueTopics) markShown(t)
    allSections.push({
      key: cat,
      label: SECTOR_LABELS[cat] || cat,
      topics: uniqueTopics,
      isInterested: interestSet.has(cat),
    })
  }

  // ── Local News section (city-level) ──
  // If the user's city is detected (e.g. Ahmedabad, Reading), filter
  // the relevant feed for topics mentioning that city. This shows local
  // news that directly affects the user's area.
  const cityName = country?.city?.trim()
  const cityNameLower = cityName?.toLowerCase()
  if (cityNameLower && cityNameLower.length >= 3) {
    const localTopics = allTopics.filter((t) => {
      if (isDuplicate(t)) return false
      const text = `${t.title} ${t.summary}`.toLowerCase()
      return text.includes(cityNameLower)
    })
    if (localTopics.length > 0) {
      for (const t of localTopics) markShown(t)
      allSections.push({
        key: 'local',
        label: `${cityName} News`,
        topics: localTopics.slice(0, 7),
        isInterested: false,
      })
    }
  }

  // My Country section — placed naturally (not boosted).
  // Uses the parent's myCountryTopics (already fetched for interspersing)
  // instead of a duplicate /api/news?category=mycountry call from here.
  const myCountryCatTopics = myCountryTopics
  if (myCountryCatTopics && myCountryCatTopics.length > 0) {
    const uniqueMc = myCountryCatTopics.filter((t) => !isDuplicate(t))
    if (uniqueMc.length > 0) {
      for (const t of uniqueMc) markShown(t)
      const countryDisplay = country?.code === 'GB' ? 'UK' : (country?.code || 'My Country')
      allSections.push({
        key: 'mycountry',
        label: `${countryDisplay} News`,
        topics: uniqueMc,
        isInterested: false,
      })
    }
  }

  // Remaining relevant topics not in headlines (as "More News")
  const moreNews = allTopics.filter((t) => !isDuplicate(t))
  if (moreNews.length > 0) {
    for (const t of moreNews) markShown(t)
    allSections.push({
      key: 'more',
      label: 'More News',
      topics: moreNews,
      isInterested: false,
    })
  }

  return (
    <div className="space-y-8">
      {allSections.map((section, sectionIdx) => {
        const { key, label, topics: sectionTopics, isInterested } = section
        if (sectionTopics.length === 0) return null

        return (
          <motion.section
            key={key}
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-40px' }}
            transition={{ duration: 0.35, delay: Math.min(sectionIdx * 0.06, 0.3), ease: [0.16, 1, 0.3, 1] }}
            className="nw-cv-section"
          >
            <div className="mb-3 flex items-center justify-between border-b-2 border-foreground/10 pb-2">
              <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight">
                {label}
                {isInterested && (
                  <span className="text-[10px] font-normal text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                    Following
                  </span>
                )}
              </h2>
              {/* Search button on the right of each section header (mobile only) */}
              <button
                type="button"
                onClick={onSearchClick}
                className="lg:hidden inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-foreground/80 hover:bg-muted/80 transition-colors text-[11px] font-medium"
                aria-label="Search"
                title="Search news"
              >
                <Search className="h-3.5 w-3.5" />
                <span>Search</span>
              </button>
            </div>
            {/* ── Responsive section grid ──
                Mobile (<lg): hero full width on top, minis in 2-col below.
                Desktop (lg+): uniform 3-column magazine grid of full cards
                (image + summary + bias bar). The old hero+row-span-3 grid
                stretched the minis and left large dead gaps on wide
                screens — uniform cards align cleanly at any width. */}
            {isDesktop ? (
              <div className="grid grid-cols-3 gap-4">
                {sectionTopics.slice(0, 9).map((t, i) => (
                  <TopicCard
                    key={t.topicId}
                    topic={t}
                    onOpenDetail={onOpenDetail}
                    onDismiss={handleDismissInSection}
                    index={i}
                  />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {sectionTopics[0] && (
                  <div className="sm:col-span-2">
                    <TopicCard
                      key={sectionTopics[0].topicId}
                      topic={sectionTopics[0]}
                      variant="hero"
                      onOpenDetail={onOpenDetail}
                      onDismiss={handleDismissInSection}
                      index={0}
                    />
                  </div>
                )}
                {sectionTopics.slice(1, 7).map((t, i) => (
                  <TopicCard
                    key={t.topicId}
                    topic={t}
                    variant="mini"
                    onOpenDetail={onOpenDetail}
                    onDismiss={handleDismissInSection}
                    index={i + 1}
                  />
                ))}
              </div>
            )}
          </motion.section>
        )
      })}
    </div>
  )
}

/**
 * BlindspotSectionedFeed — like SectionedFeed but for the Blindspots tab.
 * Groups blindspot topics by their source category (World, Politics,
 * Business, etc.) and shows each as a section. Each section shows the
 * top blindspot stories from that category (most extreme first).
 *
 * Uses the same visual layout as SectionedFeed (1 hero + rest mini per
 * section) for consistency.
 */
function BlindspotSectionedFeed({
  sections,
  onOpenDetail,
  onDismiss,
  onSearchClick,
}: {
  sections: Record<string, TopicArticle[]>
  onOpenDetail: (topic: TopicArticle) => void
  onDismiss?: (topic: TopicArticle) => void
  onSearchClick: () => void
}) {
  const isDesktop = useIsDesktop()
  // Define the order of sections (matching the category nav order).
  // 'mycountry' and 'relevant' are mapped to friendlier labels.
  const SECTION_ORDER: Array<{ key: string; label: string }> = [
    { key: 'world', label: 'World' },
    { key: 'politics', label: 'Politics' },
    { key: 'top', label: 'Top Stories' },
    { key: 'business', label: 'Business' },
    { key: 'technology', label: 'Technology' },
    { key: 'science', label: 'Science' },
    { key: 'health', label: 'Health' },
    { key: 'sports', label: 'Sports' },
    { key: 'mycountry', label: 'My Country' },
    { key: 'relevant', label: 'Relevant' },
  ]

  // Build sections in order, skipping empty ones
  const allSections = SECTION_ORDER
    .map(({ key, label }) => ({
      key,
      label,
      topics: sections[key] || [],
    }))
    .filter((s) => s.topics.length > 0)

  if (allSections.length === 0) return null

  return (
    <div className="space-y-8">
      {allSections.map((section, sectionIdx) => {
        const { key, label, topics: sectionTopics } = section
        if (sectionTopics.length === 0) return null

        return (
          <motion.section
            key={key}
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-40px' }}
            transition={{
              duration: 0.35,
              delay: Math.min(sectionIdx * 0.06, 0.3),
              ease: 'easeOut',
            }}
            className="nw-cv-section"
          >
            <div className="mb-3 flex items-center justify-between border-b-2 border-foreground/10 pb-2">
              <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight">
                {label}
                <span className="text-[10px] font-normal text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                  {sectionTopics.length} blindspot{sectionTopics.length !== 1 ? 's' : ''}
                </span>
              </h2>
              <button
                type="button"
                onClick={onSearchClick}
                className="lg:hidden inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-foreground/80 hover:bg-muted/80 transition-colors text-[11px] font-medium"
                aria-label="Search"
                title="Search news"
              >
                <Search className="h-3.5 w-3.5" />
                <span>Search</span>
              </button>
            </div>
            {/* Same layout as SectionedFeed — desktop magazine grid vs
                mobile hero + minis. */}
            {isDesktop ? (
              <div className="grid grid-cols-3 gap-4">
                {sectionTopics.slice(0, 9).map((t, i) => (
                  <TopicCard
                    key={t.topicId}
                    topic={t}
                    onOpenDetail={onOpenDetail}
                    onDismiss={onDismiss}
                    index={i}
                  />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {sectionTopics[0] && (
                  <div className="sm:col-span-2">
                    <TopicCard
                      key={sectionTopics[0].topicId}
                      topic={sectionTopics[0]}
                      variant="hero"
                      onOpenDetail={onOpenDetail}
                      onDismiss={onDismiss}
                      index={0}
                    />
                  </div>
                )}
                {sectionTopics.slice(1, 7).map((t, i) => (
                  <TopicCard
                    key={t.topicId}
                    topic={t}
                    variant="mini"
                    onOpenDetail={onOpenDetail}
                    onDismiss={onDismiss}
                    index={i + 1}
                  />
                ))}
              </div>
            )}
          </motion.section>
        )
      })}
    </div>
  )
}

/**
 * MobileTopicLayout — same 1-large + rest-mini format as SectionedFeed, but
 * WITHOUT sector grouping. Used for non-Relevant tabs (World, Politics,
 * Business, etc.) so each tab shows ONLY its own topics in the same visual
 * layout. Topics are chunked into groups of 7 (1 hero + 6 mini) with a
 * section header using the tab's category label.
 */
function MobileTopicLayout({
  topics,
  olderTopics,
  onOpenDetail,
  onDismiss,
  label,
  onSearchClick,
}: {
  topics: TopicArticle[]
  olderTopics: TopicArticle[]
  onOpenDetail: (topic: TopicArticle) => void
  onDismiss?: (topic: TopicArticle) => void
  label: string
  onSearchClick: () => void
}) {
  // Hook must run before the early return below.
  const isDesktop = useIsDesktop()
  const allTopics = [...topics, ...olderTopics]
  if (allTopics.length === 0) return null

  // Guarantee the first topic has an image (hero card needs one).
  // If the top story has no image, swap it with the first story that
  // DOES have an image. The imageless story goes to position 2 (not
  // buried at the bottom) so important news without images still shows.
  let sorted = [...allTopics]
  if (sorted.length > 0 && !sorted[0].imageUrl) {
    const firstWithImageIdx = sorted.findIndex((t, i) => i >= 1 && t.imageUrl)
    if (firstWithImageIdx > 0) {
      const imageTopic = sorted[firstWithImageIdx]
      sorted = [
        imageTopic,           // position 1: has image (hero)
        sorted[0],           // position 2: the important imageless story
        ...sorted.slice(1, firstWithImageIdx),
        ...sorted.slice(firstWithImageIdx + 1),
      ]
    }
  }

  // Chunk into groups of 7 (1 hero + 6 mini per group)
  const chunks: TopicArticle[][] = []
  for (let i = 0; i < sorted.length; i += 7) {
    chunks.push(sorted.slice(i, i + 7))
  }

  return (
    <div className="space-y-8">
      {chunks.map((chunk, chunkIdx) => (
        <motion.section
          key={chunkIdx}
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-40px' }}
          transition={{ duration: 0.35, delay: Math.min(chunkIdx * 0.06, 0.3), ease: [0.16, 1, 0.3, 1] }}
          className="nw-cv-section"
        >
          {chunkIdx === 0 && (
            <div className="mb-3 flex items-center justify-between border-b-2 border-foreground/10 pb-2">
              <h2 className="text-lg font-bold tracking-tight">
                {label}
              </h2>
              {/* Search button on the right of the section header (mobile only) */}
              <button
                type="button"
                onClick={onSearchClick}
                className="lg:hidden inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-foreground/80 hover:bg-muted/80 transition-colors text-[11px] font-medium"
                aria-label="Search"
                title="Search news"
              >
                <Search className="h-3.5 w-3.5" />
                <span>Search</span>
              </button>
            </div>
          )}
          {/* ── Responsive grid ──
              Mobile: 1 hero + 6 minis per chunk (unchanged, users love it).
              Desktop: one continuous uniform 3-column magazine grid of
              full cards — no chunks, no stretching, clean alignment. */}
          {isDesktop ? (
            <div className="grid grid-cols-3 gap-4">
              {sorted.map((t, i) => (
                <TopicCard
                  key={t.topicId}
                  topic={t}
                  onOpenDetail={onOpenDetail}
                  onDismiss={onDismiss}
                  index={i}
                />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {chunk[0] && (
                <div className="sm:col-span-2">
                  <TopicCard
                    key={chunk[0].topicId}
                    topic={chunk[0]}
                    variant="hero"
                    onOpenDetail={onOpenDetail}
                    onDismiss={onDismiss}
                    index={0}
                  />
                </div>
              )}
              {chunk.slice(1, 7).map((t, i) => (
                <TopicCard
                  key={t.topicId}
                  topic={t}
                  variant="mini"
                  onOpenDetail={onOpenDetail}
                  onDismiss={onDismiss}
                  index={i + 1}
                />
              ))}
            </div>
          )}
        </motion.section>
      ))}
    </div>
  )
}
