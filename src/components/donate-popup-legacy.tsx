'use client'

import * as React from 'react'
import { Heart } from 'lucide-react'
import { motion } from 'framer-motion'
import { Button } from '@/components/ui/button'

const ARTICLES_OPENED_KEY = 'neutralwire:articles-opened'
const DONATE_SHOWN_KEY = 'neutralwire:donate-shown-at'
const DONATE_NEXT_KEY = 'neutralwire:donate-next-threshold'
const DONATE_PRESSED_KEY = 'neutralwire:donate-pressed'
const INITIAL_THRESHOLD = 10

/**
 * DonatePopupLegacy — the ORIGINAL "please donate" popup from inside the
 * installed PWA, restored verbatim from before the behavioral rewrite
 * (it used to live inside pwa-onboarding.tsx). Only rendered when the
 * /debug popup-system switch is set to 'original'.
 *
 * Classic behavior, preserved exactly:
 *  - PWA (standalone) only — it never appeared on the website.
 *  - Counts stories opened; at 10 the popup appears.
 *  - "Maybe later" doubles the next threshold (10 → 20 → 40 → …).
 *  - Pressing "Donate on Ko-fi" silences it for 90 days.
 *  - It ALSO maintained the articles-opened counter (which the smart
 *    install sheet re-uses as a returning-visitor signal) — kept intact
 *    here so 'original' mode is fully self-contained.
 *
 * In 'smart' / 'smart-firstvisit' modes this component is not mounted at
 * all; milestone-celebration.tsx owns the in-PWA moment instead.
 */
export function DonatePopupLegacy() {
  const [showDonate, setShowDonate] = React.useState(false)

  React.useEffect(() => {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone ===
        true
    if (!isStandalone) return

    // Donation popup logic
    const checkDonationPopup = (articlesOpened: number) => {
      const pressed = localStorage.getItem(DONATE_PRESSED_KEY) === 'true'
      const shownAt = parseInt(localStorage.getItem(DONATE_SHOWN_KEY) || '0', 10)
      let nextThreshold = parseInt(localStorage.getItem(DONATE_NEXT_KEY) || '0', 10)
      if (pressed) {
        const threeMonths = 90 * 24 * 60 * 60 * 1000
        if (Date.now() - shownAt > threeMonths) {
          localStorage.setItem(DONATE_PRESSED_KEY, 'false')
          localStorage.setItem(DONATE_NEXT_KEY, '0')
          setShowDonate(true)
        }
        return
      }
      if (nextThreshold === 0) nextThreshold = INITIAL_THRESHOLD
      if (articlesOpened >= nextThreshold) {
        setShowDonate(true)
      }
    }

    const handleTopicOpened = () => {
      let count = parseInt(localStorage.getItem(ARTICLES_OPENED_KEY) || '0', 10)
      count += 1
      localStorage.setItem(ARTICLES_OPENED_KEY, String(count))
      checkDonationPopup(count)
    }

    window.addEventListener('neutralwire:topic-opened', handleTopicOpened)
    return () => window.removeEventListener('neutralwire:topic-opened', handleTopicOpened)
  }, [])

  const handleDonatePress = () => {
    localStorage.setItem(DONATE_PRESSED_KEY, 'true')
    localStorage.setItem(DONATE_SHOWN_KEY, String(Date.now()))
    localStorage.setItem(DONATE_NEXT_KEY, '0')
    setShowDonate(false)
    window.open('https://ko-fi.com/neutralwire', '_blank')
  }

  const handleDonateDismiss = () => {
    const currentThreshold = parseInt(localStorage.getItem(DONATE_NEXT_KEY) || '0', 10)
    const newThreshold = currentThreshold === 0 ? INITIAL_THRESHOLD * 2 : currentThreshold * 2
    localStorage.setItem(DONATE_NEXT_KEY, String(newThreshold))
    localStorage.setItem(DONATE_SHOWN_KEY, String(Date.now()))
    setShowDonate(false)
  }

  if (!showDonate) return null

  // ── Donation popup ──
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-sm rounded-2xl bg-background p-6 shadow-2xl text-center"
      >
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
      </motion.div>
    </div>
  )
}
