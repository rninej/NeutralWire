'use client'

import * as React from 'react'
import { Download, X, Share, Plus, Bell } from 'lucide-react'
import { Button } from '@/components/ui/button'

const DISMISS_KEY = 'neutralwire:pwa-install-dismissed'
const DISMISS_DURATION = 24 * 60 * 60 * 1000 // 24 hours (not permanent on iOS)

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/**
 * PWA install prompt.
 *
 * iOS Safari: Shows step-by-step instructions to use Share → Add to Home
 * Screen. Shows on EVERY visit (with a 24h dismiss cooldown) because iOS
 * doesn't support beforeinstallprompt. When the user opens the installed
 * PWA, the app auto-requests notification permission.
 *
 * Android Chrome: Listens for beforeinstallprompt, shows native install
 * dialog. Permanent dismiss if user says "Not now".
 */
export function PwaInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] =
    React.useState<BeforeInstallPromptEvent | null>(null)
  const [showBanner, setShowBanner] = React.useState(false)
  const [isIOS, setIsIOS] = React.useState(false)
  const [installed, setInstalled] = React.useState(false)

  React.useEffect(() => {
    // Detect iOS
    const ua = window.navigator.userAgent.toLowerCase()
    const ios = /iphone|ipad|ipod/.test(ua) && !(window as unknown as { MSStream?: unknown }).MSStream

    // Detect desktop browser — if definitely desktop, don't show install popup.
    // If unsure (mobile or ambiguous UA), show the popup.
    const isDesktop =
      !ios &&
      window.innerWidth >= 1024 && // wide screen
      !/android|mobile|iphone|ipad|ipod|windows phone/i.test(ua) && // no mobile UA
      ('ontouchstart' in window === false) // no touch support

    if (isDesktop) return // Don't show install popup on desktop

    // Check if already in standalone mode (PWA is installed).
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    if (standalone) {
      setInstalled(true)
      return
    }

    // Set iOS state for UI rendering
    setIsIOS(ios)

    // Helper: check if the dismiss cooldown is active.
    const isDismissed = () => {
      const dismissedAt = localStorage.getItem(DISMISS_KEY)
      if (!dismissedAt) return false
      const age = Date.now() - parseInt(dismissedAt, 10)
      if (ios && age < DISMISS_DURATION) return true // 24h cooldown on iOS
      if (!ios && age < DISMISS_DURATION * 365) return true // permanent on Android
      return false
    }

    // Helper: show the banner if not dismissed.
    const showIfAllowed = () => {
      if (isDismissed()) return
      setShowBanner(true)
    }

    // ── Trigger logic ──
    // 1. If the URL has ?topic= (user opened a shared story link), show
    //    the install prompt immediately. This is the highest-conversion
    //    moment because the user is engaged with a specific story.
    const urlParams = new URLSearchParams(window.location.search)
    const hasTopicParam = urlParams.has('topic')

    if (hasTopicParam) {
      // Small delay so the topic detail renders first
      setTimeout(showIfAllowed, 800)
    } else if (ios) {
      // 2. On iOS home page: show after 2 seconds
      setTimeout(showIfAllowed, 2000)
    }
    // 3. On Android home page: wait for beforeinstallprompt event (below)

    // Listen for beforeinstallprompt (Android Chrome only).
    const handler = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
      showIfAllowed()
    }
    window.addEventListener('beforeinstallprompt', handler)

    // Listen for the custom 'topic-opened' event (dispatched by TopicDetail
    // when a user clicks a card to open the full story view). This catches
    // the case where the user navigates from the home page to a story.
    const topicOpenedHandler = () => {
      // Slightly longer delay so the detail view is fully visible first
      setTimeout(showIfAllowed, 1500)
    }
    window.addEventListener('neutralwire:topic-opened', topicOpenedHandler)

    const installedHandler = () => {
      setShowBanner(false)
      setDeferredPrompt(null)
      setInstalled(true)
    }
    window.addEventListener('appinstalled', installedHandler)

    return () => {
      window.removeEventListener('beforeinstallprompt', handler)
      window.removeEventListener('neutralwire:topic-opened', topicOpenedHandler)
      window.removeEventListener('appinstalled', installedHandler)
    }
  }, [])

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
    setShowBanner(false)
  }

  if (installed || !showBanner) return null

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-sm rounded-xl border-2 border-transparent bg-gradient-to-r from-purple-500 via-blue-500 to-cyan-400 p-[2px] shadow-lg">
      <div className="rounded-[10px] bg-background p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
          <Download className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <div className="font-semibold text-sm">Install NeutralWire</div>

          {isIOS ? (
            // ── iOS step-by-step instructions ──
            <div className="mt-2 space-y-2">
              <div className="text-xs text-muted-foreground">
                Follow these steps to install the app:
              </div>

              <div className="flex items-start gap-2 rounded-md bg-muted/50 p-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-foreground text-[10px] font-bold text-background">1</span>
                <div className="flex items-center gap-1 text-xs">
                  Tap the
                  <Share className="inline h-3.5 w-3.5" />
                  <strong>Share</strong> button at the bottom of Safari
                </div>
              </div>

              <div className="flex items-start gap-2 rounded-md bg-muted/50 p-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-foreground text-[10px] font-bold text-background">2</span>
                <div className="flex items-center gap-1 text-xs">
                  Scroll down and tap
                  <Plus className="inline h-3.5 w-3.5" />
                  <strong>Add to Home Screen</strong>
                </div>
              </div>

              <div className="flex items-start gap-2 rounded-md bg-muted/50 p-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-foreground text-[10px] font-bold text-background">3</span>
                <div className="flex items-center gap-1 text-xs">
                  Tap <strong>Add</strong> — then open the app from your home screen
                </div>
              </div>

              <div className="flex items-center gap-1.5 rounded-md bg-blue-500/10 p-2 text-xs text-blue-600 dark:text-blue-400">
                <Bell className="h-3.5 w-3.5 shrink-0" />
                You will be asked to allow notifications when you open the app
              </div>

              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-full text-xs"
                onClick={handleDismiss}
              >
                Maybe later
              </Button>
            </div>
          ) : (
            // ── Android / Chrome ──
            <>
              <div className="mt-0.5 text-xs text-muted-foreground">
                Add to your home screen for quick access to neutral news and
                daily notifications.
              </div>
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  className="h-8 text-xs"
                  onClick={async () => {
                    if (deferredPrompt) {
                      await deferredPrompt.prompt()
                      const choice = await deferredPrompt.userChoice
                      if (choice.outcome === 'dismissed') handleDismiss()
                      setShowBanner(false)
                      setDeferredPrompt(null)
                    }
                  }}
                  disabled={!deferredPrompt}
                >
                  {deferredPrompt ? 'Install' : 'Loading…'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs"
                  onClick={handleDismiss}
                >
                  Not now
                </Button>
              </div>
            </>
          )}
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
