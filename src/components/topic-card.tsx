'use client'

import * as React from 'react'
import { Clock, ExternalLink, Globe } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { BiasBar } from '@/components/bias-bar'
import type { TopicArticle } from '@/lib/news-aggregator'

interface TopicCardProps {
  topic: TopicArticle
  variant?: 'default' | 'featured' | 'compact' | 'hero' | 'mini'
  defaultOpen?: boolean
  onOpenDetail?: (topic: TopicArticle) => void
}

/**
 * Format a timestamp as a fixed date/time string.
 * Shows '24 Jul, 14:30' — doesn't change between renders.
 */
function formatTime(ms: number): string {
  const d = new Date(ms)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const date = d.getDate()
  const month = months[d.getMonth()]
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${date} ${month}, ${hh}:${mm}`
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

/**
 * Wraps an image URL with the /api/img proxy.
 * Many news sites block direct browser loading via referrer/CORS policies,
 * so we proxy through our server which fetches the image server-side.
 */
function proxyImage(url: string): string {
  return `/api/img?url=${encodeURIComponent(url)}`
}

export function TopicCard({ topic, variant = 'default', defaultOpen = false, onOpenDetail }: TopicCardProps) {
  // Sources are HIDDEN by default on ALL cards (including the featured
  // first card). Users tap "View sources" to expand. Previously the featured
  // card auto-opened its source list, which made the first news story look
  // different from the rest.
  const [open, setOpen] = React.useState(defaultOpen)
  const imageUrl = pickImage(topic)
  // Key the imgError state to the imageUrl so it auto-resets when the image changes.
  // This avoids stale error state from a previous render.
  const [imgErrorMap, setImgErrorMap] = React.useState<Record<string, boolean>>({})
  const imgError = imgErrorMap[imageUrl || ''] || false
  // Only render time after mount — formatTime() is timezone-dependent and
  // would cause hydration mismatch (server uses UTC, client uses local TZ).
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

  const total = topic.leanLeft + topic.leanCenter + topic.leanRight
  const showImage = imageUrl && !imgError

  const handleCardClick = (e: React.MouseEvent) => {
    // Don't open detail if the user clicked a link or button inside the card.
    const target = e.target as HTMLElement
    if (target.closest('a, button')) return
    onOpenDetail?.(topic)
  }

  // ── MINI variant: compact horizontal card (thumbnail left, title right) ──
  // Used in dense lists where 4+ stories should be visible at once on mobile.
  // Includes a compact bias bar so every card shows the red/blue/grey spectrum.
  if (variant === 'mini') {
    return (
      <Card
        className={cn(
          'overflow-hidden p-0 gap-0 flex flex-row items-stretch',
          onOpenDetail && 'cursor-pointer hover:ring-2 hover:ring-foreground/20 transition-all',
        )}
        onClick={handleCardClick}
      >
        {showImage && (
          <div className="relative w-24 h-24 shrink-0 overflow-hidden bg-muted">
            <img
              src={proxyImage(imageUrl!)}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
              onError={() => setImgErrorMap((m) => ({ ...m, [imageUrl!]: true }))}
            />
          </div>
        )}
        <div className="flex flex-col gap-1 p-2.5 flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" className="text-[9px] px-1.5 py-0">
              {topic.coverage}src
            </Badge>
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">
              {mounted ? formatTime(topic.latestSeen) : ''}
            </span>
          </div>
          <h3 className="font-semibold text-xs leading-tight line-clamp-3">
            {topic.title}
          </h3>
          {/* Compact bias bar — every card shows the red/blue/grey spectrum */}
          <div className="mt-auto pt-1">
            <BiasBar left={topic.leanLeft} center={topic.leanCenter} right={topic.leanRight} />
          </div>
        </div>
      </Card>
    )
  }

  // ── HERO variant: large card with image on TOP, big title below ──
  // Used for the top story in each section. Full-width on mobile.
  const isHero = variant === 'hero'

  return (
    <Card
      className={cn(
        'overflow-hidden p-0 gap-0 flex flex-col',
        onOpenDetail && 'cursor-pointer hover:ring-2 hover:ring-foreground/20 transition-all',
      )}
      onClick={handleCardClick}
    >
      {/* Image (hero: on top, compact 16/10 so the card isn't too tall;
          default: below header) */}
      {showImage && isHero && (
        <div className="relative w-full overflow-hidden bg-muted aspect-[16/10] lg:aspect-[16/9]">
          <img
            src={proxyImage(imageUrl!)}
            alt=""
            loading={variant === 'featured' || isHero ? 'eager' : 'lazy'}
            // @ts-expect-error — fetchPriority is a valid HTML attr but not in TS DOM types yet
            fetchpriority={variant === 'featured' || isHero ? 'high' : 'low'}
            className="h-full w-full object-cover"
            onError={() => setImgErrorMap((m) => ({ ...m, [imageUrl!]: true }))}
          />
        </div>
      )}

      {/* Header: title + meta */}
      <div className={cn('flex flex-col gap-2', isHero ? 'p-4 pb-3' : 'p-4 pb-3')}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="text-[10px]">
            {topic.coverage} {topic.coverage === 1 ? 'source' : 'sources'}
          </Badge>
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            {mounted ? formatTime(topic.latestSeen) : ''}
          </span>
        </div>
        <h3
          className={cn(
            'font-semibold leading-snug',
            isHero ? 'text-lg sm:text-xl' : 'text-base',
            variant === 'compact' ? 'text-sm' : '',
          )}
        >
          {topic.title}
        </h3>
      </div>

      {/* Image (non-hero: below header) */}
      {showImage && !isHero && (
        <div
          className={cn(
            'relative w-full overflow-hidden bg-muted',
            'aspect-[16/10]',
          )}
        >
          <img
            src={proxyImage(imageUrl!)}
            alt=""
            loading={variant === 'featured' ? 'eager' : 'lazy'}
            // @ts-expect-error — fetchPriority is a valid HTML attr but not in TS DOM types yet
            fetchpriority={variant === 'featured' ? 'high' : 'low'}
            className="h-full w-full object-cover"
            onError={() => setImgErrorMap((m) => ({ ...m, [imageUrl!]: true }))}
          />
        </div>
      )}

      {/* Description (hidden for hero + compact to keep the card compact) */}
      {topic.summary && variant !== 'compact' && !isHero && (
        <div className={cn('px-4', showImage && !isHero ? 'pt-3' : '')}>
          <p className="text-sm text-muted-foreground line-clamp-3">{topic.summary}</p>
        </div>
      )}

      {/* ── HERO: compact bias bar at the bottom (no sources button — keep it clean) ── */}
      {isHero && (
        <div className="mt-auto px-4 pb-3 pt-2">
          <BiasBar left={topic.leanLeft} center={topic.leanCenter} right={topic.leanRight} />
        </div>
      )}

      {/* ── DEFAULT + COMPACT: full bias bar + sources button ── */}
      {!isHero && (
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
      )}
    </Card>
  )
}

