'use client'

/**
 * cookie-consent.tsx — the cookie banner for FIRST-TIME visitors.
 *
 * Ordering guarantee: this is the FIRST popup a new visitor ever sees.
 * It renders at ~600ms (after the launch splash has fully retired at
 * ~500ms) and every other first-run popup — the PWA install prompt,
 * the onboarding quiz, the language picker — is gated on the visitor
 * having made a choice here (see pwa-install-prompt.tsx /
 * pwa-onboarding.tsx), so nothing can ever jump in front of it.
 *
 * Exactly TWO options (by design, no dismiss-X, no "later"):
 *   • Accept all           → analytics + telemetry enabled
 *   • Reject non-necessary → analytics + telemetry stay off
 *
 * The banner sits ABOVE the install prompt's z-index, blocks nothing
 * else (the page behind stays fully usable) and disappears the moment
 * a choice is made.
 */

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Cookie } from 'lucide-react'
import {
  getCookieChoice,
  setCookieChoice,
} from '@/lib/cookie-consent'

// Shown after the launch splash is fully gone (~500ms) — 700ms feels
// intentional rather than abrupt, still well before the install prompt
// (which now WAITS for this decision).
const SHOW_DELAY_MS = 700

export function CookieConsent() {
  const [visible, setVisible] = React.useState(false)

  React.useEffect(() => {
    // Returning visitors: already chose — never show again.
    if (getCookieChoice() !== null) return
    const t = setTimeout(() => setVisible(true), SHOW_DELAY_MS)
    return () => clearTimeout(t)
  }, [])

  const choose = (choice: 'accepted' | 'rejected') => {
    setCookieChoice(choice) // persists + dispatches the event
    setVisible(false)
  }

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="cookie-consent"
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 28 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          role="dialog"
          aria-modal="false"
          aria-label="Cookie consent"
          // z-[80] — above the install banner (60) and its modal (70)
          // so it can never be covered by the popup it must precede.
          className="fixed bottom-0 left-0 right-0 z-[80] flex justify-center px-3 pb-3"
        >
          <div className="w-full max-w-md rounded-2xl border bg-background p-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
                <Cookie className="h-4.5 w-4.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold">A quick word on cookies</div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  NeutralWire stores a few bits of data on your device — your
                  settings, and anonymous stats that help us understand how the
                  app is used. We never sell or share it.{' '}
                  <a
                    href="/privacy"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold underline underline-offset-2 hover:text-foreground"
                  >
                    Privacy policy
                  </a>
                </p>

                {/* Exactly two options — nothing else. */}
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => choose('accepted')}
                    className="h-9 flex-1 rounded-lg bg-foreground text-xs font-semibold text-background transition-opacity hover:opacity-90 active:scale-[.98]"
                  >
                    Accept all
                  </button>
                  <button
                    type="button"
                    onClick={() => choose('rejected')}
                    className="h-9 flex-1 rounded-lg border border-border bg-transparent text-xs font-semibold transition-colors hover:bg-muted/50 active:scale-[.98]"
                  >
                    Reject non-necessary
                  </button>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
