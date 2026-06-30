'use client'

import * as React from 'react'
import { useState, useEffect } from 'react'
import {
  Newspaper,
  RefreshCw,
  Search,
  AlertCircle,
  Loader2,
  TrendingUp,
  Filter,
  Info,
  Cloud,
  X,
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
  CATEGORY_LABELS,
  PRIMARY_CATEGORIES,
  SECONDARY_CATEGORIES,
  type Category,
} from '@/lib/news-sources'
import { ThemeToggle } from '@/components/theme-toggle'
import { TopicCard } from '@/components/topic-card'
import { TopicDetail } from '@/components/topic-detail'
import { BiasColumns } from '@/components/bias-columns'
import { SourceList } from '@/components/source-list'
import { CountryPicker } from '@/components/country-picker'
import { SearchResults } from '@/components/search-results'
import { cn } from '@/lib/utils'
import type { TopicArticle } from '@/lib/news-aggregator'
import type { CountryInfo } from '@/lib/country-detect'
import { detectCountryClient, DEFAULT_COUNTRY } from '@/lib/country-detect'

type View = 'feed' | 'columns' | 'sources'

interface NewsResponse {
  category: string
  country?: string
  countryName?: string
  topics: TopicArticle[]
  cached: boolean
  fresh?: boolean
  staleMs?: number
  fetchedAt: string
  sourceCount: number
  articleCount?: number
  ms?: number
  error?: string
  detail?: string
}

interface SearchResponse {
  query: string
  hits: Array<{
    topic: TopicArticle
    article: TopicArticle['articles'][number]
    matchedField: 'title' | 'summary' | 'source'
    snippet: string
  }>
  total: number
  categoriesSearched: number
  ms: number
}

export default function Home() {
  // --- Country detection ---
  const [country, setCountry] = useState<CountryInfo | null>(null)

  // --- Category / view state ---
  const [category, setCategory] = useState<Category>('relevant')
  const [view, setView] = useState<View>('feed')

  // --- Search state ---
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [apiSearchLoading, setApiSearchLoading] = useState(false)
  const [apiSearchResult, setApiSearchResult] = useState<SearchResponse | null>(null)
  const [localSearchAttempted, setLocalSearchAttempted] = useState(false)

  // --- News data state ---
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [topics, setTopics] = useState<TopicArticle[]>([])
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null)
  const [isCached, setIsCached] = useState(false)
  const [isFresh, setIsFresh] = useState(true)
  const [articleCount, setArticleCount] = useState(0)
  const [minCoverage, setMinCoverage] = useState(1)
  const [loadMs, setLoadMs] = useState<number | null>(null)

  // --- Detail overlay state ---
  const [detailTopic, setDetailTopic] = useState<TopicArticle | null>(null)

  // --- Refs for race-condition protection ---
  const reqIdRef = React.useRef(0)
  const categoryRef = React.useRef(category)
  useEffect(() => {
    categoryRef.current = category
  }, [category])

  // --- Country detection on first load ---
  // Client-side detection is PRIMARY (runs in the user's browser, sees
  // their real public IP). Server-side detection is unreliable behind
  // the Caddy gateway which may not forward the real client IP.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // Check localStorage for a manual override first.
      try {
        const manual = localStorage.getItem('neutralwire:country-manual')
        if (manual) {
          const parsed = JSON.parse(manual) as CountryInfo
          if (!cancelled) {
            setCountry(parsed)
            return
          }
        }
      } catch {
        // ignore
      }

      // Client-side auto-detection (ipwho.is → reallyfreegeoip → cloudflare trace).
      const client = await detectCountryClient()
      if (!cancelled) setCountry(client || DEFAULT_COUNTRY)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // --- Manual country override ---
  const handleCountryChange = React.useCallback((c: CountryInfo) => {
    setCountry(c)
    try {
      localStorage.setItem('neutralwire:country-manual', JSON.stringify(c))
    } catch {
      // ignore
    }
  }, [])

  // --- Debounced search ---
  useEffect(() => {
    setLocalSearchAttempted(false)
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim())
    }, 250)
    return () => clearTimeout(t)
  }, [search])

  // --- Filter topics locally for instant feedback ---
  const filteredTopics = React.useMemo(() => {
    if (!debouncedSearch) return topics
    const q = debouncedSearch.toLowerCase()
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
  }, [topics, debouncedSearch])

  // Track whether local search yielded no results — triggers API search.
  useEffect(() => {
    if (debouncedSearch && filteredTopics.length === 0 && topics.length > 0) {
      setLocalSearchAttempted(true)
    } else if (debouncedSearch && filteredTopics.length > 0) {
      setApiSearchResult(null)
      setLocalSearchAttempted(false)
    }
  }, [debouncedSearch, filteredTopics.length, topics.length])

  // --- API search fallback (when local search yields nothing) ---
  useEffect(() => {
    if (!localSearchAttempted || !debouncedSearch) return
    let cancelled = false
    setApiSearchLoading(true)
    ;(async () => {
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(debouncedSearch)}&limit=30`,
          { cache: 'no-store' },
        )
        const json: SearchResponse = await res.json()
        if (!cancelled) setApiSearchResult(json)
      } catch {
        if (!cancelled) setApiSearchResult(null)
      } finally {
        if (!cancelled) setApiSearchLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [localSearchAttempted, debouncedSearch])

  // --- Fetch news (cache-first from Firebase) ---
  const fetchData = React.useCallback(
    async (cat: Category, mc: number, country?: CountryInfo | null) => {
      // For virtual categories, wait until country is detected.
      // This prevents fetching with the wrong country on initial load.
      const isVirtual = cat === 'relevant' || cat === 'mycountry'
      if (isVirtual && !country) return

      const reqId = ++reqIdRef.current
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({
          category: cat,
          limit: '24',
          minCoverage: String(mc),
        })
        if (country && isVirtual) {
          params.set('country', country.code)
        }
        const res = await fetch(`/api/news?${params.toString()}`, { cache: 'no-store' })
        const json: NewsResponse = await res.json()
        if (reqId !== reqIdRef.current) return
        if (!res.ok || json.error) {
          throw new Error(json.error || `Failed (${res.status})`)
        }
        setTopics(json.topics)
        setFetchedAt(new Date(json.fetchedAt))
        setIsCached(!!json.cached)
        setIsFresh(json.fresh !== false)
        setArticleCount(json.articleCount ?? 0)
        setLoadMs(json.ms ?? null)
      } catch (e) {
        if (reqId !== reqIdRef.current) return
        setError(e instanceof Error ? e.message : 'Failed to load news')
        setTopics([])
      } finally {
        if (reqId === reqIdRef.current) setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    fetchData(category, minCoverage, country)
  }, [category, minCoverage, country, fetchData])

  // --- Background refresh when stale ---
  const bgRefresh = React.useCallback(
    async (cat: Category, mc: number, country?: CountryInfo | null) => {
      setRefreshing(true)
      try {
        const params = new URLSearchParams({
          category: cat,
          limit: '24',
          minCoverage: String(mc),
        })
        if (country && (cat === 'relevant' || cat === 'mycountry')) {
          params.set('country', country.code)
        }
        const res = await fetch(`/api/refresh?${params.toString()}`, { cache: 'no-store' })
        const json: NewsResponse = await res.json()
        if (!res.ok || json.error) return
        if (cat !== categoryRef.current) return
        setTopics(json.topics)
        setFetchedAt(new Date(json.fetchedAt))
        setIsCached(false)
        setIsFresh(true)
        setArticleCount(json.articleCount ?? 0)
      } catch {
        // silent
      } finally {
        setRefreshing(false)
      }
    },
    [],
  )

  // Auto-trigger background refresh when stale.
  useEffect(() => {
    if (!isFresh && !loading && !refreshing) {
      const t = setTimeout(() => {
        bgRefresh(category, minCoverage, country)
      }, 2000)
      return () => clearTimeout(t)
    }
  }, [isFresh, loading, refreshing, category, minCoverage, country, bgRefresh])

  const handleRefreshClick = () => {
    bgRefresh(category, minCoverage, country)
  }

  const handleClearSearch = () => {
    setSearch('')
    setDebouncedSearch('')
    setApiSearchResult(null)
    setLocalSearchAttempted(false)
  }

  const featured = filteredTopics[0]
  const rest = filteredTopics.slice(1)
  const showApiSearch = localSearchAttempted && debouncedSearch

  return (
    <div className="flex min-h-screen flex-col">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
          <a href="/" className="flex items-center gap-2 font-bold">
            <div className="flex h-7 w-7 items-center justify-center rounded bg-foreground text-background">
              <Newspaper className="h-4 w-4" />
            </div>
            <span className="hidden sm:inline">NeutralWire</span>
          </a>

          {/* Country picker (clickable, with manual override) */}
          <CountryPicker country={country} onChange={handleCountryChange} />

          {/* Cache indicator */}
          <Badge
            variant="outline"
            className="hidden gap-1 text-[10px] font-normal sm:inline-flex"
            title={isFresh ? 'Data is fresh' : 'Showing cached data — refreshing'}
          >
            {isFresh ? (
              <>
                <Cloud className="h-3 w-3 text-emerald-500" />
                Fresh
              </>
            ) : (
              <>
                <Cloud className="h-3 w-3 text-amber-500" />
                Cached
              </>
            )}
            {loadMs !== null && !loading && (
              <span className="ml-1 opacity-60">{loadMs}ms</span>
            )}
          </Badge>

          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRefreshClick}
              disabled={refreshing || loading}
              className="gap-1.5"
            >
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
              <span className="hidden sm:inline">
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </span>
            </Button>
            <ThemeToggle />
          </div>
        </div>

        {/* Category nav: all categories shown flat (no "More" expandable) */}
        <div className="mx-auto max-w-7xl px-4 pb-2">
          <div className="flex flex-wrap items-center gap-1">
            {PRIMARY_CATEGORIES.map((c) => (
              <CategoryTab
                key={c}
                cat={c}
                active={category === c}
                onClick={() => setCategory(c)}
              />
            ))}

            <div className="mx-1 h-5 w-px bg-border" />

            {SECONDARY_CATEGORIES.map((c) => (
              <CategoryTab
                key={c}
                cat={c}
                active={category === c}
                onClick={() => setCategory(c)}
              />
            ))}
          </div>
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
              placeholder="Search all cached articles across the spectrum…"
              className="pl-8 pr-8"
            />
            {search && (
              <button
                type="button"
                onClick={handleClearSearch}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Search results (full-catalog API search) — replaces the normal view
            when local search yields nothing and an API search is running. */}
        {showApiSearch ? (
          <SearchResults
            query={debouncedSearch}
            loading={apiSearchLoading}
            result={apiSearchResult}
          />
        ) : (
          <>
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
                    : refreshing
                      ? 'Refreshing from RSS…'
                      : `${filteredTopics.length} topics · ${articleCount} articles`}
                </span>
                {fetchedAt && (
                  <span className="hidden items-center gap-1 sm:inline-flex">
                    · updated {fetchedAt.toLocaleTimeString()}
                    {isCached && !isFresh && (
                      <span className="text-amber-500">(cached)</span>
                    )}
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
                <Button onClick={handleRefreshClick} variant="outline" size="sm">
                  <RefreshCw className="h-4 w-4" /> Try again
                </Button>
              </Card>
            ) : view === 'sources' ? (
              <SourceList />
            ) : loading ? (
              <LoadingState />
            ) : filteredTopics.length === 0 ? (
              <Card className="flex flex-col items-center gap-2 p-12 text-center text-muted-foreground">
                <AlertCircle className="h-6 w-6" />
                <div>
                  {debouncedSearch
                    ? `No topics match "${debouncedSearch}" — searching full catalog…`
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
                    <TopicCard
                      key={featured.topicId + (featured.imageUrl || '')}
                      topic={featured}
                      variant="featured"
                      defaultOpen
                      onOpenDetail={setDetailTopic}
                    />
                  </div>
                )}

                {/* Topic grid */}
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {rest.map((t) => (
                    <TopicCard
                      key={t.topicId + (t.imageUrl || '')}
                      topic={t}
                      onOpenDetail={setDetailTopic}
                    />
                  ))}
                </div>

                {/* Background refresh hint */}
                {refreshing && (
                  <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border bg-background/95 px-4 py-1.5 text-xs shadow-md backdrop-blur">
                    <Loader2 className="mr-1.5 inline h-3 w-3 animate-spin" />
                    Fetching fresh headlines from RSS feeds…
                  </div>
                )}
              </>
            )}
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t bg-muted/30 py-4 mt-auto">
        <div className="mx-auto max-w-7xl px-4 text-center text-xs text-muted-foreground">
          NeutralWire
        </div>
      </footer>

      {/* Detail overlay */}
      {detailTopic && (
        <TopicDetail
          topic={detailTopic}
          onClose={() => setDetailTopic(null)}
        />
      )}
    </div>
  )
}

function CategoryTab({
  cat,
  active,
  onClick,
}: {
  cat: Category
  active: boolean
  country?: CountryInfo | null
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'bg-foreground text-background'
          : 'hover:bg-muted text-foreground/80',
      )}
    >
      {CATEGORY_LABELS[cat]}
    </button>
  )
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <Card className="h-72 animate-pulse bg-muted/40" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="h-64 animate-pulse bg-muted/40" />
        ))}
      </div>
      <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading from Firebase cache…
      </div>
    </div>
  )
}
