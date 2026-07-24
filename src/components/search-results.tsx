'use client'

import * as React from 'react'
import { Loader2, Search as SearchIcon } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Clock, Globe } from 'lucide-react'
import { BiasBar } from '@/components/bias-bar'
import { cn } from '@/lib/utils'
import type { TopicArticle, FeedArticle } from '@/lib/news-aggregator'

interface SearchHit {
  topic: TopicArticle
  article: FeedArticle
  matchedField: 'title' | 'summary' | 'source'
  snippet: string
}

interface SearchResponse {
  query: string
  hits: SearchHit[]
  total: number
  categoriesSearched: number
  ms: number
}

interface SearchResultsProps {
  query: string
  loading: boolean
  result: SearchResponse | null
  onOpenTopic?: (topic: TopicArticle) => void
}

/**
 * Format a timestamp as a fixed date/time string (matches topic-card format).
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

export function SearchResults({ query, loading, result, onOpenTopic }: SearchResultsProps) {
  if (loading) {
    return (
      <Card className="flex flex-col items-center gap-2 p-8 text-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <div className="text-sm">
          Searching through all cached articles across the spectrum…
        </div>
      </Card>
    )
  }

  if (!result || result.hits.length === 0) {
    return (
      <Card className="flex flex-col items-center gap-2 p-8 text-center">
        <SearchIcon className="h-5 w-5 text-muted-foreground" />
        <div className="font-medium">No results for “{query}”</div>
        <div className="text-xs text-muted-foreground">
          Searched {result?.categoriesSearched ?? 0} categories · {result?.ms ?? 0}ms.
          Try a different term.
        </div>
      </Card>
    )
  }

  // Deduplicate by topicId — multiple hits from the same topic should only
  // show ONE card (the topic card), not one card per article.
  const seenTopicIds = new Set<string>()
  const uniqueTopics: TopicArticle[] = []
  for (const hit of result.hits) {
    if (!seenTopicIds.has(hit.topic.topicId)) {
      seenTopicIds.add(hit.topic.topicId)
      uniqueTopics.push(hit.topic)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          <strong className="text-foreground">{uniqueTopics.length}</strong> stori
          {uniqueTopics.length === 1 ? 'y' : 'es'} for “{query}”
        </span>
        <span>
          Searched {result.categoriesSearched} categories in {result.ms}ms
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {uniqueTopics.map((topic) => (
          <SearchTopicCard
            key={topic.topicId}
            topic={topic}
            onOpen={onOpenTopic}
          />
        ))}
      </div>
    </div>
  )
}

function SearchTopicCard({
  topic,
  onOpen,
}: {
  topic: TopicArticle
  onOpen?: (topic: TopicArticle) => void
}) {
  const [imgError, setImgError] = React.useState(false)
  const total = topic.leanLeft + topic.leanCenter + topic.leanRight
  const showImage = topic.imageUrl && !imgError

  const handleClick = () => {
    onOpen?.(topic)
  }

  return (
    <Card
      className="overflow-hidden p-0 gap-0 flex flex-col cursor-pointer hover:ring-2 hover:ring-foreground/20 transition-all"
      onClick={handleClick}
    >
      <div className="flex flex-col gap-2 p-4 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="text-[10px]">
            {topic.coverage} {topic.coverage === 1 ? 'source' : 'sources'}
          </Badge>
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            {formatTime(topic.latestSeen)}
          </span>
        </div>
        <h3 className="font-semibold leading-snug text-base">
          {topic.title}
        </h3>
      </div>

      {showImage && (
        <div className="relative w-full overflow-hidden bg-muted aspect-[16/10]">
          <img
            src={`/api/img?url=${encodeURIComponent(topic.imageUrl!)}`}
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
  )
}
