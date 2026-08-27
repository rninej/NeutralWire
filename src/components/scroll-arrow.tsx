'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * ScrollArrowButton — an "there's more → " affordance for horizontally
 * scrolling nav rows. Used by the 'tabsarrow' and 'cardsarrow' subtopic
 * header variants, where edge fades alone weren't an obvious enough hint
 * that the topic row scrolls.
 *
 * Behaviour:
 *  - More content off-screen to the right → right chevron; click scrolls
 *    the row ~80% of its visible width.
 *  - Row is scrolled to the END → chevron flips left; click rewinds to
 *    the very start (fast way back to Relevant).
 *  - Row doesn't overflow at all (wide desktop, everything fits) → the
 *    button goes invisible but KEEPS ITS WIDTH so the nav row never
 *    re-flows when the arrow appears/disappears on resize.
 *  - A gentle 3px nudge animation repeats every few seconds to draw the
 *    eye without being annoying.
 *
 * The button always sits AFTER the scroll row (flex sibling), never
 * inside it, so it can't be scrolled away.
 */
export function ScrollArrowButton({
  targetRef,
  canLeft,
  canRight,
  className,
}: {
  /** Ref of the horizontally-scrollable row this arrow controls. */
  targetRef: React.RefObject<HTMLDivElement | null>
  canLeft: boolean
  canRight: boolean
  className?: string
}) {
  const atEnd = !canRight && canLeft
  const visible = canLeft || canRight

  const handleClick = React.useCallback(() => {
    const el = targetRef.current
    if (!el) return
    if (atEnd) {
      // Already at the end → rewind to the first topics.
      el.scrollTo({ left: 0, behavior: 'smooth' })
    } else {
      el.scrollBy({ left: el.clientWidth * 0.8, behavior: 'smooth' })
    }
  }, [atEnd, targetRef])

  return (
    <motion.button
      type="button"
      onClick={handleClick}
      aria-label={atEnd ? 'Scroll back to the first topics' : 'Scroll to more topics'}
      title={atEnd ? 'Back to start' : 'More topics'}
      // Idle nudge — a small 3px sway in the scroll direction every ~2.8s,
      // the standard "psst, this scrolls" cue. Stops when hidden.
      animate={visible ? { x: [0, atEnd ? -3 : 3, 0] } : { x: 0 }}
      transition={
        visible
          ? { duration: 1.1, repeat: Infinity, repeatDelay: 1.7, ease: 'easeInOut' }
          : { duration: 0.2 }
      }
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted/60 text-foreground/80 shadow-sm transition-opacity duration-200 hover:bg-muted hover:text-foreground active:scale-95',
        !visible && 'pointer-events-none opacity-0',
        className,
      )}
    >
      {atEnd ? (
        <ChevronLeft className="h-4 w-4" />
      ) : (
        <ChevronRight className="h-4 w-4" />
      )}
    </motion.button>
  )
}
