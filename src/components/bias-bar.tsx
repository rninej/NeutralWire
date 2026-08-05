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
  const lPct = total === 0 ? 0 : (left / total) * 100
  const cPct = total === 0 ? 0 : (center / total) * 100
  const rPct = total === 0 ? 0 : (right / total) * 100

  return (
    <div className={cn('w-full', className)}>
      {/* Labels overlaid INSIDE the thin bar to save vertical space. */}
      {showLabels ? (
        <div
          className="flex h-3.5 w-full overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={`Coverage: ${left} left, ${center} center, ${right} right`}
        >
          {lPct > 0 && (
            <motion.div
              className="flex items-center justify-center bg-blue-500"
              initial={{ width: 0 }}
              animate={{ width: `${lPct}%` }}
              transition={SEGMENT_TRANSITION}
              title={`Left: ${left}`}
            >
              {lPct > 10 && (
                <span className="text-[8px] font-bold text-white leading-none">L{left}</span>
              )}
            </motion.div>
          )}
          {cPct > 0 && (
            <motion.div
              className="flex items-center justify-center bg-zinc-500"
              initial={{ width: 0 }}
              animate={{ width: `${cPct}%` }}
              transition={SEGMENT_TRANSITION}
              title={`Center: ${center}`}
            >
              {cPct > 10 && (
                <span className="text-[8px] font-bold text-white leading-none">C{center}</span>
              )}
            </motion.div>
          )}
          {rPct > 0 && (
            <motion.div
              className="flex items-center justify-center bg-red-500"
              initial={{ width: 0 }}
              animate={{ width: `${rPct}%` }}
              transition={SEGMENT_TRANSITION}
              title={`Right: ${right}`}
            >
              {rPct > 10 && (
                <span className="text-[8px] font-bold text-white leading-none">R{right}</span>
              )}
            </motion.div>
          )}
        </div>
      ) : (
        <div
          className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={`Coverage: ${left} left, ${center} center, ${right} right`}
        >
          {lPct > 0 && (
            <motion.div
              className="bg-blue-500"
              initial={{ width: 0 }}
              animate={{ width: `${lPct}%` }}
              transition={SEGMENT_TRANSITION}
              title={`Left: ${left}`}
            />
          )}
          {cPct > 0 && (
            <motion.div
              className="bg-zinc-500"
              initial={{ width: 0 }}
              animate={{ width: `${cPct}%` }}
              transition={SEGMENT_TRANSITION}
              title={`Center: ${center}`}
            />
          )}
          {rPct > 0 && (
            <motion.div
              className="bg-red-500"
              initial={{ width: 0 }}
              animate={{ width: `${rPct}%` }}
              transition={SEGMENT_TRANSITION}
              title={`Right: ${right}`}
            />
          )}
        </div>
      )}
    </div>
  )
}
