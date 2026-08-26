'use client'

import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

interface BiasBarProps {
  left: number
  center: number
  right: number
  showLabels?: boolean
  className?: string
}

// Shared animation for the segment width growth — smooth, slightly slow
// so the user can see the spectrum "fill in" on mount.
const SEGMENT_TRANSITION = { duration: 0.6, ease: 'easeOut' as const }

export function BiasBar({ left, center, right, showLabels = true, className }: BiasBarProps) {
  const total = left + center + right
  const lPct = total === 0 ? 0 : Math.round((left / total) * 100)
  const cPct = total === 0 ? 0 : Math.round((center / total) * 100)
  const rPct = total === 0 ? 0 : Math.round((right / total) * 100)

  // Segment descriptors — first/last VISIBLE segments get pill-rounded
  // outer ends (the bar itself no longer clips, so the rounding has to
  // live on the segments).
  const segs = [
    { pct: lPct, count: left, fill: 'bg-blue-500', title: `Left: ${lPct}% (${left} sources)` },
    { pct: cPct, count: center, fill: 'bg-zinc-500', title: `Center: ${cPct}% (${center} sources)` },
    { pct: rPct, count: right, fill: 'bg-red-500', title: `Right: ${rPct}% (${right} sources)` },
  ]
  const firstIdx = segs.findIndex((s) => s.pct > 0)
  const lastIdx = segs.reduce((acc, s, i) => (s.pct > 0 ? i : acc), -1)

  return (
    <div className={cn('w-full', className)}>
      {/* Labels overlaid INSIDE the thin bar to save vertical space.
          Shows PERCENTAGES (e.g. L42%) for every non-zero segment.

          FIX (labels used to vanish on narrow segments): the bar no
          longer uses overflow-hidden — that clipped the % labels of any
          segment under ~8% (e.g. Left 1/14 = 7% was invisible). Instead
          the outer ends of the first/last segments are pill-rounded
          themselves, and each label simply centers over its segment and
          is allowed to bleed a few px into neighbours when the segment
          is narrow. End segments under 6% nudge their label inward so it
          never spills outside the bar. Every percentage is now ALWAYS
          visible — on cards and in the article detail view. */}
      {showLabels ? (
        <div
          className="flex h-3.5 w-full rounded-full bg-muted"
          role="img"
          aria-label={`Coverage: ${lPct}% left, ${cPct}% center, ${rPct}% right`}
        >
          {segs.map((s, i) => {
            if (s.pct <= 0) return null
            const isFirst = i === firstIdx
            const isLast = i === lastIdx
            return (
              <motion.div
                key={i}
                className={cn(
                  'relative flex items-center justify-center',
                  s.fill,
                  isFirst && 'rounded-l-full',
                  isLast && 'rounded-r-full',
                  // Narrow end segments: nudge the label inward instead of
                  // letting it bleed past the outer edge of the bar.
                  isFirst && s.pct < 6 && 'justify-start pl-[3px]',
                  isLast && s.pct < 6 && 'justify-end pr-[3px]',
                )}
                initial={{ width: 0 }}
                animate={{ width: `${s.pct}%` }}
                transition={SEGMENT_TRANSITION}
                title={s.title}
              >
                <span className="pointer-events-none whitespace-nowrap text-[8px] font-bold leading-none text-white">
                  {s.pct}%
                </span>
              </motion.div>
            )
          })}
        </div>
      ) : (
        <div
          className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={`Coverage: ${lPct}% left, ${cPct}% center, ${rPct}% right`}
        >
          {segs.map((s, i) => {
            if (s.pct <= 0) return null
            return (
              <motion.div
                key={i}
                className={s.fill}
                initial={{ width: 0 }}
                animate={{ width: `${s.pct}%` }}
                transition={SEGMENT_TRANSITION}
                title={s.title}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
