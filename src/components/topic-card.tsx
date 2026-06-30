'use client'

import * as React from 'react'
import { Clock, ExternalLink, Globe, ImageIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { BiasBar } from '@/components/bias-bar'
import type { TopicArticle } from '@/lib/news-aggregator'

interface TopicCardProps {
  topic: TopicArticle
  variant?: 'default' | 'featured' | 'compact'
  defaultOpen?: boolean
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

const LEANING_BADGE: Record<string, { label: string; cls: string }> = {
  left: { label: 'Left', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300' },
  center: { label: 'Center', cls: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300' },
  right: { label: 'Right', cls: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' },
}

/**
 * Picks the best available image from a topic's articles.
 * Falls back to the topic's own imageUrl, then to any article image.
 */
function pickImage(topic: TopicArticle): string | null {
  if (topic.imageUrl) return topic.imageUrl
  for (const a of topic.articles) {
    if (a.imageUrl) return a.imageUrl
  }
  return null
}

export function TopicCard({ topic, variant = 'default', defaultOpen = false }: TopicCardProps) {
  const [open, setOpen] = React.useState(defaultOpen || variant === 'featured')
  const [imgError, setImgError] = React.useState(false)

  const total = topic.leanLeft + topic.leanCenter + topic.leanRight
  const imageUrl = pickImage(topic)
  const showImage = imageUrl && !imgError

  return (
    <Card
      className={cn(
        'overflow-hidden p-0 gap-0 flex flex-col',
        variant === 'featured' && 'md:col-span-2',
      )}
    >
      {/* Header: title + meta (ABOVE the image) */}
      <div className="flex flex-col gap-2 p-4 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="text-[10px]">
            {topic.coverage} {topic.coverage === 1 ? 'source' : 'sources'}
          </Badge>
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            {timeAgo(topic.latestSeen)}
          </span>
        </div>
        <h3
          className={cn(
            'font-semibold leading-snug',
            variant === 'featured' ? 'text-lg md:text-xl' : 'text-base',
            variant === 'compact' && 'text-sm',
          )}
        >
          {topic.title}
        </h3>
      </div>

      {/* Image (every card, if available) */}
      {showImage ? (
        <div
          className={cn(
            'relative w-full overflow-hidden bg-muted',
            variant === 'featured' ? 'aspect-[16/9]' : 'aspect-[16/10]',
          )}
        >
          <img
            src={imageUrl || undefined}
            alt=""
            className="h-full w-full object-cover"
            onError={() => setImgError(true)}
          />
        </div>
      ) : (
        <div
          className={cn(
            'flex w-full items-center justify-center bg-muted/40 text-muted-foreground/50',
            variant === 'featured' ? 'aspect-[16/9]' : 'aspect-[16/10]',
          )}
        >
          <ImageIcon className="h-8 w-8" />
        </div>
      )}

      {/* Description (BELOW the image) */}
      {topic.summary && variant !== 'compact' && (
        <div className="px-4 pt-3">
          <p className="text-sm text-muted-foreground line-clamp-3">{topic.summary}</p>
        </div>
      )}

      {/* Bias bar + meta (BELOW the description) */}
      <div className="mt-auto flex flex-col gap-3 p-4 pt-3">
        <BiasBar left={topic.leanLeft} center={topic.leanCenter} right={topic.leanRight} />

        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            {total} {total === 1 ? 'article' : 'articles'} across the spectrum
          </span>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-xs font-medium text-foreground underline-offset-2 hover:underline"
          >
            {open ? 'Hide' : 'View'} sources
          </button>
        </div>

        {open && (
          <ul className="mt-1 divide-y divide-border rounded-md border">
            {topic.articles.slice(0, 12).map((a) => {
              const lean = LEANING_BADGE[a.leaning]
              return (
                <li key={a.id}>
                  <a
                    href={a.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-start gap-2 px-3 py-2 hover:bg-muted/50 transition-colors"
                  >
                    <span
                      className={cn(
                        'mt-0.5 inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase',
                        lean.cls,
                      )}
                    >
                      {lean.label}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-2 text-xs font-medium leading-snug">
                        {a.title}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Globe className="h-2.5 w-2.5" />
                        {a.sourceName}
                        <span className="opacity-50">·</span>
                        {a.country}
                        <ExternalLink className="ml-auto h-2.5 w-2.5" />
                      </div>
                    </div>
                  </a>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Card>
  )
}
