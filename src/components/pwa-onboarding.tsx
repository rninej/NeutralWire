'use client'

import * as React from 'react'
import { X, Heart } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  SECTORS,
  setInterestsLocal,
  syncInterestsWithFirebase,
} from '@/lib/user-interests'
import { getDeviceId } from '@/lib/referral'

const ONBOARDED_KEY = 'neutralwire:onboarded'
const ARTICLES_OPENED_KEY = 'neutralwire:articles-opened'
const DONATE_SHOWN_KEY = 'neutralwire:donate-shown-at'
const DONATE_NEXT_KEY = 'neutralwire:donate-next-threshold'
const DONATE_PRESSED_KEY = 'neutralwire:donate-pressed'

// Donation popup thresholds (in number of articles opened).
// First popup after 10 articles, then doubles: 20 → 40 → 80 → 160...
const INITIAL_THRESHOLD = 10

/**
 * PWA Onboarding + Donation Trigger.
 *
 * Shows on first launch in the installed PWA:
 * 1. Interest selection popup (pick sectors → saved to localStorage + Firebase)
 * 2. Tracks how many news articles the user opens
 * 3. After 10 articles opened → donation popup (Ko-fi)
 * 4. If dismissed: next popup after 2x the threshold (20 → 40 → 80 → 160)
 * 5. If pressed (donated): next popup after 3 months
 *
 * The article-open count is incremented by listening to the
 * 'neutralwire:topic-opened' custom event (dispatched by TopicDetail).
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
      const saved = localStorage.getItem('neutralwire:interests')
      if (saved) setSelected(new Set(JSON.parse(saved)))
    } catch { /* ignore */ }

    // ── Donation popup check ──
    // Triggered when the user has opened enough news articles.
    const checkDonationPopup = (articlesOpened: number) => {
      const pressed = localStorage.getItem(DONATE_PRESSED_KEY) === 'true'
      const shownAt = parseInt(localStorage.getItem(DONATE_SHOWN_KEY) || '0', 10)
      let nextThreshold = parseInt(localStorage.getItem(DONATE_NEXT_KEY) || '0', 10)

      // If pressed (donated), wait 3 months before showing again
      if (pressed) {
        const threeMonths = 90 * 24 * 60 * 60 * 1000
        if (Date.now() - shownAt > threeMonths) {
          localStorage.setItem(DONATE_PRESSED_KEY, 'false')
          localStorage.setItem(DONATE_NEXT_KEY, '0')
          setShowDonate(true)
        }
        return
      }

      // First time: show after 10 articles
      if (nextThreshold === 0) nextThreshold = INITIAL_THRESHOLD

      // Show if articles opened exceeds the threshold
      if (articlesOpened >= nextThreshold) {
        setShowDonate(true)
      }
    }

    // ── Article-open counter ──
    // Incremented every time the user opens a news article (TopicDetail).
    const handleTopicOpened = () => {
      let count = parseInt(localStorage.getItem(ARTICLES_OPENED_KEY) || '0', 10)
      count += 1
      localStorage.setItem(ARTICLES_OPENED_KEY, String(count))
      checkDonationPopup(count)
    }

    window.addEventListener('neutralwire:topic-opened', handleTopicOpened)

    return () => {
      window.removeEventListener('neutralwire:topic-opened', handleTopicOpened)
    }
  }, [])

  const handleOnboardingComplete = async () => {
    const sectorsArray = Array.from(selected)
    localStorage.setItem(ONBOARDED_KEY, 'true')
    setInterestsLocal(sectorsArray)
    setShowOnboarding(false)

    const deviceId = typeof window !== 'undefined' ? getDeviceId() : ''
    if (deviceId) {
      syncInterestsWithFirebase(deviceId, sectorsArray).catch(() => {})
    }

    window.dispatchEvent(new CustomEvent('neutralwire:interests-changed'))
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
    const currentThreshold = parseInt(localStorage.getItem(DONATE_NEXT_KEY) || '0', 10)
    // Double the threshold: 10 → 20 → 40 → 80 → 160...
    const newThreshold = currentThreshold === 0 ? INITIAL_THRESHOLD * 2 : currentThreshold * 2
    localStorage.setItem(DONATE_NEXT_KEY, String(newThreshold))
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
