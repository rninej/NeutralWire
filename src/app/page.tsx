'use client'

import * as React from 'react'
import {
  Newspaper,
  RefreshCw,
  Search,
  AlertCircle,
  Loader2,
  TrendingUp,
  Filter,
  Info,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import {
  CATEGORIES,
  CATEGORY_LABELS,
  NEWS_SOURCES,
  type Category,
} from '@/lib/news-sources'
import { ThemeToggle } from '@/components/theme-toggle'
import { TopicCard } from '@/components/topic-card'
import { BiasColumns } from '@/components/bias-columns'
import { SourceList } from '@/components/source-list'
import { cn } from '@/lib/utils'
import type { TopicArticle } from '@/app/api/news/route'

type View = 'feed' | 'columns' | 'sources'

interface NewsResponse {
  category: string
  topics: TopicArticle[]
  cached: boolean
  fetchedAt: string
  sourceCount: number
  articleCount?: number
  error?: string
  detail?: string
}

export default function Home() {
  const [category, setCategory] = React.useState<Category>('top')
  const [view, setView] = React.useState<View>('feed')
  const [search, setSearch] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [topics, setTopics] = React.useState<TopicArticle[]>([])
  const [fetchedAt, setFetchedAt] = React.useState<Date | null>(null)
  const [isCached, setIsCached] = React.useState(false)
  const [articleCount, setArticleCount] = React.useState(0)
  const [minCoverage, setMinCoverage] = React.useState(1)

  const fetchData = React.useCallback(async (cat: Category, mc: number) => {
    setLoading(true)
    setError(null)
    try {
      const url = `/api/news?category=${encodeURIComponent(cat)}&limit=24&minCoverage=${mc}`
      const res = await fetch(url, { cache: 'no-store' })
      const json: NewsResponse = await res.json()
      if (!res.ok || json.error) {
        throw new Error(json.error || `Failed (${res.status})`)
      }
      setTopics(json.topics)
      setFetchedAt(new Date(json.fetchedAt))
      setIsCached(json.cached)
      setArticleCount(json.articleCount ?? 0)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load news')
      setTopics([])
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    fetchData(category, minCoverage)
  }, [category, minCoverage, fetchData])

  // Filter topics by search query
  const filteredTopics = React.useMemo(() => {
    if (!search.trim()) return topics
    const q = search.toLowerCase()
    return topics.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.summary.toLowerCase().includes(q) ||
        t.articles.some(
          (a) =>
            a.title.toLowerCase().includes(q) ||
            a.sourceName.toLowerCase().includes(q),
        ),
    )
  }, [topics, search])

  const featured = filteredTopics[0]
  const rest = filteredTopics.slice(1)

  const handleRefresh = () => fetchData(category, minCoverage)

  return (
    <div className="flex min-h-screen flex-col">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
          <a href="/" className="flex items-center gap-2 font-bold">
            <div className="flex h-7 w-7 items-center justify-center rounded bg-foreground text-background">
              <Newspaper className="h-4 w-4" />
            </div>
            <span className="hidden sm:inline">
              Ground News <span className="text-muted-foreground">Free</span>
            </span>
          </a>

          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRefresh}
              disabled={loading}
              className="gap-1.5"
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            <ThemeToggle />
          </div>
        </div>

        {/* Category nav */}
        <div className="mx-auto max-w-7xl px-4 pb-2">
          <Tabs value={category} onValueChange={(v) => setCategory(v as Category)}>
            <TabsList className="flex w-full overflow-x-auto justify-start gap-1 bg-transparent p-0 h-auto">
              {CATEGORIES.map((c) => (
                <TabsTrigger
                  key={c}
                  value={c}
                  className="data-[state=active]:bg-foreground data-[state=active]:text-background rounded-md px-3 py-1.5 text-xs font-medium"
                >
                  {CATEGORY_LABELS[c]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </header>

      {/* Main */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        {/* Search bar */}
        <div className="mb-4 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search topics, sources, headlines…"
              className="pl-8"
            />
          </div>
        </div>

        {/* View switcher + meta */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <Tabs value={view} onValueChange={(v) => setView(v as View)}>
            <TabsList>
              <TabsTrigger value="feed" className="gap-1.5 text-xs">
                <TrendingUp className="h-3.5 w-3.5" /> Feed
              </TabsTrigger>
              <TabsTrigger value="columns" className="gap-1.5 text-xs">
                <Filter className="h-3.5 w-3.5" /> Bias Split
              </TabsTrigger>
              <TabsTrigger value="sources" className="gap-1.5 text-xs">
                Sources
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <span>
              {loading
                ? 'Loading…'
                : `${filteredTopics.length} topics · ${articleCount} articles`}
            </span>
            {fetchedAt && (
              <span className="hidden items-center gap-1 sm:inline-flex">
                · updated {fetchedAt.toLocaleTimeString()}
                {isCached && <span className="opacity-60">(cached)</span>}
              </span>
            )}
            <select
              value={minCoverage}
              onChange={(e) => setMinCoverage(Number(e.target.value))}
              className="rounded-md border bg-background px-1.5 py-1 text-xs"
              aria-label="Minimum coverage filter"
              title="Minimum sources per topic"
            >
              <option value={1}>All stories</option>
              <option value={2}>2+ sources</option>
              <option value={3}>3+ sources</option>
              <option value={4}>4+ sources</option>
            </select>
          </div>
        </div>

        {/* Bias legend */}
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          <span className="font-semibold text-foreground">Bias legend:</span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-blue-500" />
            Left
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-zinc-500" />
            Center
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
            Right
          </span>
          <span className="ml-auto hidden items-center gap-1 sm:inline-flex">
            <Info className="h-3 w-3" />
            Bias ratings are community approximations, not authoritative.
          </span>
        </div>

        {/* Content */}
        {error ? (
          <Card className="flex flex-col items-center gap-3 p-12 text-center">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <div>
              <div className="font-semibold">Could not load news</div>
              <div className="mt-1 text-sm text-muted-foreground">{error}</div>
            </div>
            <Button onClick={handleRefresh} variant="outline" size="sm">
              <RefreshCw className="h-4 w-4" /> Try again
            </Button>
          </Card>
        ) : view === 'sources' ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Ground News Free aggregates {NEWS_SOURCES.length} free RSS feeds from
              outlets across the political spectrum. Bias labels follow public
              ratings from AllSides and Media Bias Fact Check — they are
              best-effort approximations, not definitive.
            </p>
            <SourceList />
          </div>
        ) : loading ? (
          <LoadingState />
        ) : filteredTopics.length === 0 ? (
          <Card className="flex flex-col items-center gap-2 p-12 text-center text-muted-foreground">
            <AlertCircle className="h-6 w-6" />
            <div>
              {search
                ? `No topics match "${search}"`
                : 'No topics found. Try a different category or lower the minimum coverage filter.'}
            </div>
          </Card>
        ) : view === 'columns' ? (
          <BiasColumns topics={filteredTopics} />
        ) : (
          <>
            {/* Featured story */}
            {featured && (
              <div className="mb-5">
                <div className="mb-2 flex items-center gap-2">
                  <Badge variant="default" className="gap-1 text-[10px]">
                    <TrendingUp className="h-3 w-3" /> Most covered
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {featured.coverage} sources reporting
                  </span>
                </div>
                <TopicCard topic={featured} variant="featured" defaultOpen />
              </div>
            )}

            {/* Topic grid */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {rest.map((t) => (
                <TopicCard key={t.topicId} topic={t} />
              ))}
            </div>
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t bg-muted/30 py-6 mt-auto">
        <div className="mx-auto max-w-7xl px-4 text-xs text-muted-foreground">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <strong className="text-foreground">Ground News Free</strong> · A free,
              open-source news aggregator built on public RSS feeds. Not affiliated
              with Ground News, Inc.
            </div>
            <div className="flex items-center gap-3">
              <span>{NEWS_SOURCES.length} sources</span>
              <span>·</span>
              <span>No API keys</span>
              <span>·</span>
              <span>No tracking</span>
            </div>
          </div>
          <p className="mt-3 max-w-3xl">
            Bias ratings shown here are best-effort approximations based on public
            community ratings (AllSides, Media Bias Fact Check). They reflect
            general editorial tendency, not the stance of any individual article.
            Always read across the spectrum before forming an opinion.
          </p>
        </div>
      </footer>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <Card className="h-64 animate-pulse bg-muted/40" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="h-48 animate-pulse bg-muted/40" />
        ))}
      </div>
      <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Fetching headlines from {NEWS_SOURCES.length} sources…
      </div>
    </div>
  )
}
