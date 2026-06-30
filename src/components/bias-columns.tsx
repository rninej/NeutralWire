'use client'

import * as React from 'react'
import { ExternalLink } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { TopicArticle, FeedArticle } from '@/lib/news-aggregator'

type Leaning = 'left' | 'center' | 'right'

interface BiasColumnsProps {
  topics: TopicArticle[]
}

const COLS: { leaning: Leaning; label: string; accent: string; head: string }[] = [
  { leaning: 'left', label: 'Left', accent: 'border-t-blue-500', head: 'text-blue-600 dark:text-blue-400' },
  { leaning: 'center', label: 'Center', accent: 'border-t-zinc-500', head: 'text-zinc-600 dark:text-zinc-400' },
  { leaning: 'right', label: 'Right', accent: 'border-t-red-500', head: 'text-red-600 dark:text-red-400' },
]

function collectByLeaning(topics: TopicArticle[]): Record<Leaning, FeedArticle[]> {
  const out: Record<Leaning, FeedArticle[]> = { left: [], center: [], right: [] }
  const seen = new Set<string>()
  for (const t of topics) {
    for (const a of t.articles) {
      const k = a.sourceId + '|' + a.link
      if (seen.has(k)) continue
      seen.add(k)
      out[a.leaning].push(a)
    }
  }
  // sort by recency
  for (const k of Object.keys(out) as Leaning[]) {
    out[k].sort((a, b) => b.iso - a.iso)
  }
  return out
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function BiasColumns({ topics }: BiasColumnsProps) {
  const grouped = React.useMemo(() => collectByLeaning(topics), [topics])

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {COLS.map((col) => {
        const items = grouped[col.leaning].slice(0, 12)
        return (
          <Card
            key={col.leaning}
            className={cn('gap-0 overflow-hidden border-t-4 py-0', col.accent)}
          >
            <div className="flex items-center justify-between px-4 py-3">
              <h3 className={cn('text-sm font-bold uppercase tracking-wide', col.head)}>
                {col.label}
              </h3>
              <span className="text-[11px] text-muted-foreground">
                {items.length} stories
              </span>
            </div>
            <ul className="divide-y divide-border">
              {items.length === 0 && (
                <li className="px-4 py-6 text-center text-xs text-muted-foreground">
                  No stories in this column right now.
                </li>
              )}
              {items.map((a) => (
                <li key={a.id}>
                  <a
                    href={a.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block px-4 py-2.5 hover:bg-muted/50 transition-colors"
                  >
                    <div className="line-clamp-2 text-xs font-medium leading-snug">
                      {a.title}
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
                      <span>{a.sourceName}</span>
                      <span className="flex items-center gap-1">
                        {timeAgo(a.iso)}
                        <ExternalLink className="h-2.5 w-2.5" />
                      </span>
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          </Card>
        )
      })}
    </div>
  )
}
