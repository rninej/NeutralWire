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

  return (
    <div className={cn('w-full', className)}>
      {/* Labels overlaid INSIDE the thin bar to save vertical space.
          Shows PERCENTAGES (e.g. L42%) instead of raw source counts. */}
      {showLabels ? (
        <div
          className="flex h-3.5 w-full overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={`Coverage: ${lPct}% left, ${cPct}% center, ${rPct}% right`}
        >
          {lPct > 0 && (
            <motion.div
              className="flex items-center justify-center bg-blue-500"
              initial={{ width: 0 }}
              animate={{ width: `${lPct}%` }}
              transition={SEGMENT_TRANSITION}
              title={`Left: ${lPct}% (${left} sources)`}
            >
              {lPct > 10 && (
                <span className="text-[8px] font-bold text-white leading-none">L{lPct}%</span>
              )}
            </motion.div>
          )}
          {cPct > 0 && (
            <motion.div
              className="flex items-center justify-center bg-zinc-500"
              initial={{ width: 0 }}
              animate={{ width: `${cPct}%` }}
              transition={SEGMENT_TRANSITION}
              title={`Center: ${cPct}% (${center} sources)`}
            >
              {cPct > 10 && (
                <span className="text-[8px] font-bold text-white leading-none">C{cPct}%</span>
              )}
            </motion.div>
          )}
          {rPct > 0 && (
            <motion.div
              className="flex items-center justify-center bg-red-500"
              initial={{ width: 0 }}
              animate={{ width: `${rPct}%` }}
              transition={SEGMENT_TRANSITION}
              title={`Right: ${rPct}% (${right} sources)`}
            >
              {rPct > 10 && (
                <span className="text-[8px] font-bold text-white leading-none">R{rPct}%</span>
              )}
            </motion.div>
          )}
        </div>
      ) : (
        <div
          className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={`Coverage: ${lPct}% left, ${cPct}% center, ${rPct}% right`}
        >
          {lPct > 0 && (
            <motion.div
              className="bg-blue-500"
              initial={{ width: 0 }}
              animate={{ width: `${lPct}%` }}
              transition={SEGMENT_TRANSITION}
              title={`Left: ${lPct}% (${left} sources)`}
            />
          )}
          {cPct > 0 && (
            <motion.div
              className="bg-zinc-500"
              initial={{ width: 0 }}
              animate={{ width: `${cPct}%` }}
              transition={SEGMENT_TRANSITION}
              title={`Center: ${cPct}% (${center} sources)`}
            />
          )}
          {rPct > 0 && (
            <motion.div
              className="bg-red-500"
              initial={{ width: 0 }}
              animate={{ width: `${rPct}%` }}
              transition={SEGMENT_TRANSITION}
              title={`Right: ${rPct}% (${right} sources)`}
            />
          )}
        </div>
      )}
    </div>
  )
}
