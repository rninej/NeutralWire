'use client'

import * as React from 'react'
import { Bell, X, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'

const NOTIF_ASKED_KEY = 'neutralwire:ios-notif-asked'

/**
 * iOS Notification Permission Prompt.
 *
 * iOS Safari does NOT allow auto-requesting notification permission via
 * setTimeout. The request MUST be triggered by a user gesture (tap).
 *
 * This component shows a prominent banner when:
 * - The device is iOS
 * - The app is running in standalone mode (installed PWA from home screen)
 * - Notification permission hasn't been granted yet
 * - The user hasn't dismissed the banner
 *
 * The user must TAP "Enable Notifications" to trigger the permission prompt.
 */
export function IosNotificationPrompt() {
  const [show, setShow] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [granted, setGranted] = React.useState(false)

  React.useEffect(() => {
    // Detect iOS
    const ua = window.navigator.userAgent.toLowerCase()
    const isIOS = /iphone|ipad|ipod/.test(ua) && !(window as unknown as { MSStream?: unknown }).MSStream

    if (!isIOS) return // Only show on iOS

    // Detect desktop — don't show on desktop browsers
    const isDesktop = window.innerWidth >= 1024 && !/mobile/i.test(ua) && !('ontouchstart' in window)
    if (isDesktop) return

    // Check if running in standalone mode (installed PWA)
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true

    if (!isStandalone) return // Only show in installed PWA

    // Check if already granted
    if ('Notification' in window && Notification.permission === 'granted') {
      setGranted(true)
      return
    }

    // Check if already dismissed
    if (localStorage.getItem(NOTIF_ASKED_KEY) === 'true') return

    // Show the banner after 1.5 seconds
    const timer = setTimeout(() => setShow(true), 1500)
    return () => clearTimeout(timer)
  }, [])

  const handleEnable = async () => {
    setLoading(true)
    try {
      if ('Notification' in window) {
        const permission = await Notification.requestPermission()
        if (permission === 'granted') {
          setGranted(true)
          setShow(false)
          // Trigger push subscription by reloading (the page-client
          // useEffect will detect granted permission and subscribe).
          // We use a small delay so the Firebase sync completes first.
          const deviceId = localStorage.getItem('neutralwire:device-id')
          if (deviceId) {
            // Sync to Firebase
            fetch('/api/notifications', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ deviceId, enabled: true, frequency: 'daily3' }),
            }).catch(() => {})
          }
          // Reload after 1s so the push subscription code runs
          setTimeout(() => window.location.reload(), 1000)
        } else {
          // Denied — don't show again
          localStorage.setItem(NOTIF_ASKED_KEY, 'true')
          setShow(false)
        }
      }
    } catch {
      localStorage.setItem(NOTIF_ASKED_KEY, 'true')
      setShow(false)
    } finally {
      setLoading(false)
    }
  }

  const handleDismiss = () => {
    localStorage.setItem(NOTIF_ASKED_KEY, 'true')
    setShow(false)
  }

  if (!show || granted) return null

  return (
    <div className="fixed inset-x-0 top-0 z-[60] p-4">
      <div className="mx-auto max-w-md rounded-xl border-2 border-foreground/20 bg-background p-4 shadow-xl">
        <div className="flex items-start gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
            <Bell className="h-6 w-6" />
          </div>
          <div className="flex-1">
            <div className="font-bold text-sm">Enable Notifications</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Get 3 daily news updates — morning, lunch, and evening — with
              the top stories from across the political spectrum.
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                size="sm"
                className="h-9 flex-1 text-xs"
                onClick={handleEnable}
                disabled={loading}
              >
                {loading ? 'Asking…' : 'Enable Notifications'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-9 text-xs"
                onClick={handleDismiss}
              >
                Not now
              </Button>
            </div>
          </div>
          <button
            onClick={handleDismiss}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
