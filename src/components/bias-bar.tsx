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
      {showLabels && (
        <div className="mt-1 flex justify-between text-[10px] font-medium text-muted-foreground">
          <span className="text-blue-600 dark:text-blue-400">L {left}</span>
          <span className="text-zinc-500">C {center}</span>
          <span className="text-red-600 dark:text-red-400">R {right}</span>
        </div>
      )}
    </div>
  )
}
