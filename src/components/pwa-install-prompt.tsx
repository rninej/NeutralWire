'use client'

import * as React from 'react'
import { Download, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

const DISMISS_KEY = 'neutralwire:pwa-install-dismissed'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/**
 * PWA install prompt for mobile.
 *
 * - Listens for the `beforeinstallprompt` event (fires on mobile browsers
 *   when the site meets PWA install criteria).
 * - Shows a custom install banner at the bottom of the screen.
 * - If the user dismisses it, stores a flag in localStorage and never
 *   shows it again.
 * - If the user installs the PWA, the event won't fire again.
 */
export function PwaInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] =
    React.useState<BeforeInstallPromptEvent | null>(null)
  const [showBanner, setShowBanner] = React.useState(false)

  React.useEffect(() => {
    // Don't show if already dismissed or already installed (standalone mode).
    if (localStorage.getItem(DISMISS_KEY) === 'true') return
    if (window.matchMedia('(display-mode: standalone)').matches) return

    // If arriving via a referral link (?ref=...), show the install prompt
    // immediately on mobile (don't wait for beforeinstallprompt).
    const urlParams = new URLSearchParams(window.location.search)
    const hasRef = urlParams.get('ref')
    const isMobile = window.innerWidth < 768
    if (hasRef && isMobile) {
      // Small delay so the page can render first.
      setTimeout(() => setShowBanner(true), 1500)
    }

    const handler = (e: Event) => {
      e.preventDefault() // Prevent the default browser prompt
      setDeferredPrompt(e as BeforeInstallPromptEvent)
      // Show immediately if there's a referral, otherwise wait for the
      // banner timer above.
      if (hasRef) {
        setShowBanner(true)
      } else {
        setShowBanner(true)
      }
    }

    window.addEventListener('beforeinstallprompt', handler)

    // Also hide if the app gets installed while banner is showing.
    const installedHandler = () => {
      setShowBanner(false)
      setDeferredPrompt(null)
    }
    window.addEventListener('appinstalled', installedHandler)

    return () => {
      window.removeEventListener('beforeinstallprompt', handler)
      window.removeEventListener('appinstalled', installedHandler)
    }
  }, [])

  const handleInstall = async () => {
    if (!deferredPrompt) return
    await deferredPrompt.prompt()
    const choice = await deferredPrompt.userChoice
    if (choice.outcome === 'dismissed') {
      localStorage.setItem(DISMISS_KEY, 'true')
    }
    setShowBanner(false)
    setDeferredPrompt(null)
  }

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY, 'true')
    setShowBanner(false)
  }

  if (!showBanner) return null

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-sm rounded-xl border bg-background p-4 shadow-lg">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
          <Download className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <div className="font-semibold text-sm">Install NeutralWire</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Add to your home screen for quick access to neutral news.
          </div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" className="h-8 text-xs" onClick={handleInstall}>
              Install
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
  )
}
