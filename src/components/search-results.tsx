'use client'

import { ExternalLink, Globe, Loader2, Search as SearchIcon } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
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
}

const LEANING_BADGE: Record<string, { label: string; cls: string }> = {
  left: { label: 'Left', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300' },
  center: { label: 'Center', cls: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300' },
  right: { label: 'Right', cls: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' },
}

export function SearchResults({ query, loading, result }: SearchResultsProps) {
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

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          <strong className="text-foreground">{result.total}</strong> result
          {result.total === 1 ? '' : 's'} for “{query}”
        </span>
        <span>
          Searched {result.categoriesSearched} categories in {result.ms}ms
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {result.hits.map((hit) => {
          const lean = LEANING_BADGE[hit.article.leaning]
          return (
            <Card key={hit.article.id} className="gap-2 p-3">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase',
                    lean.cls,
                  )}
                >
                  {lean.label}
                </span>
                <Badge variant="secondary" className="text-[9px]">
                  {hit.topic.coverage} sources
                </Badge>
                <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Globe className="h-2.5 w-2.5" />
                  {hit.article.sourceName}
                </span>
              </div>

              <a
                href={hit.article.link}
                target="_blank"
                rel="noopener noreferrer"
                className="block"
              >
                <div className="line-clamp-2 text-sm font-medium leading-snug hover:underline">
                  {hit.article.title}
                </div>
                {hit.snippet && hit.matchedField !== 'title' && (
                  <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {hit.snippet}
                  </div>
                )}
                <div className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground">
                  Read at {hit.article.sourceName}
                  <ExternalLink className="h-2.5 w-2.5" />
                </div>
              </a>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
