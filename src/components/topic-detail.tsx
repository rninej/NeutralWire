'use client'

import * as React from 'react'
import {
  X,
  Clock,
  ExternalLink,
  Globe,
  Share2,
  Check,
  Loader2,
  AlertCircle,
  TrendingUp,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { BiasBar } from '@/components/bias-bar'
import { cn } from '@/lib/utils'
import type { TopicArticle } from '@/lib/news-aggregator'

interface TopicDetailProps {
  topic: TopicArticle
  onClose: () => void
}

const LEANING_BADGE: Record<string, { label: string; cls: string }> = {
  left: { label: 'Left', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300' },
  center: { label: 'Center', cls: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300' },
  right: { label: 'Right', cls: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' },
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function TopicDetail({ topic, onClose }: TopicDetailProps) {
  const [summary, setSummary] = React.useState<string | null>(null)
  const [summaryLoading, setSummaryLoading] = React.useState(true)
  const [summaryError, setSummaryError] = React.useState<string | null>(null)
  const [shared, setShared] = React.useState(false)
  const [imgError, setImgError] = React.useState(false)

  // Lock body scroll when open.
  React.useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

  // Push a history entry when the detail opens, so mobile swipe-back
  // closes the overlay instead of leaving the entire site.
  React.useEffect(() => {
    // Only push if we're not already on a ?topic= URL (avoid double-push
    // when opening via shared link).
    const url = new URL(window.location.href)
    if (url.searchParams.get('topic') !== topic.topicId) {
      url.searchParams.set('topic', topic.topicId)
      window.history.pushState({ detailOpen: true }, '', url.toString())
    }

    const popstateHandler = () => {
      onClose()
    }
    window.addEventListener('popstate', popstateHandler)
    return () => {
      window.removeEventListener('popstate', popstateHandler)
    }
  }, [topic.topicId, onClose])

  // Close on Escape.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Reset image error state when topic changes.
  React.useEffect(() => {
    setImgError(false)
  }, [topic.topicId, topic.imageUrl])

  // Fetch neutral summary from LLM.
  React.useEffect(() => {
    let cancelled = false
    setSummaryLoading(true)
    setSummaryError(null)

    ;(async () => {
      try {
        const res = await fetch('/api/summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            topicId: topic.topicId,
            title: topic.title,
            articles: topic.articles.map((a) => ({
              title: a.title,
              description: a.description,
              sourceName: a.sourceName,
              leaning: a.leaning,
            })),
          }),
        })
        const data = await res.json()
        if (cancelled) return
        if (!res.ok || data.error) {
          throw new Error(data.error || 'Failed to generate summary')
        }
        setSummary(data.summary)
      } catch (err) {
        if (cancelled) return
        setSummaryError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        if (!cancelled) setSummaryLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [topic.topicId, topic.title, topic.articles])

  const handleShare = async () => {
    const shareData = {
      title: topic.title,
      text: topic.summary || topic.title,
      url: topic.articles[0]?.link || window.location.href,
    }
    try {
      if (navigator.share) {
        await navigator.share(shareData)
      } else {
        await navigator.clipboard.writeText(
          `${topic.title}\n\n${topic.articles[0]?.link || window.location.href}`,
        )
        setShared(true)
        setTimeout(() => setShared(false), 2000)
      }
    } catch {
      // User cancelled or clipboard failed — silent.
    }
  }

  const total = topic.leanLeft + topic.leanCenter + topic.leanRight
  const showImage = topic.imageUrl && !imgError

  // Group articles by leaning for display.
  const leftArticles = topic.articles.filter((a) => a.leaning === 'left')
  const centerArticles = topic.articles.filter((a) => a.leaning === 'center')
  const rightArticles = topic.articles.filter((a) => a.leaning === 'right')

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-background"
      role="dialog"
      aria-modal="true"
      aria-label={topic.title}
    >
      {/* Sticky top bar with close + share */}
      <div className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
        <Button variant="ghost" size="sm" onClick={onClose} className="gap-1.5">
          <X className="h-4 w-4" />
          <span className="hidden sm:inline">Close</span>
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleShare}
            className="gap-1.5"
          >
            {shared ? (
              <>
                <Check className="h-4 w-4 text-emerald-500" />
                <span className="hidden sm:inline">Copied!</span>
              </>
            ) : (
              <>
                <Share2 className="h-4 w-4" />
                <span className="hidden sm:inline">Share</span>
              </>
            )}
          </Button>
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-4 py-6">
        {/* Header */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="text-[10px]">
            {topic.coverage} {topic.coverage === 1 ? 'source' : 'sources'}
          </Badge>
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            Updated {timeAgo(topic.latestSeen)}
          </span>
          {topic.localCoverage && topic.localCoverage > 0 && (
            <Badge variant="outline" className="text-[10px]">
              {topic.localCoverage} local
            </Badge>
          )}
        </div>

        <h1 className="mb-4 text-2xl font-bold leading-tight md:text-3xl">
          {topic.title}
        </h1>

        {/* Image */}
        {showImage && (
          <div className="relative mb-6 aspect-[16/9] w-full overflow-hidden rounded-lg bg-muted">
            <img
              src={`/api/img?url=${encodeURIComponent(topic.imageUrl!)}`}
              alt=""
              className="h-full w-full object-cover"
              onError={() => setImgError(true)}
            />
          </div>
        )}

        {/* Bias bar */}
        <div className="mb-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Coverage across the spectrum</h2>
            <span className="text-[11px] text-muted-foreground">
              {total} {total === 1 ? 'article' : 'articles'}
            </span>
          </div>
          <BiasBar
            left={topic.leanLeft}
            center={topic.leanCenter}
            right={topic.leanRight}
            showLabels
          />
          {/* Bias legend */}
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-blue-500" />
              Left ({topic.leanLeft})
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-zinc-500" />
              Center ({topic.leanCenter})
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-red-500" />
              Right ({topic.leanRight})
            </span>
          </div>
        </div>

        {/* Neutral in-depth summary */}
        <Card className="mb-6 p-5 md:p-6">
          <div className="mb-4 flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-base font-bold">Neutral Summary</h2>
            <span className="text-[11px] text-muted-foreground">
              AI-generated from {topic.articles.length} sources
            </span>
          </div>
          {summaryLoading ? (
            <div className="flex items-center gap-2 py-8 text-base text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              Generating neutral summary…
            </div>
          ) : summaryError ? (
            <div className="flex items-center gap-2 py-4 text-base text-muted-foreground">
              <AlertCircle className="h-5 w-5" />
              Could not generate summary. Showing original descriptions below.
            </div>
          ) : (
            <div className="space-y-4 text-base leading-relaxed text-foreground/90 md:text-[17px] md:leading-[1.7]">
              {(() => {
                // The LLM may use \n\n or \n between heading and paragraph.
                // Normalise: split on \n\n first, then within each chunk,
                // if it starts with a known heading pattern, split that off.
                const knownHeadings = [
                  'What Happened', 'The Context', 'Background',
                  'Different Perspectives', 'Reactions',
                  'What Happens Next', 'Why It Matters',
                  'Key Facts', 'Analysis', 'Impact',
                ]
                const headingRe = new RegExp(
                  `^\\*?\\*?(${knownHeadings.join('|')})\\*?\\*?\\s*\\n`,
                  'i',
                )

                const chunks = summary?.split('\n\n') || []
                const elements: React.ReactNode[] = []

                chunks.forEach((chunk, i) => {
                  // Check for **bold** heading on its own line.
                  const boldMatch = chunk.match(/^\*\*(.+)\*\*$/)
                  if (boldMatch) {
                    elements.push(
                      <h3 key={`h-${i}`} className="text-lg font-bold text-foreground mt-5 mb-1">
                        {boldMatch[1]}
                      </h3>,
                    )
                    return
                  }

                  // Check for known heading at the start of the chunk
                  // followed by \n and then the paragraph.
                  const headingMatch = chunk.match(headingRe)
                  if (headingMatch) {
                    const heading = headingMatch[1]
                    const rest = chunk.slice(headingMatch[0].length)
                    elements.push(
                      <h3 key={`h-${i}`} className="text-lg font-bold text-foreground mt-5 mb-1">
                        {heading}
                      </h3>,
                    )
                    if (rest.trim()) {
                      elements.push(<p key={`p-${i}`}>{rest.trim()}</p>)
                    }
                    return
                  }

                  // Also handle inline bold within paragraphs.
                  const parts = chunk.split(/(\*\*[^*]+\*\*)/g)
                  if (parts.length > 1) {
                    elements.push(
                      <p key={`p-${i}`}>
                        {parts.map((part, j) => {
                          const inlineBold = part.match(/^\*\*(.+)\*\*$/)
                          if (inlineBold) {
                            return <strong key={j} className="font-bold text-foreground">{inlineBold[1]}</strong>
                          }
                          return <span key={j}>{part}</span>
                        })}
                      </p>,
                    )
                    return
                  }

                  elements.push(<p key={`p-${i}`}>{chunk}</p>)
                })

                return elements
              })()}
            </div>
          )}
        </Card>

        {/* Sources grouped by leaning */}
        <div className="space-y-4">
          <h2 className="text-sm font-semibold">All Sources</h2>

          {leftArticles.length > 0 && (
            <SourceGroup
              label="Left"
              count={leftArticles.length}
              color="text-blue-600 dark:text-blue-400"
              articles={leftArticles}
            />
          )}
          {centerArticles.length > 0 && (
            <SourceGroup
              label="Center"
              count={centerArticles.length}
              color="text-zinc-600 dark:text-zinc-400"
              articles={centerArticles}
            />
          )}
          {rightArticles.length > 0 && (
            <SourceGroup
              label="Right"
              count={rightArticles.length}
              color="text-red-600 dark:text-red-400"
              articles={rightArticles}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function SourceGroup({
  label,
  count,
  color,
  articles,
}: {
  label: string
  count: number
  color: string
  articles: TopicArticle['articles']
}) {
  return (
    <div>
      <div className={cn('mb-2 flex items-center gap-2 text-xs font-semibold uppercase', color)}>
        {label}
        <span className="text-muted-foreground">({count})</span>
      </div>
      <div className="space-y-2">
        {articles.map((a) => (
          <a
            key={a.id}
            href={a.link}
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-lg border p-3 transition-colors hover:bg-muted/50"
          >
            <div className="line-clamp-2 text-sm font-medium leading-snug">
              {a.title}
            </div>
            <div className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
              <Globe className="h-2.5 w-2.5" />
              {a.sourceName}
              <span className="opacity-50">·</span>
              {a.country}
              <span className="opacity-50">·</span>
              {timeAgo(a.iso)}
              <ExternalLink className="ml-auto h-2.5 w-2.5" />
            </div>
          </a>
        ))}
      </div>
    </div>
  )
}
