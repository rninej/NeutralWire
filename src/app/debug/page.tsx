'use client'

import * as React from 'react'
import { CheckCircle2, XCircle, AlertCircle, Loader2, Bell, Zap, Radio } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { getDeviceId } from '@/lib/referral'

interface CheckResult {
  step: string
  status: 'ok' | 'fail' | 'warn'
  detail: string
}

export default function DebugPushPage() {
  const [report, setReport] = React.useState<CheckResult[]>([])
  const [loading, setLoading] = React.useState(true)
  const [sending, setSending] = React.useState(false)
  const [sendingNews, setSendingNews] = React.useState(false)
  const [broadcasting, setBroadcasting] = React.useState(false)
  const [deviceId, setDeviceId] = React.useState('')
  const [newsResult, setNewsResult] = React.useState<string | null>(null)
  const [broadcastResult, setBroadcastResult] = React.useState<string | null>(null)

  React.useEffect(() => {
    const id = getDeviceId()
    setDeviceId(id)
    runCheck(id, 'check')
  }, [])

  const runCheck = async (id: string, action: 'check' | 'send') => {
    setLoading(action === 'check')
    setSending(action === 'send')
    try {
      const res = await fetch(`/api/debug/push?deviceId=${id}&action=${action}`)
      const data = await res.json()
      setReport(data.report || [])
    } catch {
      setReport([{
        step: 'Error',
        status: 'fail',
        detail: 'Failed to run debug check',
      }])
    } finally {
      setLoading(false)
      setSending(false)
    }
  }

  // This sends the ACTUAL daily news notifications immediately
  // to YOUR device only (no auth required — you can only push to
  // your own device, not anyone else's).
  // Use this to test if notifications arrive with the app closed.
  const sendNewsNow = async () => {
    setSendingNews(true)
    setNewsResult(null)
    try {
      const res = await fetch('/api/push/test-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId }),
      })
      const data = await res.json()
      if (data.sent > 0) {
        setNewsResult(`Sent ${data.sent} notifications! Close the app/tab and wait — they should arrive within seconds.`)
      } else {
        setNewsResult(data.error || data.message || 'No notifications sent. Check the diagnostics below.')
      }
    } catch (err) {
      setNewsResult('Failed to send: ' + String(err))
    } finally {
      setSendingNews(false)
    }
  }

  // Broadcast: sends ONE notification to EVERY subscribed device.
  // Click this on your laptop → get a notification on your phone.
  const broadcast = async () => {
    setBroadcasting(true)
    setBroadcastResult(null)
    try {
      const res = await fetch('/api/push/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId }),
      })
      const data = await res.json()
      if (data.sent > 0) {
        setBroadcastResult(`Broadcast sent to ${data.sent} device(s)! Check your phone — a news notification should arrive within seconds.`)
      } else {
        setBroadcastResult(data.error || `No notifications sent. ${data.skipped || 0} devices skipped (not subscribed or notifications disabled).`)
      }
    } catch (err) {
      setBroadcastResult('Failed to broadcast: ' + String(err))
    } finally {
      setBroadcasting(false)
    }
  }

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-2 text-2xl font-bold">Push Notification Diagnostics</h1>
        <p className="mb-4 text-sm text-muted-foreground">
          This tool checks every step of the push notification chain to find
          exactly where it is breaking.
        </p>

        {/* ── Quick Test Section ── */}
        <Card className="mb-4 border-2 border-foreground/20 p-4">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-bold">
            <Zap className="h-4 w-4 text-amber-500" />
            Test Background Notifications
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Click the button below to send the real daily news notifications
            to your device right now. Then <strong>close this tab and the app
            completely</strong> — the notifications should still arrive within
            a few seconds (this proves background push works).
          </p>
          <Button
            onClick={sendNewsNow}
            disabled={sendingNews}
            className="w-full gap-2"
          >
            {sendingNews ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Sending notifications...
              </>
            ) : (
              <>
                <Bell className="h-4 w-4" />
                Send news notifications NOW
              </>
            )}
          </Button>
          {newsResult && (
            <div className="mt-3 rounded-md bg-muted p-3 text-xs">
              {newsResult}
            </div>
          )}
        </Card>

        {/* ── Broadcast Section ── */}
        <Card className="mb-4 border-2 border-blue-500/30 p-4">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-bold">
            <Radio className="h-4 w-4 text-blue-500" />
            Broadcast to All Devices
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Click this on your laptop to send ONE news notification to
            <strong> every device</strong> that has notifications enabled
            (including your phone). This tests if cross-device push works.
          </p>
          <Button
            onClick={broadcast}
            disabled={broadcasting}
            className="w-full gap-2"
            variant="default"
          >
            {broadcasting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Broadcasting to all devices...
              </>
            ) : (
              <>
                <Radio className="h-4 w-4" />
                Broadcast to all devices
              </>
            )}
          </Button>
          {broadcastResult && (
            <div className="mt-3 rounded-md bg-muted p-3 text-xs">
              {broadcastResult}
            </div>
          )}
        </Card>

        <Card className="mb-4 p-3">
          <div className="text-xs text-muted-foreground">Your Device ID:</div>
          <div className="font-mono text-sm break-all">{deviceId}</div>
        </Card>

        <div className="mb-4 flex gap-2">
          <Button
            onClick={() => runCheck(deviceId, 'check')}
            disabled={loading}
            size="sm"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Re-run check'}
          </Button>
          <Button
            onClick={() => runCheck(deviceId, 'send')}
            disabled={sending}
            size="sm"
            variant="outline"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send test push'}
          </Button>
        </div>

        <div className="space-y-2">
          {report.map((check, i) => (
            <Card key={i} className="p-3">
              <div className="flex items-start gap-2">
                {check.status === 'ok' && (
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
                )}
                {check.status === 'fail' && (
                  <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
                )}
                {check.status === 'warn' && (
                  <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{check.step}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground break-all">
                    {check.detail}
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>

        {report.length === 0 && !loading && (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            No results yet. Click Re-run check.
          </Card>
        )}

        <Card className="mt-6 p-4">
          <h2 className="mb-2 text-sm font-bold">How to test background push:</h2>
          <ol className="space-y-2 text-xs text-muted-foreground list-decimal list-inside">
            <li>Make sure all 10 checks above are green (except maybe step 8).</li>
            <li>Click <strong>&ldquo;Send news notifications NOW&rdquo;</strong> at the top.</li>
            <li><strong>Close this tab completely.</strong> Close the browser too if on mobile.</li>
            <li>Wait 5-10 seconds — you should see 3 news notifications arrive.</li>
            <li>If they arrive with the app closed, background push is working!</li>
            <li>If they only arrive when the app is open, the push service may not be delivering to your device when backgrounded (some Android battery savers block this — try disabling battery optimization for the browser).</li>
          </ol>
        </Card>

        <Card className="mt-4 p-4">
          <h2 className="mb-2 text-sm font-bold">How to fix common issues:</h2>
          <ul className="space-y-2 text-xs text-muted-foreground">
            <li>
              <strong>Step 2 fails (device not found):</strong> Open the homepage,
              wait 3 seconds for auto-registration, then come back here.
            </li>
            <li>
              <strong>Step 3 fails (notificationsEnabled false):</strong> Open the
              Refer page, enable notifications, then come back.
            </li>
            <li>
              <strong>Step 4 fails (no push subscription):</strong> The Push API
              subscription failed. Try: open Refer then enable notifications then
              check browser console for errors.
            </li>
            <li>
              <strong>Step 6 fails (send error):</strong> The VAPID keys may be
              wrong or the subscription expired. Check VAPID_PRIVATE_KEY env var
              on Vercel.
            </li>
            <li>
              <strong>Step 8 warns (no last notification):</strong> The Vercel
              Cron has not run yet. It runs daily at 8:00 UTC. Use the
              &ldquo;Send news NOW&rdquo; button above to test immediately.
            </li>
            <li>
              <strong>Step 9 warns (no CRON_SECRET):</strong> Set the
              CRON_SECRET environment variable in Vercel project settings.
            </li>
          </ul>
        </Card>
      </div>
    </div>
  )
}
