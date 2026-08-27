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
} from 'lucide-react'
import { getDeviceId } from '@/lib/referral'
import { COUNTRY_COORDS, latLngToXY } from '@/lib/country-coords'
import { cn } from '@/lib/utils'
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

  React.useEffect(() => {
    if (authed && passwordRef.current) {
      fetchAnalytics()
    }
  }, [authed, range, fetchAnalytics])

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
      desc: 'Floating app-style dock at the bottom — mobile tab-bar feel; More opens all topics',
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
      desc: 'Classic pills scaled as big as possible — 36-40px targets, still wrapping so all topics fit in one view',
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
      desc: 'Bold text tabs with a circular scroll arrow at the end of the row — an obvious "swipe for more" cue',
      icon: <MoveHorizontal className="h-4 w-4" />,
    },
    {
      id: 'cardsarrow',
      name: 'Big chips + arrow',
      desc: 'The big icon chips with the same scroll arrow at the end of the row',
      icon: <ChevronsRight className="h-4 w-4" />,
    },
  ]
  const [navMode, setNavMode] = React.useState<NavMode | null>(null)
  const [navFlipping, setNavFlipping] = React.useState(false)
  const [navFlipResult, setNavFlipResult] = React.useState<string | null>(null)

  React.useEffect(() => {
    fetch('/api/flags')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const v = d?.subtopicNav
        setNavMode(
          ['cards', 'classic', 'tabs', 'tiles', 'sheet', 'dock', 'maxipills', 'headerdock', 'tabsarrow', 'cardsarrow'].includes(v) ? v : 'cards',
        )
      })
      .catch(() => setNavMode('cards'))
  }, [])

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
            <Button onClick={fetchAnalytics} disabled={loading} variant="outline" size="icon">
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

        {loading && !data && (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* ── Feature Flags ──
            One-click switches that apply to ALL users instantly. */}
        <Card className="mb-6 p-4 md:p-6">
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

        {error && (
          <Card className="mb-6 border-red-500/30 p-4">
            <div className="flex items-center gap-2 text-red-500">
              <AlertCircle className="h-5 w-5" />
              <span className="text-sm font-medium">{error}</span>
            </div>
          </Card>
        )}

        {data && (
          <>
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
            <Card className="p-4 md:p-6">
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
          </>
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
