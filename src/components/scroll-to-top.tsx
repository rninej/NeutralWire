'use client'

/**
 * ScrollToTop — floating "scroll to top" button.
 *
 * Renders a fixed-position chevron-up button in the bottom-right corner
 * that appears once the user has scrolled past `showAfter` pixels (default
 * 500). Clicking it smoothly scrolls the page back to the top.
 *
 * Mount once near the end of the page (outside the main scroll container).
 * Uses a CSS animation class (scroll-top-enter) for the entrance so we
 * don't pay the cost of framer-motion for such a simple element.
 *
 * The button is keyboard-accessible (it's a real <button>) and has an
 * aria-label for screen readers. It's hidden from screen readers when not
 * visible (aria-hidden + tabIndex=-1) so tab navigation skips it.
 */

import * as React from 'react'
import { ChevronUp } from 'lucide-react'

interface ScrollToTopProps {
  /** Show the button after the user has scrolled this many pixels down. */
  showAfter?: number
}

export function ScrollToTop({ showAfter = 500 }: ScrollToTopProps) {
  const [visible, setVisible] = React.useState(false)

  React.useEffect(() => {
    // Avoid passive listener issues — scroll is a high-frequency event,
    // so we don't preventDefault. The listener just toggles a boolean.
    const onScroll = () => {
      setVisible(window.scrollY > showAfter)
    }
    // Initial check — in case the page loaded already scrolled (e.g. the
    // browser restored the previous scroll position).
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [showAfter])

  const handleClick = React.useCallback(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  if (!visible) return null

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label="Scroll to top"
      className="scroll-top-enter fixed bottom-4 right-4 z-40 flex h-10 w-10 items-center justify-center rounded-full bg-background/90 text-foreground shadow-lg ring-1 ring-border/60 backdrop-blur-md transition-colors hover:bg-background hover:ring-foreground/30 lg:bottom-6 lg:right-6"
    >
      <ChevronUp className="h-5 w-5" />
    </button>
  )
}
