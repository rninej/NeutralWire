'use client'

import * as React from 'react'
import {
  Lock,
  Loader2,
  Users,
  Eye,
  MousePointerClick,
  Globe,
  Monitor,
  Smartphone,
  Tablet,
  Clock,
  TrendingUp,
  Calendar,
  Download,
  RefreshCw,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  CheckCircle2,
  XCircle,
  AlertCircle,
  Bell,
  Zap,
  Radio,
  Sparkles,
  History,
  Layers,
  Eraser,
  FlaskConical,
  Play,
  Heart,
  Bug,
  Network,
  Timer,
  Rocket,
} from 'lucide-react'
import { getDeviceId } from '@/lib/referral'
import { COUNTRY_COORDS, latLngToXY } from '@/lib/country-coords'
import { cn } from '@/lib/utils'
import { DEFAULT_POPUP_MODE, type PopupMode } from '@/lib/popup-mode'
import {
  readLocalMeshEvents,
  readLocalMeshStats,
  type LocalMeshEvent,
  type LocalMeshStats,
} from '@/lib/mesh/mesh-log'
import { LayoutGrid, List, Underline, LayoutDashboard, PanelBottomOpen, AppWindow, Pill, PanelTop, MoveHorizontal, ChevronsRight } from 'lucide-react'

// ── Types ──
interface AnalyticsData {
  totalPageViews: number
  uniqueUsers: number
  uniqueSessions: number
  byBrowser: Array<{ name: string; count: number }>
  byDevice: Array<{ name: string; count: number }>
  byOS: Array<{ name: string; count: number }>
  byCountry: Array<{ code: string; name: string; count: number }>
  byPath: Array<{ path: string; count: number }>
  byHour: Array<{ hour: number; count: number }>
  byDay: Array<{ date: string; views: number; users: number }>
  topReferrers: Array<{ domain: string; count: number }>
  range: { fromTs: number; toTs: number; days: number }
  ts: number
}

// ── PWA growth metrics (unique-IP counting) ──
interface PwaStats {
  installsTotal: number
  installsToday: number
  installsByDay: Record<string, number>
  dauToday: number
  dauByDay: Record<string, number>
  appDauToday: number
  appDauByDay: Record<string, number>
  installRate7d: number
  days: number
  ts: number
}

interface CheckResult {
  step: string
  status: 'ok' | 'fail' | 'warn'
  detail: string
}

const PASSWORD_STORAGE_KEY = 'neutralwire:analytics-pw'

export default function DebugPage() {
  // ── Password gate state ──
  const [authed, setAuthed] = React.useState(false)
  const [passwordInput, setPasswordInput] = React.useState('')
  const [authError, setAuthError] = React.useState('')
  const [authing, setAuthing] = React.useState(false)

  // Check if already authed (sessionStorage — cleared when tab closes)
  React.useEffect(() => {
    try {
      const saved = sessionStorage.getItem(PASSWORD_STORAGE_KEY)
      if (saved) {
        setAuthed(true)
        passwordRef.current = saved
      }
    } catch {}
  }, [])

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthing(true)
    setAuthError('')
    try {
      // Test the password by making a tiny query (last 1 day)
      const res = await fetch('/api/analytics/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: passwordInput,
          fromTs: Date.now() - 24 * 60 * 60 * 1000,
          toTs: Date.now(),
        }),
      })
      if (res.ok) {
        sessionStorage.setItem(PASSWORD_STORAGE_KEY, passwordInput)
        setAuthed(true)
        passwordRef.current = passwordInput
      } else {
        setAuthError('Incorrect password')
      }
    } catch {
      setAuthError('Network error')
    } finally {
      setAuthing(false)
    }
  }

  // Password stored in a ref (memory only — cleared on page close)
  const passwordRef = React.useRef('')

  // ── Analytics data state ──
  const [data, setData] = React.useState<AnalyticsData | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [range, setRange] = React.useState<'24h' | '7d' | '30d' | '90d'>('7d')

  const fetchAnalytics = React.useCallback(async () => {
    if (!passwordRef.current) return
    setLoading(true)
    setError('')
    try {
      const now = Date.now()
      let fromTs = now
      switch (range) {
        case '24h': fromTs = now - 24 * 60 * 60 * 1000; break
        case '7d': fromTs = now - 7 * 24 * 60 * 60 * 1000; break
        case '30d': fromTs = now - 30 * 24 * 60 * 60 * 1000; break
        case '90d': fromTs = now - 90 * 24 * 60 * 60 * 1000; break
      }
      const res = await fetch('/api/analytics/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordRef.current, fromTs, toTs: now }),
      })
      if (!res.ok) {
        throw new Error(res.status === 401 ? 'Unauthorized' : 'Query failed')
      }
      const result = await res.json()
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [range])

  // ── PWA growth metrics — unique-IP installs / DAU / app-opens ──
  const [pwaStats, setPwaStats] = React.useState<PwaStats | null>(null)
  const [pwaLoading, setPwaLoading] = React.useState(false)
  const [pwaError, setPwaError] = React.useState('')

  const fetchPwaStats = React.useCallback(async () => {
    if (!passwordRef.current) return
    setPwaLoading(true)
    setPwaError('')
    try {
      const res = await fetch('/api/analytics/pwa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordRef.current, days: 14 }),
      })
      if (!res.ok) {
        throw new Error(res.status === 401 ? 'Unauthorized' : 'Query failed')
      }
      setPwaStats(await res.json())
    } catch (err) {
      setPwaError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setPwaLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (authed && passwordRef.current) {
      fetchAnalytics()
      fetchPwaStats()
    }
  }, [authed, range, fetchAnalytics, fetchPwaStats])

  // ── User bug reports (long-press a news card → Report a bug) ──
  // Each report arrives with the full article snapshot. "Make AI Fix"
  // sends it to /api/debug/ai-fix, where the AI rewrites the title /
  // summary, re-finds the photo, kills the video, or audits the sources
  // — and writes the fix into every store the story lives in.
  interface BugReportUi {
    id: string
    type: string
    note: string
    deviceId: string
    createdAt: number
    status: 'open' | 'fixed' | 'dismissed'
    topic: { topicId: string; title: string; coverage: number }
    fixedAt?: number
    aiNote?: string
    aiModel?: string
  }
  const [bugReports, setBugReports] = React.useState<BugReportUi[]>([])
  const [bugReportsLoading, setBugReportsLoading] = React.useState(false)
  const [fixingReportId, setFixingReportId] = React.useState<string | null>(null)
  const [fixNotes, setFixNotes] = React.useState<Record<string, string>>({})

  const fetchBugReports = React.useCallback(async () => {
    if (!passwordRef.current) return
    setBugReportsLoading(true)
    try {
      const res = await fetch(
        `/api/report?password=${encodeURIComponent(passwordRef.current)}`,
      )
      if (res.ok) {
        const json = await res.json()
        setBugReports(json.reports || [])
      }
    } catch {
      // silent — the refresh button retries
    } finally {
      setBugReportsLoading(false)
    }
  }, [])

  const makeAiFix = async (reportId: string) => {
    if (fixingReportId || !passwordRef.current) return
    setFixingReportId(reportId)
    try {
      // Can take 10-60s (AI + image pipeline + cache rewrites) — no
      // client timeout so long fixes complete.
      const res = await fetch('/api/debug/ai-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportId, password: passwordRef.current }),
      })
      const json = await res.json()
      if (res.ok && json.ok) {
        setFixNotes((n) => ({ ...n, [reportId]: json.aiNote }))
        setBugReports((rs) =>
          rs.map((r) =>
            r.id === reportId
              ? { ...r, status: 'fixed', aiNote: json.aiNote, aiModel: json.aiModel }
              : r,
          ),
        )
      } else {
        setFixNotes((n) => ({ ...n, [reportId]: `✗ ${json.error || 'Fix failed'}` }))
      }
    } catch {
      setFixNotes((n) => ({ ...n, [reportId]: '✗ Network error — try again' }))
    } finally {
      setFixingReportId(null)
    }
  }

  const dismissReport = async (reportId: string) => {
    try {
      await fetch('/api/report', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportId, password: passwordRef.current }),
      })
      setBugReports((rs) => rs.filter((r) => r.id !== reportId))
    } catch {
      // silent
    }
  }

  React.useEffect(() => {
    if (authed && passwordRef.current) fetchBugReports()
  }, [authed, fetchBugReports])

  // ── Mesh Relay Monitor (P2P relay + user-cron observability) ──
  // The "keep all bugs and unwanted switches as a record" requirement:
  // every fallback, verification failure, malformed payload, relay
  // switch and cron trigger is recorded — locally (this browser's ring,
  // read from localStorage) and cross-user (Firebase meshLogs, read via
  // the admin-gated /api/mesh/logs endpoint).
  interface MeshLogUi {
    id: string
    ts: number
    type: string
    room: string
    peerId: string
    detail: string
  }
  const [meshLogs, setMeshLogs] = React.useState<MeshLogUi[]>([])
  const [meshLogsLoading, setMeshLogsLoading] = React.useState(false)
  const [meshLocalStats, setMeshLocalStats] = React.useState<LocalMeshStats | null>(null)
  const [meshLocalEvents, setMeshLocalEvents] = React.useState<LocalMeshEvent[]>([])

  const fetchMeshLogs = React.useCallback(async () => {
    if (!passwordRef.current) return
    setMeshLogsLoading(true)
    try {
      const res = await fetch(
        `/api/mesh/logs?password=${encodeURIComponent(passwordRef.current)}`,
      )
      if (res.ok) {
        const json = await res.json()
        setMeshLogs(json.events || [])
      }
      setMeshLocalStats(readLocalMeshStats())
      setMeshLocalEvents(readLocalMeshEvents().slice(-14).reverse())
    } catch {
      // silent — the refresh button retries
    } finally {
      setMeshLogsLoading(false)
    }
  }, [])

  const clearMeshLogs = async () => {
    if (!passwordRef.current) return
    try {
      await fetch(
        `/api/mesh/logs?password=${encodeURIComponent(passwordRef.current)}`,
        { method: 'DELETE' },
      )
      setMeshLogs([])
    } catch {
      // silent
    }
  }

  React.useEffect(() => {
    if (authed && passwordRef.current) fetchMeshLogs()
  }, [authed, fetchMeshLogs])

  // ── Firebase Bandwidth monitor (Sep 2026 ETag fix observability) ──
  // /api/fb-stats reports the warm server instance's live counters:
  // real downloads, bytes SAVED via zero-byte 304 conditional reads,
  // hit ratio and the most recent Firebase operations. Poll every 5s.
  interface FbStats {
    sessionId: string
    sessionDownloadBytes: number
    sessionSavedBytes: number
    etag304Hits: number
    etagCacheEntries: number
    etagCacheBytes: number
    sessionOps: number
    recentOps: Array<{ path: string; method: string; bytes: number; ts: number }>
  }
  const [fbStats, setFbStats] = React.useState<FbStats | null>(null)

  React.useEffect(() => {
    if (!authed) return
    let alive = true
    const poll = async () => {
      try {
        const res = await fetch('/api/fb-stats', { cache: 'no-store' })
        if (res.ok) {
          const json = (await res.json()) as FbStats
          if (alive) setFbStats(json)
        }
      } catch {
        // silent — next tick retries
      }
    }
    void poll()
    const t = setInterval(poll, 5000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [authed])

  const fmtBytes = (n: number): string => {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(2)} MB`
  }

  // ── Push diagnostics (existing debug page content) ──
  const [deviceId, setDeviceId] = React.useState('')
  const [report, setReport] = React.useState<CheckResult[]>([])
  const [sending, setSending] = React.useState(false)
  const [sendingNews, setSendingNews] = React.useState(false)
  const [broadcasting, setBroadcasting] = React.useState(false)
  const [newsResult, setNewsResult] = React.useState<string | null>(null)
  const [broadcastResult, setBroadcastResult] = React.useState<string | null>(null)
  const [showPushTools, setShowPushTools] = React.useState(false)

  React.useEffect(() => {
    const id = getDeviceId()
    setDeviceId(id)
  }, [])

  // ── Feature flags — subtopic header style ──
  // One-click control that switches the homepage category header between
  // TEN designs — for ALL users, instantly (stored in Firebase, rendered
  // server-side on every page load).
  type NavMode =
    | 'cards' | 'classic' | 'tabs' | 'tiles' | 'sheet' | 'dock'
    | 'maxipills' | 'headerdock' | 'tabsarrow' | 'cardsarrow'
  const NAV_OPTIONS: Array<{
    id: NavMode
    name: string
    desc: string
    icon: React.ReactNode
  }> = [
    {
      id: 'cards',
      name: 'Big chips',
      desc: 'Icon chips with 40px targets in a scrollable row — the current default',
      icon: <LayoutGrid className="h-4 w-4" />,
    },
    {
      id: 'tabs',
      name: 'Bold tabs',
      desc: 'Text-only tabs, 44px tall, with a sliding underline — Google-News style',
      icon: <Underline className="h-4 w-4" />,
    },
    {
      id: 'tiles',
      name: 'Icon tiles',
      desc: 'Wrapping grid of bordered icon tiles — every topic visible, no scrolling',
      icon: <LayoutDashboard className="h-4 w-4" />,
    },
    {
      id: 'sheet',
      name: 'Browse sheet',
      desc: 'One wide button opens a sheet of 56px tiles — the biggest touch targets',
      icon: <PanelBottomOpen className="h-4 w-4" />,
    },
    {
      id: 'dock',
      name: 'Bottom dock',
      desc: 'Floating app-style dock at the bottom — Topics (folder preview) opens all topics; user-pinnable from Account',
      icon: <AppWindow className="h-4 w-4" />,
    },
    {
      id: 'classic',
      name: 'Classic pills',
      desc: 'The original small wrapping text pills (how the site looked before)',
      icon: <List className="h-4 w-4" />,
    },
    {
      id: 'maxipills',
      name: 'Maxi pills',
      desc: 'Classic pills at the biggest size that fits exactly two rows — adaptive font, rows filled edge-to-edge, same header height',
      icon: <Pill className="h-4 w-4" />,
    },
    {
      id: 'headerdock',
      name: 'Header dock',
      desc: 'The bottom-dock item style (icon over label) placed inline in the header — a native top tab bar',
      icon: <PanelTop className="h-4 w-4" />,
    },
    {
      id: 'tabsarrow',
      name: 'Bold tabs + arrow',
      desc: 'Bold text tabs with a floating swipe-hint arrow over the right edge — a symbol, not a button; fades out at the end',
      icon: <MoveHorizontal className="h-4 w-4" />,
    },
    {
      id: 'cardsarrow',
      name: 'Big chips + arrow',
      desc: 'The big icon chips with the same floating swipe-hint arrow',
      icon: <ChevronsRight className="h-4 w-4" />,
    },
  ]
  const [navMode, setNavMode] = React.useState<NavMode | null>(null)
  const [navFlipping, setNavFlipping] = React.useState(false)
  const [navFlipResult, setNavFlipResult] = React.useState<string | null>(null)

  // NOTE: navMode + popupMode are both loaded by the single /api/flags
  // fetch in the popup-system section below.

  const setSubtopicNav = async (mode: NavMode) => {
    if (navFlipping || mode === navMode || !passwordRef.current) return
    setNavFlipping(true)
    setNavFlipResult(null)
    try {
      const res = await fetch('/api/flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordRef.current, subtopicNav: mode }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok) {
        setNavMode(mode)
        const opt = NAV_OPTIONS.find((o) => o.id === mode)
        setNavFlipResult(`✓ Live for all users: ${opt?.name ?? mode}`)
      } else {
        setNavFlipResult(d.error || 'Failed to update')
      }
    } catch {
      setNavFlipResult('Network error')
    } finally {
      setNavFlipping(false)
    }
  }

  // ── Popup system — original popups vs the behavioral engine ──
  // Three selectable systems, stored like the nav flag (Firebase
  // featureFlags/popupSystem) and applied to ALL users on the next page
  // load (read server-side in page.tsx — no wrong-popup flash).
  const POPUP_OPTIONS: Array<{
    id: PopupMode
    name: string
    desc: string
    icon: React.ReactNode
  }> = [
    {
      id: 'smart',
      name: 'Smart system',
      desc: 'The behavioral engine (live default): install sheet asks only at peak moments — finished story, voted, 2–3 stories opened — with the phone mock + real social proof. Inside the PWA: milestone celebrations, never a donate popup.',
      icon: <Sparkles className="h-4 w-4" />,
    },
    {
      id: 'original',
      name: 'Original popups',
      desc: 'The classic system from before: install banner appears early (3s nudge on Samsung/iOS, first story, 400px scroll) with a 1-hour re-ask, and the installed PWA shows the Ko-fi donation popup every 10 stories.',
      icon: <History className="h-4 w-4" />,
    },
    {
      id: 'smart-firstvisit',
      name: 'Smart + first-visit popup',
      desc: 'The smart system exactly — but a brand-new visitor\'s very first visit shows the classic install popup (high visibility, early). The smart engine takes over from visit two; one ask per visit, always.',
      icon: <Layers className="h-4 w-4" />,
    },
  ]
  const [popupMode, setPopupMode] = React.useState<PopupMode | null>(null)
  const [popupFlipping, setPopupFlipping] = React.useState(false)
  const [popupFlipResult, setPopupFlipResult] = React.useState<string | null>(null)
  const [popupMemoryCleared, setPopupMemoryCleared] = React.useState(false)

  // ── Experimental features (notification Like + video Watch + video preview) ──
  // Boolean flags stored like the others (Firebase featureFlags/*).
  //   notifLike    (default ON)  → new notifications ship without the Like action when off
  //   videoWatch   (default ON)  → Watch pills vanish on next load + /api/video refuses
  //   videoPreview (default OFF) → big-card video preview on the home feed (half-volume, landscape-preferred)
  const [notifLike, setNotifLike] = React.useState<boolean | null>(null)
  const [notifLikeFlipping, setNotifLikeFlipping] = React.useState(false)
  const [notifLikeResult, setNotifLikeResult] = React.useState<string | null>(null)
  // Notification raise-fix (v27 sw.js) — tapping a notification while the
  // app idles in the background now VERIFIES the window actually came to
  // the foreground (Android Chrome's focus() can resolve without raising
  // it) and re-raises via openWindow() when it didn't. Also what makes the
  // notification Like button visibly do something. Default ON; this switch
  // is the full undo.
  const [notifRaiseFix, setNotifRaiseFix] = React.useState<boolean | null>(null)
  const [notifRaiseFixFlipping, setNotifRaiseFixFlipping] = React.useState(false)
  const [notifRaiseFixResult, setNotifRaiseFixResult] = React.useState<string | null>(null)
  const [videoWatch, setVideoWatch] = React.useState<boolean | null>(null)
  const [videoWatchFlipping, setVideoWatchFlipping] = React.useState(false)
  const [videoWatchResult, setVideoWatchResult] = React.useState<string | null>(null)
  const [videoPreview, setVideoPreview] = React.useState<boolean | null>(null)
  const [videoPreviewFlipping, setVideoPreviewFlipping] = React.useState(false)
  const [videoPreviewResult, setVideoPreviewResult] = React.useState<string | null>(null)
  // Milestone-popup body flag — the donate message (default) vs the
  // original celebration-only version (user: "make it so it says If you
  // love NeutralWire's free mission, Please Donate, which is switchable
  // to your original version from /debug experimental").
  const [milestoneDonate, setMilestoneDonate] = React.useState<boolean | null>(null)
  const [milestoneDonateFlipping, setMilestoneDonateFlipping] = React.useState(false)
  const [milestoneDonateResult, setMilestoneDonateResult] = React.useState<string | null>(null)
  // Mesh experimental features (both default ON per the user's spec):
  //   meshRelay → P2P news relay between visitors (WebRTC + signed manifests)
  //   userCron  → visitors drive the refresh/notify cron schedule via leases
  const [meshRelay, setMeshRelay] = React.useState<boolean | null>(null)
  const [meshRelayFlipping, setMeshRelayFlipping] = React.useState(false)
  const [meshRelayResult, setMeshRelayResult] = React.useState<string | null>(null)
  const [userCron, setUserCron] = React.useState<boolean | null>(null)
  const [userCronFlipping, setUserCronFlipping] = React.useState(false)
  const [userCronResult, setUserCronResult] = React.useState<string | null>(null)

  React.useEffect(() => {
    fetch('/api/flags')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const v = d?.subtopicNav
        setNavMode(
          ['cards', 'classic', 'tabs', 'tiles', 'sheet', 'dock', 'maxipills', 'headerdock', 'tabsarrow', 'cardsarrow'].includes(v) ? v : 'cards',
        )
        setPopupMode(
          ['original', 'smart', 'smart-firstvisit'].includes(d?.popupSystem)
            ? d.popupSystem
            : DEFAULT_POPUP_MODE,
        )
        setNotifLike(d?.notifLike !== false)
        setNotifRaiseFix(d?.notifRaiseFix !== false)
        setVideoWatch(d?.videoWatch !== false)
        setVideoPreview(d?.videoPreview === true)
        setMilestoneDonate(d?.milestoneDonate !== false)
        setMeshRelay(d?.meshRelay !== false)
        setUserCron(d?.userCron !== false)
      })
      .catch(() => {
        setNavMode('cards')
        setPopupMode(DEFAULT_POPUP_MODE)
        setNotifLike(true)
        setNotifRaiseFix(true)
        setVideoWatch(true)
        setVideoPreview(false)
        setMilestoneDonate(true)
        setMeshRelay(true)
        setUserCron(true)
      })
  }, [])

  /** POST one boolean flag (shared by the experimental switches). */
  const flipBooleanFlag = async (
    flag: 'notifLike' | 'notifRaiseFix' | 'videoWatch' | 'videoPreview' | 'milestoneDonate' | 'meshRelay' | 'userCron',
    value: boolean,
  ): Promise<boolean> => {
    if (!passwordRef.current) return false
    try {
      const res = await fetch('/api/flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordRef.current, [flag]: value }),
      })
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * Push a flag value into THIS device's service worker immediately, so a
   * flip made here affects the very next notification tap with no reload.
   * (The homepage mirrors flags the same way on every load for everyone.)
   */
  const pushFlagToServiceWorker = async (flags: Record<string, boolean>) => {
    try {
      if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
      const sw =
        navigator.serviceWorker.controller ||
        (await navigator.serviceWorker.ready).active
      sw?.postMessage({ type: 'NW_SW_FLAGS', ...flags })
    } catch {
      // SW not controlling this page yet — the next homepage load syncs it.
    }
  }

  const setPopupSystem = async (mode: PopupMode) => {
    if (popupFlipping || mode === popupMode || !passwordRef.current) return
    setPopupFlipping(true)
    setPopupFlipResult(null)
    try {
      const res = await fetch('/api/flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordRef.current, popupSystem: mode }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok) {
        setPopupMode(mode)
        const opt = POPUP_OPTIONS.find((o) => o.id === mode)
        setPopupFlipResult(`✓ Live for all users: ${opt?.name ?? mode}`)
      } else {
        setPopupFlipResult(d.error || 'Failed to update')
      }
    } catch {
      setPopupFlipResult('Network error')
    } finally {
      setPopupFlipping(false)
    }
  }

  // Wipe THIS browser's popup memory (dismissals, snoozes, first-visit
  // marker, story counts, milestones, donate thresholds) so each system
  // can be tested from a genuinely clean slate.
  const clearPopupMemory = () => {
    const keys = [
      'neutralwire:pwa-install-dismissed',
      'neutralwire:pwa-install-fv-dismissed',
      'neutralwire:pwa-installed-flag',
      'neutralwire:pwa-install-never',
      'neutralwire:pwa-install-dismiss-count',
      'neutralwire:pwa-install-last-shown',
      'neutralwire:first-seen',
      'neutralwire:articles-opened',
      'neutralwire:milestone-celebrated',
      'neutralwire:love-sent',
      'neutralwire:donate-shown-at',
      'neutralwire:donate-next-threshold',
      'neutralwire:donate-pressed',
    ]
    for (const k of keys) {
      try { localStorage.removeItem(k) } catch {}
    }
    try { sessionStorage.removeItem('neutralwire:first-visit-live') } catch {}
    setPopupMemoryCleared(true)
    setTimeout(() => setPopupMemoryCleared(false), 2500)
  }

  const runCheck = async (id: string, action: 'check' | 'send') => {
    setSending(action === 'send')
    try {
      const res = await fetch(`/api/debug/push?deviceId=${id}&action=${action}`)
      const d = await res.json()
      setReport(d.report || [])
    } catch {
      setReport([{ step: 'Error', status: 'fail', detail: 'Failed to run debug check' }])
    } finally {
      setSending(false)
    }
  }

  const sendNewsNow = async () => {
    setSendingNews(true)
    setNewsResult(null)
    try {
      const res = await fetch('/api/push/test-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId }),
      })
      const d = await res.json()
      setNewsResult(d.sent > 0 ? `Sent ${d.sent} notifications!` : d.error || d.message || 'No notifications sent.')
    } catch (err) {
      setNewsResult('Failed: ' + String(err))
    } finally {
      setSendingNews(false)
    }
  }

  const broadcast = async () => {
    setBroadcasting(true)
    setBroadcastResult(null)
    try {
      const res = await fetch('/api/push/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId }),
      })
      const d = await res.json()
      setBroadcastResult(d.sent > 0 ? `Broadcast sent to ${d.sent} device(s)!` : d.error || `No notifications sent. ${d.skipped || 0} skipped.`)
    } catch (err) {
      setBroadcastResult('Failed: ' + String(err))
    } finally {
      setBroadcasting(false)
    }
  }

  // ── Password gate screen ──
  if (!authed) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-md w-full p-8">
          <div className="flex flex-col items-center gap-4">
            <div className="rounded-full bg-primary/10 p-4">
              <Lock className="h-8 w-8 text-primary" />
            </div>
            <h1 className="text-2xl font-bold text-center">Analytics Dashboard</h1>
            <p className="text-sm text-muted-foreground text-center">
              Enter your password to access NeutralWire analytics.
            </p>
            <form onSubmit={handleAuth} className="w-full space-y-3">
              <input
                type="password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder="Password"
                autoFocus
                className="w-full rounded-lg border bg-background px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              {authError && (
                <p className="text-sm text-red-500 text-center">{authError}</p>
              )}
              <Button type="submit" disabled={authing || !passwordInput} className="w-full gap-2">
                {authing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
                Unlock
              </Button>
            </form>
            <p className="text-xs text-muted-foreground text-center mt-2">
              Password is verified via SHA-256 hash. It is never stored in plain text.
            </p>
          </div>
        </Card>
      </div>
    )
  }

  // ── Main analytics dashboard ──
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl p-4 md:p-6">
        {/* Header */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Analytics Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              NeutralWire website analytics
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={range} onValueChange={(v) => setRange(v as typeof range)}>
              <SelectTrigger className="w-[140px]">
                <Calendar className="h-4 w-4 mr-2" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="24h">Last 24 hours</SelectItem>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
                <SelectItem value="90d">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
            <Button
              onClick={() => {
                fetchAnalytics()
                fetchPwaStats()
              }}
              disabled={loading}
              variant="outline"
              size="icon"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button
              onClick={() => {
                sessionStorage.removeItem(PASSWORD_STORAGE_KEY)
                setAuthed(false)
                passwordRef.current = ''
              }}
              variant="outline"
              size="sm"
            >
              <Lock className="h-4 w-4 mr-2" />
              Lock
            </Button>
          </div>
        </div>

        {/* ── Quick-nav (mobile-friendly section jump) ──
            A sticky, horizontally-scrollable chip row: one tap jumps to any
            section of this (very long) dashboard. On phones this replaces
            the endless scroll-and-hunt that made /debug hard to navigate. */}
        <div className="sticky top-0 z-20 -mx-4 mb-6 bg-background/95 px-4 py-2.5 backdrop-blur md:-mx-6 md:px-6">
          <nav
            className="flex gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            aria-label="Dashboard sections"
          >
            {[
              ['#pwa-growth', 'Growth'],
              ['#feature-flags', 'Flags'],
              ['#popup-system', 'Popups'],
              ['#feature-toggles', 'Toggles'],
              ['#bug-reports', 'Bugs'],
              ['#mesh-monitor', 'Mesh'],
              ['#firebase-bandwidth', 'Bandwidth'],
              ['#traffic', 'Traffic'],
              ['#push-tools', 'Push'],
            ].map(([href, label]) => (
              <a
                key={href}
                href={href}
                className="shrink-0 rounded-full border border-border bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {label}
              </a>
            ))}
          </nav>
        </div>

        {/* ── Google Discover Kit ──
            The growth programme: 10-step plan, drop-in resources and live
            readiness checks. Its own mobile-first page (public — SEO
            guidance only, nothing sensitive), one tap from here. */}
        <Card className="mb-6 border-primary/20 bg-gradient-to-br from-blue-500/5 via-transparent to-red-500/5 p-4 md:p-6">
          <div className="flex items-center gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/50">
              <Rocket className="h-5 w-5 text-primary" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-bold">Google Discover Kit</h2>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                Get NeutralWire into the Discover feed — the 10-step plan, every
                resource, and live readiness checks. Story pages, sitemaps and
                RSS shipped with it.
              </p>
            </div>
            <a
              href="/debug/discover"
              className="shrink-0 rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-transform hover:scale-[1.03]"
            >
              Open →
            </a>
          </div>
        </Card>

        {loading && !data && (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* ── PWA Growth ──
            Unique-IP install + daily active user metrics. Every number on
            this card counts DISTINCT IP addresses — one person on two
            devices behind the same IP still counts once. */}
        <Card id="pwa-growth" className="mb-6 scroll-mt-20 p-4 md:p-6">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Download className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-base font-bold">PWA Growth</h2>
            <span className="text-xs text-muted-foreground">
              unique IP addresses only
            </span>
            {pwaLoading && (
              <Loader2 className="ml-auto h-4 w-4 animate-spin text-muted-foreground" />
            )}
            {!pwaLoading && pwaStats && (
              <span className="ml-auto text-xs text-muted-foreground">
                updated {new Date(pwaStats.ts).toLocaleTimeString()}
              </span>
            )}
          </div>

          {pwaError ? (
            <p className="text-sm text-red-500">{pwaError}</p>
          ) : !pwaStats ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* Stat tiles */}
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <div className="rounded-xl border bg-muted/40 p-3.5">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Download className="h-3.5 w-3.5" /> App installs
                  </div>
                  <div className="mt-1.5 text-2xl font-bold tabular-nums">
                    {pwaStats.installsTotal.toLocaleString()}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    all-time, distinct IPs
                  </div>
                </div>
                <div className="rounded-xl border bg-muted/40 p-3.5">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Download className="h-3.5 w-3.5" /> Installs today
                  </div>
                  <div className="mt-1.5 text-2xl font-bold tabular-nums">
                    {pwaStats.installsToday.toLocaleString()}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">UTC day</div>
                </div>
                <div className="rounded-xl border bg-muted/40 p-3.5">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Users className="h-3.5 w-3.5" /> Daily active
                  </div>
                  <div className="mt-1.5 text-2xl font-bold tabular-nums">
                    {pwaStats.dauToday.toLocaleString()}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    site + app, distinct IPs
                  </div>
                </div>
                <div className="rounded-xl border bg-muted/40 p-3.5">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Smartphone className="h-3.5 w-3.5" /> In the app
                  </div>
                  <div className="mt-1.5 text-2xl font-bold tabular-nums">
                    {pwaStats.appDauToday.toLocaleString()}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    opened installed PWA today
                  </div>
                </div>
              </div>

              {/* 7-day install rate */}
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
                <span>
                  <strong className="text-foreground">
                    {(pwaStats.installRate7d * 100).toFixed(1)}%
                  </strong>{' '}
                  of engaged visitors installed in the last 7 days
                  (installs ÷ daily actives, unique IPs)
                </span>
              </div>

              {/* 14-day bar chart: DAU vs installs */}
              {(() => {
                const days = Object.keys(pwaStats.dauByDay).sort()
                const max = Math.max(
                  1,
                  ...days.map(
                    (d) =>
                      Math.max(
                        pwaStats.dauByDay[d] || 0,
                        pwaStats.installsByDay[d] || 0,
                      ),
                  ),
                )
                return (
                  <div className="mt-4">
                    <div className="mb-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <span className="h-2 w-2 rounded-sm bg-foreground/70" />
                        daily active (unique IPs)
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="h-2 w-2 rounded-sm bg-emerald-500" />
                        installs
                      </span>
                    </div>
                    <div className="flex h-24 items-end gap-1.5">
                      {days.map((d) => {
                        const dau = pwaStats.dauByDay[d] || 0
                        const inst = pwaStats.installsByDay[d] || 0
                        return (
                          <div
                            key={d}
                            className="flex h-full flex-1 flex-col justify-end gap-[2px]"
                            title={`${d} — ${dau} active, ${inst} installs`}
                          >
                            <div
                              className="w-full rounded-t-sm bg-emerald-500"
                              style={{
                                height: `${(inst / max) * 100}%`,
                                minHeight: inst > 0 ? '2px' : '0',
                              }}
                            />
                            <div
                              className="w-full rounded-b-sm bg-foreground/70"
                              style={{
                                height: `${(dau / max) * 100}%`,
                                minHeight: dau > 0 ? '2px' : '0',
                              }}
                            />
                          </div>
                        )
                      })}
                    </div>
                    <div className="mt-1 flex gap-1.5 text-[10px] text-muted-foreground">
                      {days.map((d, i) => (
                        <span key={d} className="flex-1 text-center">
                          {i % 2 === 0 ? d.slice(5) : ''}
                        </span>
                      ))}
                    </div>
                  </div>
                )
              })()}
            </>
          )}
        </Card>

        {/* ── Feature Flags ──
            One-click switches that apply to ALL users instantly. */}
        <Card id="feature-flags" className="mb-6 scroll-mt-20 p-4 md:p-6">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Zap className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-base font-bold">Feature Flags</h2>
            <span className="ml-auto text-xs text-muted-foreground">
              Applies to all users within seconds
            </span>
          </div>
          <p className="mb-3 text-sm text-muted-foreground">
            Subtopic header style — a complaint said the classic category pills
            are too small and hard to read/click. Ten designs to choose from;
            pick the one every visitor sees and flip it back here anytime.
            Refresh the homepage after switching — the selected design is now
            rendered server-side, so it loads instantly with NO flash.
          </p>
          <div className="grid max-w-4xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {NAV_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setSubtopicNav(opt.id)}
                disabled={navFlipping || navMode === null}
                className={cn(
                  'flex flex-col items-start gap-1.5 rounded-xl border-2 p-3.5 text-left transition-colors disabled:opacity-60',
                  navMode === opt.id
                    ? 'border-foreground bg-muted'
                    : 'border-border hover:bg-muted/50',
                )}
              >
                <span className="flex items-center gap-2 text-sm font-bold">
                  {opt.icon}
                  {opt.name}
                  {navMode === opt.id && (
                    <span className="rounded-full bg-foreground px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-background">
                      Live
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">{opt.desc}</span>
              </button>
            ))}
          </div>
          {navFlipping && (
            <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating for all users…
            </p>
          )}
          {navFlipResult && (
            <p className="mt-3 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              {navFlipResult}
            </p>
          )}
        </Card>

        {/* ── Popup System ──
            Switch the WHOLE site between the original popup system
            (early install banner + PWA donate popup), the research-timed
            behavioral engine, and the hybrid (smart + first-visit popup). */}
        <Card id="popup-system" className="mb-6 scroll-mt-20 p-4 md:p-6">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <AppWindow className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-base font-bold">Popup System</h2>
            <span className="ml-auto text-xs text-muted-foreground">
              Applies to all users · A/B the popup rewrite
            </span>
          </div>
          <p className="mb-3 text-sm text-muted-foreground">
            Which popup system the whole site runs — the install prompt on the
            mobile website AND the donate/celebration moment inside the PWA,
            switched together. Stored like the header-style flag (Firebase),
            rendered server-side; <strong>refresh the homepage after
            switching</strong> to see it. Use the reset button below to wipe
            this browser's popup memory first — a first-visit popup only
            fires for a genuinely fresh visitor.
          </p>
          <div className="grid max-w-5xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {POPUP_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setPopupSystem(opt.id)}
                disabled={popupFlipping || popupMode === null}
                className={cn(
                  'flex flex-col items-start gap-1.5 rounded-xl border-2 p-3.5 text-left transition-colors disabled:opacity-60',
                  popupMode === opt.id
                    ? 'border-foreground bg-muted'
                    : 'border-border hover:bg-muted/50',
                )}
              >
                <span className="flex items-center gap-2 text-sm font-bold">
                  {opt.icon}
                  {opt.name}
                  {popupMode === opt.id && (
                    <span className="rounded-full bg-foreground px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-background">
                      Live
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">{opt.desc}</span>
              </button>
            ))}
          </div>
          {popupFlipping && (
            <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating for all users…
            </p>
          )}
          {popupFlipResult && (
            <p className="mt-3 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              {popupFlipResult}
            </p>
          )}
          {/* Local test-slate reset — device-local only, never touches
              the site-wide flag or other users. */}
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-3">
            <Button
              onClick={clearPopupMemory}
              variant="outline"
              size="sm"
              className="gap-2"
            >
              <Eraser className="h-3.5 w-3.5" />
              Reset this device's popup memory
            </Button>
            <span className="text-xs text-muted-foreground">
              Clears dismissals, snoozes, first-visit marker, story counts and
              milestone/donate history on THIS browser — so you experience the
              selected system as a brand-new visitor would.
            </span>
            {popupMemoryCleared && (
              <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                ✓ Cleared — refresh the homepage now
              </span>
            )}
          </div>
        </Card>

        {/* ── Feature Toggles ──
            The newer features, each removable in one click if it doesn't earn
            its place: the notification Like button, the video Watch button
            and the top-story video preview. */}
        <Card id="feature-toggles" className="mb-6 scroll-mt-20 p-4 md:p-6">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <FlaskConical className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-base font-bold">Feature Toggles</h2>
            <span className="ml-auto text-xs text-muted-foreground">
              Don't like one? Turn it off here
            </span>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">
            Like + the notification app-raise fix + Watch + the top-story
            video preview are live for every visitor right now, and the
            milestone popup carries the donate message. Each switch applies
            instantly for new notifications / new page loads — no redeploy
            needed. Flip them back the same way.
          </p>

          <div className="grid max-w-3xl gap-3">
            {/* ── Notification Like button ── */}
            <div
              className={cn(
                'flex items-start gap-3 rounded-xl border-2 p-4 transition-colors',
                notifLike === false ? 'border-border opacity-70' : 'border-border bg-muted/40',
              )}
            >
              <span
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                  notifLike ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground',
                )}
              >
                <Bell className="h-4.5 w-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold">Like button on notifications</span>
                  {notifLike !== null && (
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                        notifLike
                          ? 'bg-emerald-500 text-white'
                          : 'bg-muted-foreground/20 text-muted-foreground',
                      )}
                    >
                      {notifLike ? 'Live' : 'Removed'}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Push notifications get a <b>[Like | Not Interested]</b> pair.
                  Tapping Like opens the article, auto-presses its like button
                  (more stories like it for that user) and nudges the story up
                  everyone's feed a few positions. Requires Android/desktop
                  Chrome for the inline buttons — iOS doesn't render
                  notification actions.
                </p>
                {notifLikeResult && (
                  <p className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    {notifLikeResult}
                  </p>
                )}
              </div>
              <Button
                variant={notifLike ? 'destructive' : 'default'}
                size="sm"
                disabled={notifLikeFlipping || notifLike === null}
                onClick={async () => {
                  if (notifLikeFlipping || notifLike === null) return
                  setNotifLikeFlipping(true)
                  setNotifLikeResult(null)
                  const next = !notifLike
                  const ok = await flipBooleanFlag('notifLike', next)
                  if (ok) {
                    setNotifLike(next)
                    setNotifLikeResult(
                      next
                        ? '✓ On — new notifications carry the Like button'
                        : '✓ Off — new notifications ship without it',
                    )
                  } else {
                    setNotifLikeResult('Failed to update (check password)')
                  }
                  setNotifLikeFlipping(false)
                }}
                className="shrink-0"
              >
                {notifLikeFlipping ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : notifLike ? (
                  'Remove it'
                ) : (
                  'Turn on'
                )}
              </Button>
            </div>

            {/* ── Notification raise verification (v27) ── */}
            <div
              className={cn(
                'flex items-start gap-3 rounded-xl border-2 p-4 transition-colors',
                notifRaiseFix === false ? 'border-border opacity-70' : 'border-border bg-muted/40',
              )}
            >
              <span
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                  notifRaiseFix ? 'bg-blue-500/15 text-blue-500' : 'bg-muted text-muted-foreground',
                )}
              >
                <Smartphone className="h-4.5 w-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold">Bring the app to the front on notification taps</span>
                  {notifRaiseFix !== null && (
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                        notifRaiseFix
                          ? 'bg-emerald-500 text-white'
                          : 'bg-muted-foreground/20 text-muted-foreground',
                      )}
                    >
                      {notifRaiseFix ? 'Live' : 'Reverted'}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Fixes: tapping a notification (or its <b>Like</b>) while the
                  app is open in the background opened the story <i>inside</i>{" "}
                  the hidden app without ever bringing it to the screen —
                  Android Chrome's <code>focus()</code> can resolve without
                  raising the window. The service worker now verifies the app
                  actually became visible and, when it didn't, re-opens it via{" "}
                  <code>openWindow()</code> — the same raise path a cold start
                  uses. Turning this off restores the previous focus-trusting
                  behaviour; the change applies to this device immediately and
                  to everyone else on their next app load.
                </p>
                {notifRaiseFixResult && (
                  <p className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    {notifRaiseFixResult}
                  </p>
                )}
              </div>
              <Button
                variant={notifRaiseFix ? 'destructive' : 'default'}
                size="sm"
                disabled={notifRaiseFixFlipping || notifRaiseFix === null}
                onClick={async () => {
                  if (notifRaiseFixFlipping || notifRaiseFix === null) return
                  setNotifRaiseFixFlipping(true)
                  setNotifRaiseFixResult(null)
                  const next = !notifRaiseFix
                  const ok = await flipBooleanFlag('notifRaiseFix', next)
                  if (ok) {
                    setNotifRaiseFix(next)
                    // Mirror the flip into THIS device's service worker right
                    // away — the very next notification tap already honours
                    // it, no reload needed.
                    await pushFlagToServiceWorker({ notifRaiseFix: next })
                    setNotifRaiseFixResult(
                      next
                        ? '✓ On — notification taps now verify + raise the app (live here now, everywhere on next load)'
                        : '✓ Off — previous notification-open behaviour restored (live here now, everywhere on next load)',
                    )
                  } else {
                    setNotifRaiseFixResult('Failed to update (check password)')
                  }
                  setNotifRaiseFixFlipping(false)
                }}
                className="shrink-0"
              >
                {notifRaiseFixFlipping ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : notifRaiseFix ? (
                  'Turn off'
                ) : (
                  'Turn on'
                )}
              </Button>
            </div>

            {/* ── Video Watch button ── */}
            <div
              className={cn(
                'flex items-start gap-3 rounded-xl border-2 p-4 transition-colors',
                videoWatch === false ? 'border-border opacity-70' : 'border-border bg-muted/40',
              )}
            >
              <span
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                  videoWatch ? 'bg-red-500/15 text-red-500' : 'bg-muted text-muted-foreground',
                )}
              >
                <Play className="h-4.5 w-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold">Watch button (video version)</span>
                  {videoWatch !== null && (
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                        videoWatch
                          ? 'bg-emerald-500 text-white'
                          : 'bg-muted-foreground/20 text-muted-foreground',
                      )}
                    >
                      {videoWatch ? 'Live' : 'Removed'}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  A Watch pill inside articles only (bottom-left of the image,
                  never on the home feed) that plays a video of the story —
                  the source's own video when its feed carries one, else a
                  matching video from a news outlet on YouTube. Videos must
                  be longer than 10 seconds and from channels with at least
                  10k subscribers. Refresh after switching to see the change.
                </p>
                {videoWatchResult && (
                  <p className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    {videoWatchResult}
                  </p>
                )}
              </div>
              <Button
                variant={videoWatch ? 'destructive' : 'default'}
                size="sm"
                disabled={videoWatchFlipping || videoWatch === null}
                onClick={async () => {
                  if (videoWatchFlipping || videoWatch === null) return
                  setVideoWatchFlipping(true)
                  setVideoWatchResult(null)
                  const next = !videoWatch
                  const ok = await flipBooleanFlag('videoWatch', next)
                  if (ok) {
                    setVideoWatch(next)
                    setVideoWatchResult(
                      next
                        ? '✓ On — refresh the homepage to see the Watch pills'
                        : '✓ Off — refresh and the buttons are gone (API refuses too)',
                    )
                  } else {
                    setVideoWatchResult('Failed to update (check password)')
                  }
                  setVideoWatchFlipping(false)
                }}
                className="shrink-0"
              >
                {videoWatchFlipping ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : videoWatch ? (
                  'Turn off'
                ) : (
                  'Turn on'
                )}
              </Button>
            </div>

            {/* ── Top story video preview ── */}
            <div
              className={cn(
                'flex items-start gap-3 rounded-xl border-2 p-4 transition-colors',
                videoPreview ? 'border-border bg-muted/40' : 'border-border opacity-70',
              )}
            >
              <span
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                  videoPreview ? 'bg-blue-500/15 text-blue-500' : 'bg-muted text-muted-foreground',
                )}
              >
                <Play className="h-4.5 w-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold">Top story video preview</span>
                  {videoPreview !== null && (
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                        videoPreview
                          ? 'bg-emerald-500 text-white'
                          : 'bg-muted-foreground/20 text-muted-foreground',
                      )}
                    >
                      {videoPreview ? 'Live' : 'Off'}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Every large news card (the hero cards + the desktop
                  magazine grid) shows a small WATCH chip in the image's
                  bottom-left corner and plays a video preview inside its
                  image the moment it is on screen — resolved in the
                  user's language, preferring landscape videos
                  (short-form videos play too when that's the coverage),
                  sound at half volume (un-muted at the first user
                  interaction if the browser muted the autoplay), and
                  shown only once fully loaded (no loading box). Tapping
                  a card with a rolling preview opens the article with
                  the video continuing right where the preview was — and
                  a tap while it is still resolving hands it over the
                  moment it lands (the feed never keeps playing behind
                  the article). Scroll down — each big card resolves as
                  it comes into view. Refresh the homepage after
                  switching to see the change.
                </p>
                {videoPreviewResult && (
                  <p className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    {videoPreviewResult}
                  </p>
                )}
              </div>
              <Button
                variant={videoPreview ? 'destructive' : 'default'}
                size="sm"
                disabled={videoPreviewFlipping || videoPreview === null}
                onClick={async () => {
                  if (videoPreviewFlipping || videoPreview === null) return
                  setVideoPreviewFlipping(true)
                  setVideoPreviewResult(null)
                  const next = !videoPreview
                  const ok = await flipBooleanFlag('videoPreview', next)
                  if (ok) {
                    setVideoPreview(next)
                    setVideoPreviewResult(
                      next
                        ? '✓ On — refresh the homepage to see the preview'
                        : '✓ Off — refresh and the preview is gone',
                    )
                  } else {
                    setVideoPreviewResult('Failed to update (check password)')
                  }
                  setVideoPreviewFlipping(false)
                }}
                className="shrink-0"
              >
                {videoPreviewFlipping ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : videoPreview ? (
                  'Turn off'
                ) : (
                  'Turn on'
                )}
              </Button>
            </div>

            {/* ── Milestone popup: donate version vs original ── */}
            <div
              className={cn(
                'flex items-start gap-3 rounded-xl border-2 p-4 transition-colors',
                milestoneDonate === false ? 'border-border opacity-70' : 'border-border bg-muted/40',
              )}
            >
              <span
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                  milestoneDonate ? 'bg-red-500/15 text-red-500' : 'bg-muted text-muted-foreground',
                )}
              >
                <Heart className="h-4.5 w-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold">Milestone popup: donate version</span>
                  {milestoneDonate !== null && (
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                        milestoneDonate
                          ? 'bg-emerald-500 text-white'
                          : 'bg-muted-foreground/20 text-muted-foreground',
                      )}
                    >
                      {milestoneDonate ? 'Donate' : 'Original'}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Inside the installed PWA, the stories-read milestone popup
                  carries the body <b>"If you love NeutralWire's free
                  mission, Please Donate"</b> with a real Donate-on-Ko-fi
                  button (this switch ON — the default). Flip it OFF to
                  return to the ORIGINAL celebration-only version: next-
                  milestone progress bar, the community love counter and
                  the share-the-balance button, with no donation ask
                  (the behavioral design that never ended a happy reading
                  session on an ask — the Ko-fi card stayed in Account →
                  Support). Refresh the PWA after switching; the next
                  milestone crossed shows the new body.
                </p>
                {milestoneDonateResult && (
                  <p className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    {milestoneDonateResult}
                  </p>
                )}
              </div>
              <Button
                variant={milestoneDonate ? 'destructive' : 'default'}
                size="sm"
                disabled={milestoneDonateFlipping || milestoneDonate === null}
                onClick={async () => {
                  if (milestoneDonateFlipping || milestoneDonate === null) return
                  setMilestoneDonateFlipping(true)
                  setMilestoneDonateResult(null)
                  const next = !milestoneDonate
                  const ok = await flipBooleanFlag('milestoneDonate', next)
                  if (ok) {
                    setMilestoneDonate(next)
                    setMilestoneDonateResult(
                      next
                        ? '✓ Donate version — the next milestone popup asks for support'
                        : '✓ Original version — celebration only, no donate ask',
                    )
                  } else {
                    setMilestoneDonateResult('Failed to update (check password)')
                  }
                  setMilestoneDonateFlipping(false)
                }}
                className="shrink-0"
              >
                {milestoneDonateFlipping ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : milestoneDonate ? (
                  'Use original'
                ) : (
                  'Use donate'
                )}
              </Button>
            </div>

            {/* ── P2P news relay (meshRelay) ── */}
            <div
              className={cn(
                'flex items-start gap-3 rounded-xl border p-3 md:p-4',
                meshRelay === false ? 'border-border opacity-70' : 'border-border bg-muted/40',
              )}
            >
              <span
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                  meshRelay ? 'bg-emerald-500/15 text-emerald-500' : 'bg-muted text-muted-foreground',
                )}
              >
                <Network className="h-4.5 w-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold">P2P news relay (visitors serve visitors)</span>
                  {meshRelay !== null && (
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                        meshRelay
                          ? 'bg-emerald-500 text-white'
                          : 'bg-muted-foreground/20 text-muted-foreground',
                      )}
                    >
                      {meshRelay ? 'Mesh on' : 'Off'}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Visitors in the same feed room (same category + country —
                  country feeds never mix) relay the news to each other over
                  WebRTC: one relay per room reads Firebase directly and pushes
                  snapshots to everyone else, cutting server cost per feed
                  from O(users) to O(rooms). Every payload is verified against
                  an ECDSA-signed server manifest; at 12+ peers, verification
                  switches to 3-random-peer consensus with a periodic signed
                  anchor. Any failure, timeout or tampering fails CLOSED —
                  the visitor fetches from the server like before. The mesh
                  never slows a cold load. All fallbacks and blocks are
                  recorded in the Mesh Relay Monitor below.
                </p>
                {meshRelayResult && (
                  <p className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    {meshRelayResult}
                  </p>
                )}
              </div>
              <Button
                variant={meshRelay ? 'destructive' : 'default'}
                size="sm"
                disabled={meshRelayFlipping || meshRelay === null}
                onClick={async () => {
                  if (meshRelayFlipping || meshRelay === null) return
                  setMeshRelayFlipping(true)
                  setMeshRelayResult(null)
                  const next = !meshRelay
                  const ok = await flipBooleanFlag('meshRelay', next)
                  if (ok) {
                    setMeshRelay(next)
                    setMeshRelayResult(
                      next
                        ? '✓ Relay live — applies to every visitor on their next page load'
                        : '✓ Relay off — everyone loads the classic server way',
                    )
                  } else {
                    setMeshRelayResult('Failed to update (check password)')
                  }
                  setMeshRelayFlipping(false)
                }}
                className="shrink-0"
              >
                {meshRelayFlipping ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : meshRelay ? (
                  'Turn off'
                ) : (
                  'Turn on'
                )}
              </Button>
            </div>

            {/* ── User-powered cron (userCron) ── */}
            <div
              className={cn(
                'flex items-start gap-3 rounded-xl border p-3 md:p-4',
                userCron === false ? 'border-border opacity-70' : 'border-border bg-muted/40',
              )}
            >
              <span
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                  userCron ? 'bg-violet-500/15 text-violet-500' : 'bg-muted text-muted-foreground',
                )}
              >
                <Timer className="h-4.5 w-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold">User-powered cron (visitors run the schedule)</span>
                  {userCron !== null && (
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                        userCron
                          ? 'bg-violet-500 text-white'
                          : 'bg-muted-foreground/20 text-muted-foreground',
                      )}
                    >
                      {userCron ? 'Visitor cron' : 'Off'}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  The oldest live visitor checks job staleness every minute
                  and triggers the RSS refresh (30 min) and the timezone-aware
                  notification briefings (20 min) through one-time Firebase
                  leases — Firebase itself timestamps each lease, the server
                  consumes it once, and per-job interval floors (25 min / 14
                  min) bound even a spamming client. Server invocations now
                  happen only while visitors are actually online; an external
                  cron service (cron-job.org) keeps working as a backstop —
                  both paths dedupe, so devices never get the same briefing
                  twice.
                </p>
                {userCronResult && (
                  <p className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    {userCronResult}
                  </p>
                )}
              </div>
              <Button
                variant={userCron ? 'destructive' : 'default'}
                size="sm"
                disabled={userCronFlipping || userCron === null}
                onClick={async () => {
                  if (userCronFlipping || userCron === null) return
                  setUserCronFlipping(true)
                  setUserCronResult(null)
                  const next = !userCron
                  const ok = await flipBooleanFlag('userCron', next)
                  if (ok) {
                    setUserCron(next)
                    setUserCronResult(
                      next
                        ? '✓ Visitors drive the schedule — applies on their next page load'
                        : '✓ Visitor cron off — use an external cron service',
                    )
                  } else {
                    setUserCronResult('Failed to update (check password)')
                  }
                  setUserCronFlipping(false)
                }}
                className="shrink-0"
              >
                {userCronFlipping ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : userCron ? (
                  'Turn off'
                ) : (
                  'Turn on'
                )}
              </Button>
            </div>
          </div>
        </Card>

        {/* ── User Bug Reports + Make AI Fix ──
            Every long-press "Report a bug" on a news card lands here with
            the full article snapshot. Make AI Fix dispatches the report to
            the AI, which rewrites/regenerates/replaces the broken part and
            writes the fix everywhere (live cache, archive, summaries,
            title-rewrites, video caches, search index). */}
        <Card id="bug-reports" className="mb-6 scroll-mt-20 p-4 md:p-6">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Bug className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-base font-bold">User Bug Reports</h2>
            <span className="ml-auto flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {bugReports.filter((r) => r.status === 'open').length} open ·{' '}
                {bugReports.length} total
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={fetchBugReports}
                disabled={bugReportsLoading}
              >
                {bugReportsLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
              </Button>
            </span>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">
            Hold any news card → <b>Report</b> to file one. Each report ships
            with the story. <b>Make AI Fix</b> gives the AI full write access
            to that story everywhere it lives — headline, summary, photo,
            video and sources.
          </p>

          {bugReports.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No open reports. Long-press a news card → Report a bug to file one.
            </div>
          ) : (
            <div className="grid gap-3">
              {bugReports.map((r) => (
                <ReportRow
                  key={r.id}
                  report={r}
                  fixing={fixingReportId === r.id}
                  fixNote={fixNotes[r.id]}
                  onFix={() => makeAiFix(r.id)}
                  onDismiss={() => dismissReport(r.id)}
                />
              ))}
            </div>
          )}
        </Card>

        {/* ── Mesh Relay Monitor ──
            Observability for the two experimental mesh systems: every
            fallback, verification failure, malformed payload, relay
            switch and cron trigger is recorded here (local ring for this
            browser + the shared Firebase log across all visitors). */}
        <Card id="mesh-monitor" className="mb-6 scroll-mt-20 p-4 md:p-6">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Network className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-base font-bold">Mesh Relay Monitor</h2>
            <span className="ml-auto flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {meshLogs.length} recent events
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={fetchMeshLogs}
                disabled={meshLogsLoading}
              >
                {meshLogsLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={clearMeshLogs}
                disabled={meshLogs.length === 0}
              >
                <Eraser className="h-4 w-4" />
              </Button>
            </span>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">
            The record of every mesh fallback, unwanted switch and
            verification block across all visitors — the audit trail for
            the P2P relay and the user-powered cron. This browser's own
            counters appear first (from its last session on the home
            feed), then the shared cross-user log.
          </p>

          {/* This browser's mesh counters */}
          <div className="mb-4 grid grid-cols-3 gap-3 md:grid-cols-6">
            {[
              { label: 'Room joins', value: meshLocalStats?.joined },
              { label: 'Mesh-served', value: meshLocalStats?.served },
              { label: 'Relay pushes', value: meshLocalStats?.relaysServed },
              { label: 'Fallbacks', value: meshLocalStats?.fallbacks },
              { label: 'Verified', value: meshLocalStats?.verifyOk },
              { label: 'Blocked', value: meshLocalStats?.blocks },
            ].map((cell) => (
              <div
                key={cell.label}
                className="rounded-xl border bg-muted/30 p-3 text-center"
              >
                <div className="text-xl font-bold tabular-nums">
                  {cell.value ?? 0}
                </div>
                <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {cell.label}
                </div>
              </div>
            ))}
          </div>

          {/* This browser's recent mesh events */}
          {meshLocalEvents.length > 0 && (
            <div className="mb-4">
              <div className="mb-1.5 text-xs font-semibold">This browser</div>
              <div className="flex flex-wrap gap-1.5">
                {meshLocalEvents.map((ev, i) => (
                  <span
                    key={`${ev.ts}-${i}`}
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[10px] font-medium',
                      meshEventClass(ev.type),
                    )}
                    title={`${ev.room}${ev.detail ? ' — ' + ev.detail : ''}`}
                  >
                    {ev.type}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Shared cross-user log */}
          <div className="mb-1.5 text-xs font-semibold">All visitors (Firebase)</div>
          {meshLogs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No mesh events recorded yet. Open the home feed (with the P2P
              relay switch on) in one or more browsers — joins, relay
              elections, fallbacks and blocks will appear here.
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto rounded-xl border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                  <tr className="text-left text-muted-foreground">
                    <th className="px-3 py-2 font-semibold">When</th>
                    <th className="px-3 py-2 font-semibold">Event</th>
                    <th className="px-3 py-2 font-semibold">Room</th>
                    <th className="px-3 py-2 font-semibold">Peer</th>
                    <th className="px-3 py-2 font-semibold">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {meshLogs.map((ev) => (
                    <tr key={ev.id} className="border-t">
                      <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">
                        {meshTimeAgo(ev.ts)}
                      </td>
                      <td className="px-3 py-1.5">
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-[10px] font-bold',
                            meshEventClass(ev.type),
                          )}
                        >
                          {ev.type}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 font-mono">
                        {ev.room || '—'}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 font-mono text-muted-foreground">
                        {ev.peerId || '—'}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">
                        {ev.detail || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* ── Firebase Bandwidth (ETag conditional-read savings) ── */}
        <Card id="firebase-bandwidth" className="mb-6 scroll-mt-20 p-4 md:p-6">
          <div className="mb-4 flex items-center gap-2">
            <h2 className="text-base font-bold">Firebase Bandwidth</h2>
            <span className="text-xs text-muted-foreground">
              warm instance · refreshes every 5s
              {fbStats ? ` · session ${fbStats.sessionId}` : ''}
            </span>
          </div>
          {!fbStats ? (
            <p className="text-sm text-muted-foreground">Loading instance stats…</p>
          ) : (
            <>
              <div className="mb-4 grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="rounded-lg border p-3">
                  <div className="text-xs text-muted-foreground">Downloaded</div>
                  <div className="text-lg font-bold">{fmtBytes(fbStats.sessionDownloadBytes)}</div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-xs text-muted-foreground">Saved via 304s</div>
                  <div className="text-lg font-bold text-emerald-500">
                    {fmtBytes(fbStats.sessionSavedBytes)}
                  </div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-xs text-muted-foreground">304 hits</div>
                  <div className="text-lg font-bold">{fbStats.etag304Hits}</div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-xs text-muted-foreground">Hit ratio</div>
                  <div className="text-lg font-bold">
                    {fbStats.etag304Hits + (fbStats.sessionOps - fbStats.etag304Hits) > 0
                      ? Math.round(
                          (fbStats.etag304Hits /
                            Math.max(1, fbStats.etag304Hits + fbStats.sessionOps)) *
                            100,
                        ) + '%'
                      : '—'}
                  </div>
                </div>
              </div>
              <div className="text-xs text-muted-foreground mb-2">
                ETag cache: {fbStats.etagCacheEntries} paths · {fmtBytes(fbStats.etagCacheBytes)}
                cached · {fbStats.sessionOps} ops this instance
              </div>
              {fbStats.recentOps.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="px-2 py-1">op</th>
                        <th className="px-2 py-1">path</th>
                        <th className="px-2 py-1">bytes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fbStats.recentOps.slice(-8).reverse().map((op, i) => (
                        <tr key={i} className="border-b border-border/40">
                          <td
                            className={`whitespace-nowrap px-2 py-1 font-mono ${
                              op.method === 'GET304' ? 'text-emerald-500' : ''
                            }`}
                          >
                            {op.method}
                          </td>
                          <td className="px-2 py-1 font-mono text-muted-foreground truncate max-w-[280px]">
                            {op.path}
                          </td>
                          <td className="whitespace-nowrap px-2 py-1 font-mono">
                            {op.method === 'GET304' ? '0 (saved)' : fmtBytes(op.bytes)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </Card>

        {error && (
          <Card className="mb-6 border-red-500/30 p-4">
            <div className="flex items-center gap-2 text-red-500">
              <AlertCircle className="h-5 w-5" />
              <span className="text-sm font-medium">{error}</span>
            </div>
          </Card>
        )}

        {data && (
          <div id="traffic" className="scroll-mt-20">
            {/* KPI Cards */}
            <div className="mb-6 grid grid-cols-2 md:grid-cols-4 gap-4">
              <KPICard
                icon={<Eye className="h-5 w-5" />}
                label="Page Views"
                value={data.totalPageViews}
                color="text-blue-500"
              />
              <KPICard
                icon={<Users className="h-5 w-5" />}
                label="Unique Users"
                value={data.uniqueUsers}
                color="text-emerald-500"
              />
              <KPICard
                icon={<MousePointerClick className="h-5 w-5" />}
                label="Sessions"
                value={data.uniqueSessions}
                color="text-purple-500"
              />
              <KPICard
                icon={<Globe className="h-5 w-5" />}
                label="Countries"
                value={data.byCountry.filter((c) => c.code !== 'UNKNOWN').length}
                color="text-amber-500"
              />
            </div>

            {/* Daily Traffic Chart */}
            <Card className="mb-6 p-4 md:p-6">
              <div className="mb-4 flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-muted-foreground" />
                <h2 className="text-base font-bold">Daily Traffic</h2>
                <span className="ml-auto text-xs text-muted-foreground">
                  {data.range.days} day{data.range.days !== 1 ? 's' : ''}
                </span>
              </div>
              <DailyChart data={data.byDay} />
            </Card>

            <div className="grid md:grid-cols-2 gap-6 mb-6">
              {/* World Map */}
              <Card className="p-4 md:p-6 md:col-span-2">
                <div className="mb-4 flex items-center gap-2">
                  <Globe className="h-5 w-5 text-muted-foreground" />
                  <h2 className="text-base font-bold">User Locations</h2>
                </div>
                <WorldMap countries={data.byCountry} />
                <CountryList countries={data.byCountry} />
              </Card>

              {/* Browser breakdown */}
              <Card className="p-4 md:p-6">
                <div className="mb-4 flex items-center gap-2">
                  <Monitor className="h-5 w-5 text-muted-foreground" />
                  <h2 className="text-base font-bold">Browsers</h2>
                </div>
                <BreakdownList items={data.byBrowser} />
              </Card>

              {/* Device breakdown */}
              <Card className="p-4 md:p-6">
                <div className="mb-4 flex items-center gap-2">
                  <Smartphone className="h-5 w-5 text-muted-foreground" />
                  <h2 className="text-base font-bold">Devices</h2>
                </div>
                <DeviceBreakdown items={data.byDevice} />
              </Card>

              {/* OS breakdown */}
              <Card className="p-4 md:p-6">
                <div className="mb-4 flex items-center gap-2">
                  <Monitor className="h-5 w-5 text-muted-foreground" />
                  <h2 className="text-base font-bold">Operating Systems</h2>
                </div>
                <BreakdownList items={data.byOS} />
              </Card>

              {/* Top Referrers */}
              <Card className="p-4 md:p-6">
                <div className="mb-4 flex items-center gap-2">
                  <Download className="h-5 w-5 text-muted-foreground" />
                  <h2 className="text-base font-bold">Top Referrers</h2>
                </div>
                {data.topReferrers.length > 0 ? (
                  <BreakdownList items={data.topReferrers.map(r => ({ name: r.domain, count: r.count }))} />
                ) : (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    No referrers tracked yet
                  </p>
                )}
              </Card>

              {/* Hourly distribution */}
              <Card className="p-4 md:p-6 md:col-span-2">
                <div className="mb-4 flex items-center gap-2">
                  <Clock className="h-5 w-5 text-muted-foreground" />
                  <h2 className="text-base font-bold">Hourly Distribution (UTC)</h2>
                </div>
                <HourlyChart data={data.byHour} />
              </Card>

              {/* Top Pages */}
              <Card className="p-4 md:p-6 md:col-span-2">
                <div className="mb-4 flex items-center gap-2">
                  <Eye className="h-5 w-5 text-muted-foreground" />
                  <h2 className="text-base font-bold">Top Pages</h2>
                </div>
                <BreakdownList items={data.byPath.map(p => ({ name: p.path, count: p.count }))} />
              </Card>
            </div>

            {/* Push Notification Tools (collapsible) */}
            <Card id="push-tools" className="scroll-mt-20 p-4 md:p-6">
              <button
                onClick={() => setShowPushTools(!showPushTools)}
                className="w-full flex items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  <Bell className="h-5 w-5 text-muted-foreground" />
                  <h2 className="text-base font-bold">Push Notification Diagnostics</h2>
                </div>
                <span className="text-sm text-muted-foreground">
                  {showPushTools ? '− Hide' : '+ Show'}
                </span>
              </button>
              {showPushTools && (
                <div className="mt-4 space-y-4">
                  <Card className="border-2 border-foreground/20 p-4">
                    <h3 className="mb-2 flex items-center gap-2 text-sm font-bold">
                      <Zap className="h-4 w-4 text-amber-500" />
                      Test Background Notifications
                    </h3>
                    <Button onClick={sendNewsNow} disabled={sendingNews} className="w-full gap-2">
                      {sendingNews ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bell className="h-4 w-4" />}
                      Send news notifications NOW
                    </Button>
                    {newsResult && (
                      <div className="mt-3 rounded-md bg-muted p-3 text-xs">{newsResult}</div>
                    )}
                  </Card>
                  <Card className="border-2 border-blue-500/30 p-4">
                    <h3 className="mb-2 flex items-center gap-2 text-sm font-bold">
                      <Radio className="h-4 w-4 text-blue-500" />
                      Broadcast to All Devices
                    </h3>
                    <Button onClick={broadcast} disabled={broadcasting} className="w-full gap-2">
                      {broadcasting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radio className="h-4 w-4" />}
                      Broadcast to all devices
                    </Button>
                    {broadcastResult && (
                      <div className="mt-3 rounded-md bg-muted p-3 text-xs">{broadcastResult}</div>
                    )}
                  </Card>
                  <Card className="p-3">
                    <div className="text-xs text-muted-foreground">Your Device ID:</div>
                    <div className="font-mono text-sm break-all">{deviceId}</div>
                  </Card>
                  <div className="flex gap-2">
                    <Button onClick={() => runCheck(deviceId, 'check')} disabled={sending} size="sm">
                      {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Re-run check'}
                    </Button>
                    <Button onClick={() => runCheck(deviceId, 'send')} disabled={sending} size="sm" variant="outline">
                      {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send test push'}
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {report.map((check, i) => (
                      <Card key={i} className="p-3">
                        <div className="flex items-start gap-2">
                          {check.status === 'ok' && <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />}
                          {check.status === 'fail' && <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />}
                          {check.status === 'warn' && <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />}
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium">{check.step}</div>
                            <div className="mt-0.5 text-xs text-muted-foreground break-all">{check.detail}</div>
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          </div>
        )}
      </div>
    </div>
  )
}

// ── KPI Card ──
function KPICard({ icon, label, value, color }: {
  icon: React.ReactNode
  label: string
  value: number
  color: string
}) {
  return (
    <Card className="p-4 md:p-5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-muted-foreground font-medium">{label}</span>
        <span className={color}>{icon}</span>
      </div>
      <div className="text-2xl md:text-3xl font-bold">{value.toLocaleString()}</div>
    </Card>
  )
}

// ── Bug report row (User Bug Reports card) ──
const REPORT_TYPE_META: Record<string, { label: string; cls: string }> = {
  photo: { label: 'Incorrect photo', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  title: { label: 'Incorrect title', cls: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400' },
  summary: { label: 'Incorrect summary', cls: 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400' },
  sources: { label: 'Incorrect sources', cls: 'border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-400' },
  video: { label: 'Incorrect video', cls: 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400' },
  'summary-missing': { label: 'Summary missing', cls: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400' },
  other: { label: 'Other', cls: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400' },
}

function timeAgo(ms: number): string {
  const s = Math.max(1, Math.floor((Date.now() - (ms || 0)) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** Mesh monitor: relative time (mesh events carry epoch ms). */
function meshTimeAgo(ts: number): string {
  return timeAgo(ts || 0)
}

/** Mesh monitor: color class per event type (failures red, fallbacks
 *  amber, election/switches blue, cron violet, normal ops green). */
function meshEventClass(type: string): string {
  if (
    type.startsWith('verify-') && type !== 'verify-ok'
  ) {
    return 'bg-red-500/15 text-red-600 dark:text-red-400'
  }
  if (type === 'malformed' || type === 'rate-abuse' || type === 'stale-reject') {
    return 'bg-red-500/15 text-red-600 dark:text-red-400'
  }
  if (type.startsWith('fallback-')) {
    return 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
  }
  if (type.startsWith('cron-')) {
    return 'bg-violet-500/15 text-violet-600 dark:text-violet-400'
  }
  if (
    type === 'promote' ||
    type === 'relay-switch' ||
    type === 'connect' ||
    type === 'disconnect'
  ) {
    return 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
  }
  if (type === 'refresh-req' || type === 'refresh-served') {
    return 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400'
  }
  return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
}

function ReportRow({
  report,
  fixing,
  fixNote,
  onFix,
  onDismiss,
}: {
  report: {
    id: string
    type: string
    note: string
    createdAt: number
    status: 'open' | 'fixed' | 'dismissed'
    topic: { topicId: string; title: string; coverage: number }
    aiNote?: string
    aiModel?: string
  }
  fixing: boolean
  fixNote?: string
  onFix: () => void
  onDismiss: () => void
}) {
  const meta = REPORT_TYPE_META[report.type] || REPORT_TYPE_META.other
  const isFixed = report.status === 'fixed'
  const aiNote = fixNote || report.aiNote
  const noteIsError = aiNote?.startsWith('✗')

  return (
    <div
      className={cn(
        'rounded-xl border-2 p-4 transition-colors',
        isFixed ? 'border-emerald-500/25 bg-emerald-500/[0.04]' : 'border-border bg-muted/40',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={cn('text-[10px] font-semibold', meta.cls)}>
          {meta.label}
        </Badge>
        {isFixed ? (
          <span className="rounded-full bg-emerald-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
            Fixed
          </span>
        ) : (
          <span className="rounded-full bg-red-500/90 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
            Open
          </span>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {timeAgo(report.createdAt)} · {report.topic?.coverage ?? 1} src
        </span>
      </div>

      <div className="mt-2 line-clamp-2 text-sm font-bold leading-snug">
        {report.topic?.title || '(untitled story)'}
      </div>
      {report.note && (
        <div className="mt-1 line-clamp-2 text-xs italic text-muted-foreground">
          “{report.note}”
        </div>
      )}

      {(aiNote || fixing) && (
        <div
          className={cn(
            'mt-3 rounded-lg border p-3 text-xs leading-relaxed',
            noteIsError
              ? 'border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400'
              : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300',
          )}
        >
          {fixing ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              AI is fixing this report — rewriting the story data everywhere
              it lives. This can take up to a minute…
            </span>
          ) : (
            <>
              <Sparkles className="mr-1 inline h-3.5 w-3.5" />
              {aiNote}
              {report.aiModel && (
                <span className="ml-1 opacity-60">({report.aiModel})</span>
              )}
            </>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {!isFixed && (
          <Button
            size="sm"
            onClick={onFix}
            disabled={fixing}
            className="gap-1.5"
          >
            {fixing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {fixing ? 'AI is fixing…' : 'Make AI Fix'}
          </Button>
        )}
        {isFixed && (
          <Button size="sm" variant="outline" onClick={onFix} disabled={fixing} className="gap-1.5">
            {fixing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Re-run AI fix
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDismiss} disabled={fixing}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}

// ── Daily Traffic Chart (SVG bar chart) ──
function DailyChart({ data }: { data: Array<{ date: string; views: number; users: number }> }) {
  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground py-8 text-center">No data yet</p>
  }
  const maxViews = Math.max(...data.map((d) => d.views), 1)
  const barWidth = data.length > 1 ? 100 / data.length : 100
  return (
    <div>
      <div className="flex items-end gap-1 h-48 md:h-64 w-full">
        {data.map((d, i) => {
          const height = (d.views / maxViews) * 100
          return (
            <div
              key={i}
              className="flex-1 flex flex-col items-center justify-end h-full group relative"
              style={{ minWidth: '8px' }}
            >
              {/* Tooltip */}
              <div className="absolute -top-12 opacity-0 group-hover:opacity-100 transition-opacity bg-background border rounded-md shadow-lg p-2 text-xs whitespace-nowrap z-10 pointer-events-none">
                <div className="font-bold">{d.date}</div>
                <div className="text-muted-foreground">{d.views} views</div>
                <div className="text-muted-foreground">{d.users} users</div>
              </div>
              <div
                className="w-full rounded-t bg-blue-500/80 hover:bg-blue-500 transition-colors"
                style={{ height: `${height}%`, minHeight: d.views > 0 ? '2px' : '0' }}
              />
            </div>
          )
        })}
      </div>
      <div className="flex justify-between mt-2 text-xs text-muted-foreground">
        <span>{data[0]?.date}</span>
        <span>{data[data.length - 1]?.date}</span>
      </div>
    </div>
  )
}

// ── World Map (SVG with dots) ──
function WorldMap({ countries }: { countries: Array<{ code: string; name: string; count: number }> }) {
  const width = 800
  const height = 400
  const maxCount = Math.max(...countries.map((c) => c.count), 1)

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto"
        style={{ minWidth: '600px' }}
      >
        {/* Ocean background */}
        <rect width={width} height={height} fill="hsl(var(--muted) / 0.3)" rx="8" />

        {/* Simplified continent shapes (very rough, just for visual context) */}
        {/* These are approximate SVG paths drawn as rounded rectangles. They give
            a sense of landmasses without needing a full world map dataset. */}
        {/* North America */}
        <path d="M 80 80 Q 120 60 180 70 Q 240 80 260 120 L 250 180 Q 220 220 180 210 L 120 200 Q 80 180 70 140 Z" fill="hsl(var(--muted-foreground) / 0.15)" />
        {/* South America */}
        <path d="M 200 220 Q 230 230 240 260 L 235 320 Q 220 350 200 340 L 190 300 Q 185 260 200 220 Z" fill="hsl(var(--muted-foreground) / 0.15)" />
        {/* Europe */}
        <path d="M 380 90 Q 420 80 450 100 L 460 140 Q 440 160 400 155 L 380 130 Z" fill="hsl(var(--muted-foreground) / 0.15)" />
        {/* Africa */}
        <path d="M 400 170 Q 450 165 470 200 L 475 280 Q 460 320 430 315 L 410 280 Q 395 230 400 170 Z" fill="hsl(var(--muted-foreground) / 0.15)" />
        {/* Asia */}
        <path d="M 480 90 Q 580 70 680 100 L 700 180 Q 660 200 600 195 L 520 170 Q 470 150 480 90 Z" fill="hsl(var(--muted-foreground) / 0.15)" />
        {/* Australia */}
        <path d="M 620 280 Q 670 275 690 300 L 685 330 Q 660 340 630 330 L 615 310 Z" fill="hsl(var(--muted-foreground) / 0.15)" />

        {/* Country dots */}
        {countries.map((c, i) => {
          const coord = COUNTRY_COORDS[c.code] || COUNTRY_COORDS.UNKNOWN
          if (c.code === 'UNKNOWN') return null
          const { x, y } = latLngToXY(coord.lat, coord.lng, width, height)
          // Dot size proportional to count (min 4, max 20)
          const ratio = c.count / maxCount
          const r = 4 + Math.sqrt(ratio) * 16
          return (
            <g key={i}>
              {/* Glow ring */}
              <circle cx={x} cy={y} r={r + 4} fill="rgb(59 130 246 / 0.15)" />
              {/* Main dot */}
              <circle
                cx={x}
                cy={y}
                r={r}
                fill="rgb(59 130 246 / 0.7)"
                stroke="rgb(59 130 246)"
                strokeWidth="1.5"
              >
                <title>{`${coord.name}: ${c.count} views`}</title>
              </circle>
              {/* Count label for large dots */}
              {r > 8 && (
                <text
                  x={x}
                  y={y + r + 14}
                  textAnchor="middle"
                  className="text-[10px] fill-foreground"
                  style={{ fontSize: '10px', fontWeight: 'bold' }}
                >
                  {c.count}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ── Country List (below map) ──
function CountryList({ countries }: { countries: Array<{ code: string; name: string; count: number }> }) {
  if (!countries || countries.length === 0) return null
  const total = countries.reduce((sum, c) => sum + c.count, 0)
  const sorted = [...countries].sort((a, b) => b.count - a.count)
  return (
    <div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-2">
      {sorted.map((c, i) => (
        <div key={i} className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-mono font-bold shrink-0">{c.code}</span>
            <span className="text-sm truncate">{c.name}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-sm font-bold">{c.count}</span>
            <span className="text-xs text-muted-foreground">
              ({total > 0 ? Math.round((c.count / total) * 100) : 0}%)
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Breakdown List (horizontal bars) ──
function BreakdownList({ items }: { items: Array<{ name: string; count: number }> }) {
  if (!items || items.length === 0) {
    return <p className="text-sm text-muted-foreground py-4 text-center">No data yet</p>
  }
  const max = Math.max(...items.map((i) => i.count), 1)
  const total = items.reduce((sum, i) => sum + i.count, 0)
  const sorted = [...items].sort((a, b) => b.count - a.count)
  return (
    <div className="space-y-2">
      {sorted.map((item, i) => (
        <div key={i}>
          <div className="flex items-center justify-between text-sm mb-1">
            <span className="font-medium truncate">{item.name}</span>
            <span className="text-muted-foreground shrink-0 ml-2">
              {item.count} ({total > 0 ? Math.round((item.count / total) * 100) : 0}%)
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-blue-500/70"
              style={{ width: `${(item.count / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Device Breakdown (with icons) ──
function DeviceBreakdown({ items }: { items: Array<{ name: string; count: number }> }) {
  if (!items || items.length === 0) {
    return <p className="text-sm text-muted-foreground py-4 text-center">No data yet</p>
  }
  const total = items.reduce((sum, i) => sum + i.count, 0)
  const sorted = [...items].sort((a, b) => b.count - a.count)
  return (
    <div className="space-y-3">
      {sorted.map((item, i) => {
        const pct = total > 0 ? Math.round((item.count / total) * 100) : 0
        const icon = item.name === 'Mobile' ? <Smartphone className="h-4 w-4" />
          : item.name === 'Tablet' ? <Tablet className="h-4 w-4" />
          : <Monitor className="h-4 w-4" />
        return (
          <div key={i} className="flex items-center gap-3">
            <div className="flex items-center justify-center h-9 w-9 rounded-lg bg-muted">
              {icon}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{item.name}</span>
                <span className="text-muted-foreground">{item.count} ({pct}%)</span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-emerald-500/70"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Hourly Chart (24-bar) ──
function HourlyChart({ data }: { data: Array<{ hour: number; count: number }> }) {
  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground py-4 text-center">No data yet</p>
  }
  const max = Math.max(...data.map((d) => d.count), 1)
  return (
    <div>
      <div className="flex items-end gap-1 h-32 md:h-40">
        {data.map((d, i) => {
          const height = (d.count / max) * 100
          return (
            <div
              key={i}
              className="flex-1 flex flex-col items-center justify-end h-full group relative"
              style={{ minWidth: '6px' }}
            >
              <div className="absolute -top-10 opacity-0 group-hover:opacity-100 transition-opacity bg-background border rounded-md shadow-lg p-1.5 text-xs whitespace-nowrap z-10 pointer-events-none">
                <div className="font-bold">{d.hour}:00 UTC</div>
                <div className="text-muted-foreground">{d.count} views</div>
              </div>
              <div
                className="w-full rounded-t bg-purple-500/70 hover:bg-purple-500 transition-colors"
                style={{ height: `${height}%`, minHeight: d.count > 0 ? '2px' : '0' }}
              />
            </div>
          )
        })}
      </div>
      <div className="flex justify-between mt-2 text-xs text-muted-foreground">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>23:00</span>
      </div>
    </div>
  )
}
