'use client'

import * as React from 'react'
import { X, Heart, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'

const ONBOARDED_KEY = 'neutralwire:onboarded'
const INTERESTS_KEY = 'neutralwire:interests'
const USAGE_KEY = 'neutralwire:usage-time'
const DONATE_SHOWN_KEY = 'neutralwire:donate-shown-at'
const DONATE_NEXT_KEY = 'neutralwire:donate-next-delay'
const DONATE_PRESSED_KEY = 'neutralwire:donate-pressed'

const SECTORS = [
  { id: 'politics', label: 'Politics', emoji: '🏛️' },
  { id: 'world', label: 'World News', emoji: '🌍' },
  { id: 'technology', label: 'Technology', emoji: '💻' },
  { id: 'business', label: 'Business', emoji: '📈' },
  { id: 'science', label: 'Science', emoji: '🔬' },
  { id: 'health', label: 'Health', emoji: '🏥' },
  { id: 'sports', label: 'Sports', emoji: '⚽' },
  { id: 'entertainment', label: 'Entertainment', emoji: '🎬' },
]

/**
 * PWA Onboarding + Donation Timer.
 *
 * Shows on first launch in the installed PWA:
 * 1. Interest selection popup (pick sectors → saved to localStorage + Firebase)
 * 2. Usage timer runs in background
 * 3. After 1 hour of usage → donation popup (Ko-fi)
 * 4. If dismissed: next popup after 2x the delay (2h → 4h → 8h → 16h)
 * 5. If pressed (donated): next popup after 3 months
 */
export function PwaOnboarding() {
  const [showOnboarding, setShowOnboarding] = React.useState(false)
  const [showDonate, setShowDonate] = React.useState(false)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())

  React.useEffect(() => {
    // Only in PWA (standalone mode)
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    if (!isStandalone) return

    // Check if onboarded
    const onboarded = localStorage.getItem(ONBOARDED_KEY)
    if (!onboarded) {
      setTimeout(() => setShowOnboarding(true), 1500)
    }

    // Load saved interests
    try {
      const saved = localStorage.getItem(INTERESTS_KEY)
      if (saved) setSelected(new Set(JSON.parse(saved)))
    } catch { /* ignore */ }

    // ── Usage timer ──
    let usageInterval: ReturnType<typeof setInterval>
    let lastActive = Date.now()

    const trackUsage = () => {
      const now = Date.now()
      const elapsed = now - lastActive
      lastActive = now

      // Only count if less than 5 min since last check (user is active)
      if (elapsed < 5 * 60 * 1000) {
        let total = parseInt(localStorage.getItem(USAGE_KEY) || '0', 10)
        total += elapsed
        localStorage.setItem(USAGE_KEY, String(total))

        // Check if we should show donation popup
        checkDonationPopup(total)
      }
    }

    usageInterval = setInterval(trackUsage, 30 * 1000) // check every 30s

    // Reset lastActive on user interaction
    const resetActive = () => { lastActive = Date.now() }
    window.addEventListener('click', resetActive)
    window.addEventListener('scroll', resetActive)
    window.addEventListener('keydown', resetActive)

    return () => {
      clearInterval(usageInterval)
      window.removeEventListener('click', resetActive)
      window.removeEventListener('scroll', resetActive)
      window.removeEventListener('keydown', resetActive)
    }
  }, [])

  const checkDonationPopup = (totalUsageMs: number) => {
    const pressed = localStorage.getItem(DONATE_PRESSED_KEY) === 'true'
    const shownAt = parseInt(localStorage.getItem(DONATE_SHOWN_KEY) || '0', 10)
    let nextDelay = parseInt(localStorage.getItem(DONATE_NEXT_KEY) || '0', 10)

    // If pressed (donated), wait 3 months
    if (pressed) {
      const threeMonths = 90 * 24 * 60 * 60 * 1000
      if (Date.now() - shownAt > threeMonths) {
        localStorage.setItem(DONATE_PRESSED_KEY, 'false')
        localStorage.setItem(DONATE_NEXT_KEY, '0')
        setShowDonate(true)
      }
      return
    }

    // First time: show after 1 hour (3600000 ms)
    if (nextDelay === 0) nextDelay = 60 * 60 * 1000 // 1 hour

    // Show if total usage exceeds shownAt + nextDelay
    if (totalUsageMs > nextDelay && Date.now() - shownAt > nextDelay) {
      setShowDonate(true)
    }
  }

  const handleOnboardingComplete = () => {
    localStorage.setItem(ONBOARDED_KEY, 'true')
    localStorage.setItem(INTERESTS_KEY, JSON.stringify(Array.from(selected)))
    setShowOnboarding(false)

    // Send interests to Firebase
    const deviceId = localStorage.getItem('neutralwire:device-id')
    if (deviceId) {
      fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, enabled: true }),
      }).catch(() => {})
      // Store interests in Firebase
      import('@/lib/firebase-server').then(() => {
        fetch('/api/referral/track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId }),
        }).catch(() => {})
      }).catch(() => {})
    }
  }

  const toggleSector = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleDonatePress = () => {
    localStorage.setItem(DONATE_PRESSED_KEY, 'true')
    localStorage.setItem(DONATE_SHOWN_KEY, String(Date.now()))
    localStorage.setItem(DONATE_NEXT_KEY, '0')
    setShowDonate(false)
    window.open('https://ko-fi.com/neutralwire', '_blank')
  }

  const handleDonateDismiss = () => {
    const currentDelay = parseInt(localStorage.getItem(DONATE_NEXT_KEY) || '0', 10)
    const newDelay = currentDelay === 0 ? 2 * 60 * 60 * 1000 : currentDelay * 2 // double: 2h → 4h → 8h → 16h
    localStorage.setItem(DONATE_NEXT_KEY, String(newDelay))
    localStorage.setItem(DONATE_SHOWN_KEY, String(Date.now()))
    setShowDonate(false)
  }

  // ── Onboarding popup ──
  if (showOnboarding) {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
        <div className="w-full max-w-md rounded-2xl bg-background p-6 shadow-2xl">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold">Welcome to NeutralWire</h2>
            <button onClick={() => { setShowOnboarding(false); localStorage.setItem(ONBOARDED_KEY, 'true') }} className="text-muted-foreground hover:text-foreground">
              <X className="h-5 w-5" />
            </button>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">
            Pick a few topics you care about. We'll use these to personalise your news feed and notifications.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {SECTORS.map((sector) => (
              <button
                key={sector.id}
                onClick={() => toggleSector(sector.id)}
                className={`flex items-center gap-2 rounded-xl border p-3 text-sm font-medium transition-all ${
                  selected.has(sector.id)
                    ? 'border-foreground bg-foreground/5 ring-1 ring-foreground'
                    : 'border-border hover:bg-muted'
                }`}
              >
                <span className="text-lg">{sector.emoji}</span>
                {sector.label}
              </button>
            ))}
          </div>
          <Button
            onClick={handleOnboardingComplete}
            className="mt-4 w-full"
            disabled={selected.size === 0}
          >
            {selected.size === 0 ? 'Select at least one' : `Save ${selected.size} ${selected.size === 1 ? 'interest' : 'interests'}`}
          </Button>
        </div>
      </div>
    )
  }

  // ── Donation popup ──
  if (showDonate) {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
        <div className="w-full max-w-sm rounded-2xl bg-background p-6 shadow-2xl text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-r from-pink-500 to-red-500">
            <Heart className="h-7 w-7 fill-white text-white" />
          </div>
          <h2 className="mb-2 text-lg font-bold">Support NeutralWire</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            NeutralWire is built by a 15-year-old working alone, for free. If it's been useful, consider buying him a coffee. Every bit helps keep the servers running.
          </p>
          <div className="flex flex-col gap-2">
            <Button
              onClick={handleDonatePress}
              className="w-full bg-gradient-to-r from-pink-500 to-red-500 text-white hover:opacity-90"
            >
              <Heart className="mr-2 h-4 w-4 fill-white" /> Donate on Ko-fi
            </Button>
            <Button onClick={handleDonateDismiss} variant="ghost" className="w-full text-xs text-muted-foreground">
              Maybe later
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return null
}
