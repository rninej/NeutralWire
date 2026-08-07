'use client'

import * as React from 'react'
import { X, Heart, Loader2, Check, ThumbsDown, ImageIcon } from 'lucide-react'
import { motion } from 'framer-motion'
import { Button } from '@/components/ui/button'
import {
  SECTORS,
  detectSectors,
  bumpEngagementForTopic,
  setInterestsLocal,
  syncInterestsWithFirebase,
} from '@/lib/user-interests'
import { getDeviceId } from '@/lib/referral'
import type { TopicArticle } from '@/lib/news-aggregator'

const ONBOARDED_KEY = 'neutralwire:onboarded'
const ONBOARDING_DISMISSED_KEY = 'neutralwire:onboarding-dismissed-at'
const ONBOARDING_DISMISS_DURATION = 1 * 60 * 60 * 1000 // 1 hour — popup re-appears after 1hr
const ARTICLES_OPENED_KEY = 'neutralwire:articles-opened'
const DONATE_SHOWN_KEY = 'neutralwire:donate-shown-at'
const DONATE_NEXT_KEY = 'neutralwire:donate-next-threshold'
const DONATE_PRESSED_KEY = 'neutralwire:donate-pressed'

// Donation popup thresholds (in number of articles opened).
// First popup after 10 articles, then doubles: 20 → 40 → 80 → 160...
const INITIAL_THRESHOLD = 10

// ── Quiz article model ──
interface QuizArticle {
  topicId: string
  title: string
  summary: string
  imageUrl: string | null
  coverage: number
  category: string
  categoryLabel: string
}

// ── Categories fetched for the quiz ──
// 2 articles each from ALL subtopic categories EXCEPT 'relevant':
//   world, politics, business, technology, science, health, sports,
//   top, mycountry (if country detected), blindspots
// = 8-9 categories × 2 articles = 16-18
// + extra articles from random categories to reach 22 total
// 'relevant' is EXCLUDED because it's a mix of other categories —
// the quiz uses the actual subtopics to customize the relevant feed.
const QUIZ_BASE_CATEGORIES = [
  'world',
  'politics',
  'business',
  'technology',
  'science',
  'health',
  'sports',
  'top',
] as const

const CATEGORY_LABELS: Record<string, string> = {
  world: 'World',
  politics: 'Politics',
  business: 'Business',
  technology: 'Tech',
  science: 'Science',
  health: 'Health',
  sports: 'Sports',
  top: 'Top',
  relevant: 'Relevant',
  mycountry: 'My Country',
}

// Sort priority for displaying articles in the quiz:
//   world/politics first (0)
//   business/technology next (1)
//   science/health/sports next (2)
//   relevant/top/mycountry last (3)
const CATEGORY_PRIORITY: Record<string, number> = {
  world: 0,
  politics: 0,
  business: 1,
  technology: 1,
  science: 2,
  health: 2,
  sports: 2,
  top: 3,
  relevant: 3,
  mycountry: 3,
}

const FETCH_TIMEOUT_MS = 12_000 // per-category fetch timeout

/**
 * Read the visitor's detected (or manually-picked) country code from
 * localStorage. Used to fetch virtual categories ('relevant', 'mycountry')
 * with the correct country context.
 */
function getDetectedCountry(): string {
  if (typeof window === 'undefined') return ''
  try {
    // Prefer manual override (set by the CountryPicker component)
    const manual = localStorage.getItem('neutralwire:country-manual')
    if (manual) {
      const parsed = JSON.parse(manual) as { code?: string }
      if (parsed?.code) return parsed.code
    }
    // Then auto-detected (set by detectCountryClient with a 24h TTL)
    const auto = localStorage.getItem('neutralwire:country')
    if (auto) {
      const parsed = JSON.parse(auto) as {
        ts?: number
        info?: { code?: string } | null
      }
      if (parsed?.info?.code) return parsed.info.code
    }
  } catch {
    /* ignore */
  }
  return ''
}

/**
 * Fetch news for a single category with timeout + graceful failure.
 * Returns an empty array on any error so the rest of the quiz can still load.
 */
async function fetchCategoryArticles(
  category: string,
  country: string,
  limit: number,
  offset: number = 0,
): Promise<QuizArticle[]> {
  const params = new URLSearchParams({
    category,
    limit: String(limit),
    slim: '1',
    minCoverage: '1',
    offset: String(offset),
  })
  if ((category === 'relevant' || category === 'mycountry') && country) {
    params.set('country', country)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`/api/news?${params.toString()}`, {
      signal: controller.signal,
    })
    if (!res.ok) return []
    const data = (await res.json()) as { topics?: TopicArticle[] }
    if (!data.topics) return []
    return data.topics.map((t) => ({
      topicId: t.topicId,
      title: t.title,
      summary: t.summary,
      imageUrl: t.imageUrl,
      coverage: t.coverage,
      category,
      categoryLabel: CATEGORY_LABELS[category] || category,
    }))
  } catch {
    return []
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * PWA Onboarding + Donation Trigger.
 *
 * Article-based personalization quiz shown on first launch in the installed
 * PWA (standalone mode only):
 *
 *  1. Fetches 22 fresh articles from multiple categories (world, politics,
 *     business, tech, science, health, sports, relevant, top/mycountry + 4
 *     more from random categories).
 *  2. Step 1 — "Select all news that interests you": user taps cards to
 *     mark liked stories. Sectors are detected from each liked article's
 *     title/summary and added to the user's interests.
 *  3. Step 2 — "Select news you don't want to see": user taps cards to mark
 *     disliked stories. Each disliked article triggers a negative-engagement
 *     bump (bumpEngagementForTopic with reason='dislike').
 *  4. On completion: interests saved to localStorage + Firebase,
 *     ONBOARDED_KEY set to 'true', and 'neutralwire:interests-changed'
 *     event dispatched.
 *
 * Also tracks how many news articles the user opens over time and shows a
 * donation popup (Ko-fi) after the 10th article, doubling the threshold on
 * each dismissal (10 → 20 → 40 → 80). If the user donates, the popup is
 * suppressed for 3 months.
 */
export function PwaOnboarding() {
  const [showOnboarding, setShowOnboarding] = React.useState(false)
  const [showDonate, setShowDonate] = React.useState(false)

  // Quiz state
  const [step, setStep] = React.useState<'loading' | 'likes' | 'dislikes'>('loading')
  const [articles, setArticles] = React.useState<QuizArticle[]>([])
  const [likedIds, setLikedIds] = React.useState<Set<string>>(new Set())
  const [dislikedIds, setDislikedIds] = React.useState<Set<string>>(new Set())
  const [fetchError, setFetchError] = React.useState<string>('')

  React.useEffect(() => {
    // Only in PWA (standalone mode)
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    if (!isStandalone) return

    // Check if onboarded (completed the quiz) OR recently dismissed
    const onboarded = localStorage.getItem(ONBOARDED_KEY)
    const dismissedAt = localStorage.getItem(ONBOARDING_DISMISSED_KEY)
    const dismissedRecently =
      dismissedAt && Date.now() - parseInt(dismissedAt, 10) < ONBOARDING_DISMISS_DURATION
    if (!onboarded && !dismissedRecently) {
      setTimeout(() => setShowOnboarding(true), 1500)
    }

    // ── Donation popup check ──
    // Triggered when the user has opened enough news articles.
    const checkDonationPopup = (articlesOpened: number) => {
      const pressed = localStorage.getItem(DONATE_PRESSED_KEY) === 'true'
      const shownAt = parseInt(localStorage.getItem(DONATE_SHOWN_KEY) || '0', 10)
      let nextThreshold = parseInt(localStorage.getItem(DONATE_NEXT_KEY) || '0', 10)

      // If pressed (donated), wait 3 months before showing again
      if (pressed) {
        const threeMonths = 90 * 24 * 60 * 60 * 1000
        if (Date.now() - shownAt > threeMonths) {
          localStorage.setItem(DONATE_PRESSED_KEY, 'false')
          localStorage.setItem(DONATE_NEXT_KEY, '0')
          setShowDonate(true)
        }
        return
      }

      // First time: show after 10 articles
      if (nextThreshold === 0) nextThreshold = INITIAL_THRESHOLD

      // Show if articles opened exceeds the threshold
      if (articlesOpened >= nextThreshold) {
        setShowDonate(true)
      }
    }

    // ── Article-open counter ──
    // Incremented every time the user opens a news article (TopicDetail).
    const handleTopicOpened = () => {
      let count = parseInt(localStorage.getItem(ARTICLES_OPENED_KEY) || '0', 10)
      count += 1
      localStorage.setItem(ARTICLES_OPENED_KEY, String(count))
      checkDonationPopup(count)
    }

    window.addEventListener('neutralwire:topic-opened', handleTopicOpened)

    return () => {
      window.removeEventListener('neutralwire:topic-opened', handleTopicOpened)
    }
  }, [])

  // ── Fetch quiz articles when onboarding opens ──
  React.useEffect(() => {
    if (!showOnboarding) return
    if (articles.length > 0) return // already fetched
    let cancelled = false
    setStep('loading')
    setFetchError('')

    void (async () => {
      try {
        const country = getDetectedCountry()

        // Primary fetches: all subtopic categories EXCEPT 'relevant'
        // (relevant is a mix — the quiz uses actual subtopics to
        // customize the relevant feed and notifications).
        // Base: world, politics, business, tech, science, health, sports, top
        const primaryCategories = [...QUIZ_BASE_CATEGORIES]
        // Add mycountry if country is detected
        if (country) {
          primaryCategories.push('mycountry')
        }
        // Add blindspots
        primaryCategories.push('blindspots')

        const primaryResults = await Promise.all(
          primaryCategories.map((cat) => fetchCategoryArticles(cat, country, 2, 0)),
        )

        // Random extras: fetch more articles from random categories
        // (with offset=2 to avoid duplicating) until we have ~22 total.
        const randomPool = [...primaryCategories]
        const pickedRandom = new Set<string>()
        const randomCats: string[] = []
        let safety = 0
        while (randomCats.length < 3 && pickedRandom.size < randomPool.length && safety < 20) {
          safety++
          const idx = Math.floor(Math.random() * randomPool.length)
          const cat = randomPool[idx]
          if (pickedRandom.has(cat)) continue
          pickedRandom.add(cat)
          randomCats.push(cat)
        }
        const randomResults = await Promise.all(
          randomCats.map((cat) => fetchCategoryArticles(cat, country, 2, 2)),
        )

        // Combine + dedupe by topicId (same story can appear in multiple cats)
        const all = [...primaryResults.flat(), ...randomResults.flat()]
        const seen = new Set<string>()
        const unique: QuizArticle[] = []
        for (const a of all) {
          if (!a?.topicId) continue
          if (seen.has(a.topicId)) continue
          seen.add(a.topicId)
          unique.push(a)
        }

        // Sort by "most likely to interest":
        //   world/politics first → business/tech → science/health/sports → rest
        // Within the same priority group, sort by coverage (desc).
        unique.sort((a, b) => {
          const pa = CATEGORY_PRIORITY[a.category] ?? 3
          const pb = CATEGORY_PRIORITY[b.category] ?? 3
          if (pa !== pb) return pa - pb
          return b.coverage - a.coverage
        })

        if (cancelled) return
        setArticles(unique)
        setStep('likes')
      } catch (err) {
        if (!cancelled) {
          setFetchError(err instanceof Error ? err.message : String(err))
          setStep('likes')
          setArticles([])
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [showOnboarding, articles.length])

  const toggleLike = (id: string) => {
    setLikedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleDislike = (id: string) => {
    setDislikedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleOnboardingComplete = async () => {
    // Build new interests = existing ∪ detected sectors from liked articles.
    // Existing interests are preserved so re-running the quiz doesn't wipe
    // previous selections.
    const likedArticles = articles.filter((a) => likedIds.has(a.topicId))
    const dislikedArticles = articles.filter((a) => dislikedIds.has(a.topicId))

    const validSectorIds = new Set<string>(SECTORS.map((s) => s.id))
    const newInterests = new Set<string>()
    try {
      const saved = localStorage.getItem('neutralwire:interests')
      if (saved) {
        const parsed = JSON.parse(saved) as string[]
        for (const s of parsed) newInterests.add(s)
      }
    } catch {
      /* ignore */
    }
    for (const a of likedArticles) {
      const sectors = detectSectors(a.title, a.summary)
      for (const s of sectors) {
        // Only add sectors that are part of our canonical SECTORS list
        // (defensive — detectSectors already only returns valid IDs).
        if (validSectorIds.has(s)) newInterests.add(s)
      }
    }

    const sectorsArray = Array.from(newInterests)
    localStorage.setItem(ONBOARDED_KEY, 'true')
    setInterestsLocal(sectorsArray)
    setShowOnboarding(false)

    const deviceId = typeof window !== 'undefined' ? getDeviceId() : ''
    if (deviceId) {
      syncInterestsWithFirebase(deviceId, sectorsArray).catch(() => {})
      // Record negative engagement for each disliked article.
      // bumpEngagementForTopic detects sectors internally and bumps each
      // by -15 (reason='dislike').
      for (const a of dislikedArticles) {
        bumpEngagementForTopic(deviceId, a.title, a.summary, 'dislike').catch(() => {})
      }
    }

    window.dispatchEvent(new CustomEvent('neutralwire:interests-changed'))
  }

  const handleDismiss = () => {
    setShowOnboarding(false)
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, String(Date.now()))
  }

  const handleDonatePress = () => {
    localStorage.setItem(DONATE_PRESSED_KEY, 'true')
    localStorage.setItem(DONATE_SHOWN_KEY, String(Date.now()))
    localStorage.setItem(DONATE_NEXT_KEY, '0')
    setShowDonate(false)
    window.open('https://ko-fi.com/neutralwire', '_blank')
  }

  const handleDonateDismiss = () => {
    const currentThreshold = parseInt(localStorage.getItem(DONATE_NEXT_KEY) || '0', 10)
    // Double the threshold: 10 → 20 → 40 → 80 → 160...
    const newThreshold =
      currentThreshold === 0 ? INITIAL_THRESHOLD * 2 : currentThreshold * 2
    localStorage.setItem(DONATE_NEXT_KEY, String(newThreshold))
    localStorage.setItem(DONATE_SHOWN_KEY, String(Date.now()))
    setShowDonate(false)
  }

  // ── Onboarding popup (article-based quiz) ──
  if (showOnboarding) {
    const selectedSet = step === 'likes' ? likedIds : dislikedIds
    return (
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-3 sm:p-4"
        role="dialog"
        aria-modal="true"
        aria-label="Personalize your news feed"
      >
        <div className="flex max-h-[92vh] w-full max-w-2xl flex-col rounded-2xl bg-background shadow-2xl">
          {/* Header */}
          <div className="flex items-start justify-between gap-3 border-b border-border p-4 sm:p-6">
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-bold sm:text-lg">
                {step === 'likes'
                  ? 'Select all news that interests you'
                  : step === 'dislikes'
                    ? "Select news you don't want to see"
                    : 'Welcome to NeutralWire'}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
                {step === 'likes'
                  ? 'Tap stories you want to see more of — we’ll personalize your feed.'
                  : step === 'dislikes'
                    ? 'Tap stories you’d rather not see — we’ll push them down.'
                    : 'Fetching fresh stories for you…'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {step === 'dislikes' && (
                <button
                  onClick={() => setStep('likes')}
                  className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  ← Back
                </button>
              )}
              <button
                onClick={handleDismiss}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Dismiss onboarding"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Body */}
          {step === 'loading' ? (
            <div className="flex flex-col items-center justify-center gap-3 p-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Fetching fresh stories for you…
              </p>
            </div>
          ) : articles.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
              <p className="text-sm text-muted-foreground">
                {fetchError
                  ? 'Could not load stories. Please try again later.'
                  : 'No stories available right now.'}
              </p>
              <Button onClick={handleOnboardingComplete} variant="outline" size="sm">
                Skip for now
              </Button>
            </div>
          ) : (
            <div className="flex flex-1 flex-col overflow-hidden p-4 sm:p-6">
              {/* Step indicator + selection count */}
              <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <span
                    className={
                      step === 'likes'
                        ? 'font-semibold text-foreground'
                        : ''
                    }
                  >
                    1. Interests
                  </span>
                  <span aria-hidden>→</span>
                  <span
                    className={
                      step === 'dislikes'
                        ? 'font-semibold text-foreground'
                        : ''
                    }
                  >
                    2. Avoid
                  </span>
                </div>
                <span className="tabular-nums">
                  {selectedSet.size} selected
                </span>
              </div>

              {/* Scrollable article grid */}
              <div
                className="quiz-scroll max-h-[70vh] -mr-1 overflow-y-auto pr-1
                  [scrollbar-width:thin]
                  [&::-webkit-scrollbar]:w-2
                  [&::-webkit-scrollbar-track]:bg-transparent
                  [&::-webkit-scrollbar-thumb]:rounded-full
                  [&::-webkit-scrollbar-thumb]:bg-muted-foreground/30
                  [&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/50"
              >
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
                  {articles.map((article, idx) => {
                    const isSelected = selectedSet.has(article.topicId)
                    return (
                      <motion.button
                        key={article.topicId}
                        type="button"
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{
                          duration: 0.25,
                          delay: Math.min(idx * 0.025, 0.4),
                          ease: 'easeOut',
                        }}
                        onClick={() =>
                          step === 'likes'
                            ? toggleLike(article.topicId)
                            : toggleDislike(article.topicId)
                        }
                        aria-pressed={isSelected}
                        aria-label={`${isSelected ? 'Deselect' : 'Select'}: ${article.title}`}
                        className={`relative overflow-hidden rounded-xl border text-left transition-all ${
                          isSelected
                            ? 'border-foreground bg-foreground/5 ring-2 ring-foreground'
                            : 'border-border hover:bg-muted hover:border-foreground/30'
                        }`}
                      >
                        {/* Image thumbnail (or muted placeholder if none) */}
                        {article.imageUrl ? (
                          <div className="aspect-[16/9] w-full overflow-hidden bg-muted">
                            <img
                              src={`/api/img?url=${encodeURIComponent(article.imageUrl)}`}
                              alt=""
                              loading="lazy"
                              className="h-full w-full object-cover"
                              onError={(e) => {
                                // Hide broken images — the parent placeholder bg shows through.
                                (e.currentTarget as HTMLImageElement).style.display = 'none'
                              }}
                            />
                          </div>
                        ) : (
                          <div className="flex aspect-[16/9] w-full items-center justify-center bg-muted">
                            <ImageIcon className="h-6 w-6 text-muted-foreground/40" />
                          </div>
                        )}

                        {/* Content: badges + title */}
                        <div className="p-2.5">
                          <div className="mb-1.5 flex items-center gap-1.5">
                            <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              {article.categoryLabel}
                            </span>
                            <span className="text-[10px] text-muted-foreground tabular-nums">
                              {article.coverage} {article.coverage === 1 ? 'source' : 'sources'}
                            </span>
                          </div>
                          <p className="line-clamp-3 text-xs font-medium leading-snug sm:text-sm">
                            {article.title}
                          </p>
                        </div>

                        {/* Selected indicator */}
                        {isSelected && (
                          <div
                            className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-background shadow-sm"
                            aria-hidden
                          >
                            {step === 'likes' ? (
                              <Check className="h-3 w-3" />
                            ) : (
                              <ThumbsDown className="h-3 w-3" />
                            )}
                          </div>
                        )}
                      </motion.button>
                    )
                  })}
                </div>
              </div>

              {/* Footer action */}
              <div className="mt-3 border-t border-border pt-3">
                {step === 'likes' ? (
                  <Button
                    onClick={() => setStep('dislikes')}
                    className="w-full"
                    // Enabled even if nothing selected — dislikes step is next.
                  >
                    {likedIds.size === 0
                      ? 'Continue'
                      : `Continue · ${likedIds.size} selected`}
                  </Button>
                ) : (
                  <Button onClick={handleOnboardingComplete} className="w-full">
                    Done — show me my news
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Donation popup ──
  if (showDonate) {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
        <div className="w-full max-w-sm rounded-2xl bg-background p-6 text-center shadow-2xl">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-r from-pink-500 to-red-500">
            <Heart className="h-7 w-7 fill-white text-white" />
          </div>
          <h2 className="mb-2 text-lg font-bold">Support NeutralWire</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            NeutralWire is built by a 15-year-old working alone, for free. If it&apos;s been useful, consider buying him a coffee. Every bit helps keep the servers running.
          </p>
          <div className="flex flex-col gap-2">
            <Button
              onClick={handleDonatePress}
              className="w-full bg-gradient-to-r from-pink-500 to-red-500 text-white hover:opacity-90"
            >
              <Heart className="mr-2 h-4 w-4 fill-white" /> Donate on Ko-fi
            </Button>
            <Button
              onClick={handleDonateDismiss}
              variant="ghost"
              className="w-full text-xs text-muted-foreground"
            >
              Maybe later
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return null
}
