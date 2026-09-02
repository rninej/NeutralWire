'use client'

/**
 * analytics-gated.tsx — Vercel Web Analytics, cookie-consent gated.
 *
 * Vercel Analytics is aggregate/anonymized, but it's still a
 * "non-necessary" data flow: when the visitor chose "Reject
 * non-necessary" on the cookie banner, every event is dropped here
 * (beforeSend → null). Events also stay dropped until an explicit
 * "Accept all" — a first visit is never counted behind the user's back.
 *
 * Client component on purpose: `beforeSend` is a runtime function, which
 * can't be passed from a server layout into a client component — this
 * wrapper keeps the root layout a server component.
 */

import { Analytics } from '@vercel/analytics/react'

export function GatedAnalytics() {
  return (
    <Analytics
      beforeSend={(event) => {
        try {
          const raw = localStorage.getItem('neutralwire:cookies-choice')
          // Only send when the visitor explicitly accepted. No choice yet
          // (banner up) or rejected → drop the event.
          if (!raw || !raw.includes('"accepted"')) return null
        } catch {
          // localStorage blocked — be conservative and drop.
          return null
        }
        return event
      }}
    />
  )
}
