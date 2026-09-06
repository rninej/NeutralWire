'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import { Loader2, Search as SearchIcon } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Clock, Globe, History } from 'lucide-react'
import { BiasBar } from '@/components/bias-bar'
import { cn, safeImageUrl } from '@/lib/utils'
import type { TopicArticle, FeedArticle } from '@/lib/news-aggregator'

interface SearchHit {
  topic: TopicArticle
  article: FeedArticle
  matchedField: 'title' | 'summary' | 'source'
  snippet: string
  fromArchive?: boolean
}

interface SearchResponse {
  query: string
  hits: SearchHit[]
  total: number
  categoriesSearched: number
  archiveSearched?: number
  indexedNow?: number
  ms: number
}

interface SearchResultsProps {
  query: string
  loading: boolean
  result: SearchResponse | null
  onOpenTopic?: (topic: TopicArticle) => void
  /** Embedded mode: hide hits whose topicId is already rendered above
   *  (the local feed grid) so the archive section only adds NEW stories. */
  excludeTopicIds?: string[]
  /** Optional section heading above the results (embedded mode). */
  heading?: string
  /** When true, render NOTHING while loading-with-no-prior-result or
   *  when no hits remain after exclusion (a silent empty section). */
  hiddenIfEmpty?: boolean
}

/**
 * Format a timestamp as a fixed date/time string (matches topic-card format).
 * Archive hits from a PREVIOUS year append the year — "4 Mar 2024" — so
 * genuinely old stories read as old, which is the point of archive search.
 */
function formatTime(ms: number): string {
  const d = new Date(ms)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const date = d.getDate()
  const month = months[d.getMonth()]
  const now = new Date()
  const year = d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${date} ${month}${year}, ${hh}:${mm}`
}

export function SearchResults({
  query,
  loading,
  result,
  onOpenTopic,
  excludeTopicIds,
  heading,
  hiddenIfEmpty,
}: SearchResultsProps) {
  // Deduplicate by topicId — multiple hits from the same topic should only
  // show ONE card (the topic card), not one card per article. Embedded
  // mode also drops topics already rendered by the local grid above.
  const seenTopicIds = new Set<string>(excludeTopicIds || [])
  const uniqueTopics: Array<TopicArticle & { fromArchive?: boolean }> = []
  const archiveHitIds = new Set<string>()
  for (const hit of result?.hits || []) {
    if (!seenTopicIds.has(hit.topic.topicId)) {
      seenTopicIds.add(hit.topic.topicId)
      uniqueTopics.push(hit.topic)
    }
    if (hit.fromArchive) archiveHitIds.add(hit.topic.topicId)
  }

  // Embedded (hiddenIfEmpty) mode: show nothing until there's something to
  // show — no spinner over the feed while the archive search loads, and no
  // empty section when nothing extra was found.
  if (hiddenIfEmpty && (uniqueTopics.length === 0 || (!result && loading))) {
    return null
  }

  if (loading && !result) {
    return (
      <Card className="flex flex-col items-center gap-2 p-8 text-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <div className="text-sm">
          Searching every archived article across the spectrum…
        </div>
      </Card>
    )
  }

  if (!result || uniqueTopics.length === 0) {
    return (
      <Card className="flex flex-col items-center gap-2 p-8 text-center">
        <SearchIcon className="h-5 w-5 text-muted-foreground" />
        <div className="font-medium">No results for “{query}”</div>
        <div className="text-xs text-muted-foreground">
          Searched {result?.categoriesSearched ?? 0} live categories +{' '}
          {result?.archiveSearched ?? 0} archived stories · {result?.ms ?? 0}ms.
          Try a different term.
        </div>
      </Card>
    )
  }

  const headingEl = heading ? (
    <div className="mb-1 flex items-center gap-2 border-t border-border pt-6 text-sm font-bold">
      <History className="h-4 w-4 text-muted-foreground" />
      {heading}
      <span className="ml-auto text-[11px] font-normal text-muted-foreground">
        older stories from the permanent archive
      </span>
    </div>
  ) : null

  return (
    <div className="space-y-3">
      {headingEl}
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          <strong className="text-foreground">{uniqueTopics.length}</strong> stori
          {uniqueTopics.length === 1 ? 'y' : 'es'} for “{query}”
        </span>
        <span>
          {result?.archiveSearched != null
            ? `${result.categoriesSearched} live + ${result.archiveSearched} archived · ${result.ms}ms`
            : `Searched ${result?.categoriesSearched ?? 0} categories in ${result?.ms ?? 0}ms`}
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {uniqueTopics.map((topic, i) => (
          <SearchTopicCard
            key={topic.topicId}
            topic={topic}
            index={i}
            fromArchive={archiveHitIds.has(topic.topicId)}
            onOpen={onOpenTopic}
          />
        ))}
      </div>
    </div>
  )
}

function SearchTopicCard({
  topic,
  index = 0,
  fromArchive = false,
  onOpen,
}: {
  topic: TopicArticle
  index?: number
  fromArchive?: boolean
  onOpen?: (topic: TopicArticle) => void
}) {
  const [imgError, setImgError] = React.useState(false)
  // Only render time after mount — formatTime() is timezone-dependent and
  // would cause hydration mismatch (server uses UTC, client uses local TZ).
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])
  const total = topic.leanLeft + topic.leanCenter + topic.leanRight
  const imageUrl = safeImageUrl(topic.imageUrl)
  const showImage = imageUrl && !imgError

  const handleClick = () => {
    onOpen?.(topic)
  }

  // Staggered fade-in: each card delays by ~40ms (capped at 0.32s so long
  // result lists don't make the user wait). 250ms duration keeps it snappy.
  const staggerDelay = Math.min(index * 0.04, 0.32)

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: staggerDelay, ease: 'easeOut' }}
      className="h-full"
    >
      <Card
        className="overflow-hidden p-0 gap-0 flex flex-col cursor-pointer hover:ring-2 hover:ring-foreground/20 transition-all h-full"
        onClick={handleClick}
      >
        <div className="flex flex-col gap-2 p-4 pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="text-[10px]">
              {topic.coverage} {topic.coverage === 1 ? 'source' : 'sources'}
            </Badge>
            {fromArchive && (
              <Badge
                variant="outline"
                className="gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400"
              >
                <History className="h-2.5 w-2.5" />
                Archive
              </Badge>
            )}
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <Clock className="h-3 w-3" />
              {mounted ? formatTime(topic.latestSeen) : ''}
            </span>
          </div>
          <h3 className="font-semibold leading-snug text-base">
            {topic.title}
          </h3>
        </div>

        {showImage && (
          <div className="relative w-full overflow-hidden bg-muted aspect-[16/10]">
            <img
              src={`/api/img?url=${encodeURIComponent(imageUrl!)}`}
              alt=""
              className="h-full w-full object-cover"
              onError={() => setImgError(true)}
            />
          </div>
        )}

        {topic.summary && (
          <div className={cn('px-4', showImage ? 'pt-3' : '')}>
            <p className="text-sm text-muted-foreground line-clamp-3">{topic.summary}</p>
          </div>
        )}

        <div className="mt-auto flex flex-col gap-3 p-4 pt-3">
          <BiasBar left={topic.leanLeft} center={topic.leanCenter} right={topic.leanRight} />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              {total} {total === 1 ? 'article' : 'articles'} across the spectrum
            </span>
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-foreground">
              <Globe className="h-2.5 w-2.5" />
              Open in NeutralWire
            </span>
          </div>
        </div>
      </Card>
    </motion.div>
  )
}
