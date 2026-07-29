'use client'

import { cn } from '@/lib/utils'

interface BiasBarProps {
  left: number
  center: number
  right: number
  showLabels?: boolean
  className?: string
}

export function BiasBar({ left, center, right, showLabels = true, className }: BiasBarProps) {
  const total = left + center + right
  const lPct = total === 0 ? 0 : (left / total) * 100
  const cPct = total === 0 ? 0 : (center / total) * 100
  const rPct = total === 0 ? 0 : (right / total) * 100

  return (
    <div className={cn('w-full', className)}>
      {/* Labels + bar combined in one row to save vertical space.
          Labels are overlaid INSIDE the bar segments. */}
      {showLabels ? (
        <div
          className="flex h-5 w-full overflow-hidden rounded-md bg-muted"
          role="img"
          aria-label={`Coverage: ${left} left, ${center} center, ${right} right`}
        >
          {lPct > 0 && (
            <div
              className="flex items-center justify-center bg-blue-500 transition-all"
              style={{ width: `${lPct}%` }}
              title={`Left: ${left}`}
            >
              {lPct > 8 && (
                <span className="text-[9px] font-bold text-white leading-none">L{left}</span>
              )}
            </div>
          )}
          {cPct > 0 && (
            <div
              className="flex items-center justify-center bg-zinc-500 transition-all"
              style={{ width: `${cPct}%` }}
              title={`Center: ${center}`}
            >
              {cPct > 8 && (
                <span className="text-[9px] font-bold text-white leading-none">C{center}</span>
              )}
            </div>
          )}
          {rPct > 0 && (
            <div
              className="flex items-center justify-center bg-red-500 transition-all"
              style={{ width: `${rPct}%` }}
              title={`Right: ${right}`}
            >
              {rPct > 8 && (
                <span className="text-[9px] font-bold text-white leading-none">R{right}</span>
              )}
            </div>
          )}
        </div>
      ) : (
        <div
          className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={`Coverage: ${left} left, ${center} center, ${right} right`}
        >
          {lPct > 0 && (
            <div
              className="bg-blue-500 transition-all"
              style={{ width: `${lPct}%` }}
              title={`Left: ${left}`}
            />
          )}
          {cPct > 0 && (
            <div
              className="bg-zinc-500 transition-all"
              style={{ width: `${cPct}%` }}
              title={`Center: ${center}`}
            />
          )}
          {rPct > 0 && (
            <div
              className="bg-red-500 transition-all"
              style={{ width: `${rPct}%` }}
              title={`Right: ${right}`}
            />
          )}
        </div>
      )}
    </div>
  )
}
