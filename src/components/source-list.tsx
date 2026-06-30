'use client'

import { NEWS_SOURCES, LEANING_META, type Leaning } from '@/lib/news-sources'
import { cn } from '@/lib/utils'

export function SourceList() {
  const groups: Leaning[] = ['left', 'center', 'right']

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {groups.map((g) => {
        const sources = NEWS_SOURCES.filter((s) => s.leaning === g)
        const meta = LEANING_META[g]
        return (
          <div
            key={g}
            className="rounded-lg border bg-card p-3"
          >
            <div className="mb-2 flex items-center gap-2">
              <span
                className={cn('h-2.5 w-2.5 rounded-full')}
                style={{ background: meta.color }}
              />
              <span className="text-xs font-semibold uppercase tracking-wide">
                {meta.label}
              </span>
              <span className="ml-auto text-[10px] text-muted-foreground">
                {sources.length} sources
              </span>
            </div>
            <ul className="space-y-1">
              {sources.map((s) => (
                <li key={s.id}>
                  <a
                    href={s.homepage}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded px-1.5 py-1 text-xs hover:bg-muted/50"
                  >
                    <span className="font-medium">{s.name}</span>
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      · {s.country}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
