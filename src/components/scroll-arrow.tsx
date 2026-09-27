'use client'

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * ScrollHint — a small FLOATING arrow symbol layered over the right edge
 * of a horizontally-scrollable nav row. Used by the 'tabsarrow' and
 * 'cardsarrow' subtopic header variants.
 *
 * This is an INDICATOR, not a control:
 *  - It is not a button — no onClick, no aria-role, `pointer-events-none`
 *    so taps pass straight through to the pill underneath it.
 *  - Its only job is to say "you can swipe this row →".
 *  - It shows while there is content off-screen to the right (canRight)
 *    and gently fades out once the user reaches the end — at that point
 *    they've discovered the swipe, so the cue is no longer needed.
 *
 * It floats ABOVE the row's right edge-fade gradient on a tiny frosted
 * chip (backdrop-blur + border) so it stays legible over any pill text
 * it overlaps, and it nudges 3px in the swipe direction every ~2.8s —
 * the standard "psst, this scrolls" animation.
 *
 * Because it's absolutely positioned it takes up NO layout space: the
 * nav row never re-flows when the hint appears or disappears. Vertical
 * centring uses top-[calc(50%-14px)] (not a translate class) so
 * framer-motion's x-animation can't clobber it.
 */
export function ScrollHint({
  canRight,
  className,
}: {
  /** True while the row has content off-screen to the right. */
  canRight: boolean
  className?: string
}) {
  return (
    <AnimatePresence>
      {canRight && (
        <motion.div
          aria-hidden="true"
          initial={{ opacity: 0, x: 6 }}
          animate={{ opacity: 1, x: [0, 3, 0] }}
          // exit carries its own transition — the looping x nudge must
          // NOT apply to the exit (it would repeat forever and the
          // element would never unmount).
          exit={{ opacity: 0, x: 6, transition: { duration: 0.18 } }}
          transition={{
            x: { duration: 1.1, repeat: Infinity, repeatDelay: 1.7, ease: 'easeInOut' },
            opacity: { duration: 0.2 },
          }}
          // pointer-events-none — purely decorative; never intercepts taps
          // on the pill sliding underneath it.
          className={cn(
            'pointer-events-none absolute right-0.5 top-[calc(50%-14px)] z-10 flex h-7 w-7 items-center justify-center rounded-full border border-border/70 bg-background/80 text-foreground/70 shadow-sm backdrop-blur-sm',
            className,
          )}
        >
          <ChevronRight className="h-4 w-4" strokeWidth={2.75} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
