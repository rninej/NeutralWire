'use client'

import * as React from 'react'
import { AnimatePresence, motion } from 'framer-motion'
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
  MessageCircle,
  Send,
  ThumbsUp,
  ThumbsDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { BiasBar } from '@/components/bias-bar'
import { cn } from '@/lib/utils'
import type { TopicArticle } from '@/lib/news-aggregator'
import { getDeviceId } from '@/lib/referral'
import { bumpEngagementForTopic } from '@/lib/user-interests'
import { getRating } from '@/lib/source-ratings'

interface TopicDetailProps {
  topic: TopicArticle
  onClose: () => void
}

const LEANING_BADGE: Record<string, { label: string; cls: string }> = {
  left: { label: 'Left', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300' },
  center: { label: 'Center', cls: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300' },
  right: { label: 'Right', cls: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' },
}

/**
 * Format a timestamp as a fixed date/time string.
 * Shows 'Mon 24 Jul, 14:30' — doesn't change between renders.
 */
function formatTime(ms: number): string {
  const d = new Date(ms)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const day = days[d.getDay()]
  const date = d.getDate()
  const month = months[d.getMonth()]
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${day} ${date} ${month}, ${hh}:${mm}`
}

export function TopicDetail({ topic, onClose }: TopicDetailProps) {
  const [summary, setSummary] = React.useState<string | null>(null)
  const [summaryLoading, setSummaryLoading] = React.useState(true)
  const [summaryError, setSummaryError] = React.useState<string | null>(null)
  const [shared, setShared] = React.useState(false)
  const [imgError, setImgError] = React.useState(false)
  const [askAiOpen, setAskAiOpen] = React.useState(false)
  // Like/dislike state: null = no vote, 'liked' = thumbs up, 'disliked' = thumbs down
  const [likeState, setLikeState] = React.useState<'liked' | 'disliked' | null>(null)
  // Full topic fetched from /api/topic/[id] — used when the slim feed
  // response (slim=1) strips the articles array. This guarantees the
  // "All Sources" section always has articles to show.
  const [displayTopic, setDisplayTopic] = React.useState<TopicArticle | null>(null)
  // ── Sticky Ask AI button ──
  // The "Ask AI" button lives inside the Neutral Summary card. When the
  // user scrolls past it (it goes above the top bar), we show a compact
  // Ask AI button in the sticky top bar (between Close and Share) so
  // it's always accessible.
  //
  // We track the ORIGINAL Ask AI button's position (not the whole card)
  // so the sticky appears the moment the button scrolls off-screen —
  // not after the entire summary card has passed.
  const [askAiSticky, setAskAiSticky] = React.useState(false)
  const askAiButtonRef = React.useRef<HTMLButtonElement | null>(null)

  // ── Like/dislike persistence ──
  // Load saved vote from localStorage on mount (instant, no Firebase read needed).
  // Also save to Firebase so it syncs across devices.
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem(`neutralwire:vote:${topic.topicId}`)
      if (saved === 'liked' || saved === 'disliked') {
        setLikeState(saved)
      } else {
        setLikeState(null)
      }
    } catch {
      // silent
    }
  }, [topic.topicId])

  const saveVote = (vote: 'liked' | 'disliked' | null) => {
    // Save to localStorage (instant, survives reload)
    try {
      if (vote === null) {
        localStorage.removeItem(`neutralwire:vote:${topic.topicId}`)
      } else {
        localStorage.setItem(`neutralwire:vote:${topic.topicId}`, vote)
      }
    } catch {
      // silent
    }
    // Also save to Firebase (syncs across devices) — fire and forget
    const deviceId = getDeviceId()
    if (deviceId) {
      fetch('/api/engagement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'topicVote',
          deviceId,
          topicId: topic.topicId,
          vote,
        }),
      }).catch(() => {})
    }
  }
  // Only render time after mount — formatTime() is timezone-dependent and
  // would cause hydration mismatch (server uses UTC, client uses local TZ).
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

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

    // Notify the PWA install prompt that a topic was opened. On mobile
    // this triggers the install popup (high-conversion moment — user is
    // engaged with a specific story).
    window.dispatchEvent(new CustomEvent('neutralwire:topic-opened'))

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

  // ── Sticky Ask AI: detect when the original Ask AI button scrolls off ──
  // The moment the Ask AI button's top edge goes above the sticky top bar
  // (h-14 = 56px), we show the compact Ask AI button in the top bar.
  // This triggers as soon as the button leaves the viewport, NOT after
  // the entire summary card has scrolled past (which was the old behavior
  // that required scrolling to the bottom of the card).
  React.useEffect(() => {
    const container = document.querySelector('[role="dialog"]') as HTMLElement | null
    if (!container) return
    const onScroll = () => {
      const btn = askAiButtonRef.current
      if (!btn) {
        setAskAiSticky(false)
        return
      }
      // If the button's top edge is above the top bar (56px), it's
      // scrolled out of view → show the sticky button.
      const rect = btn.getBoundingClientRect()
      setAskAiSticky(rect.bottom < 56)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => {
      container.removeEventListener('scroll', onScroll)
      window.removeEventListener('scroll', onScroll)
    }
  }, [topic.topicId])

  // ── Fetch the FULL topic (with articles) from /api/topic/[id] ──
  // The slim feed response (slim=1) strips the articles array to save
  // bandwidth. Without this fetch, the "All Sources" section would be
  // empty even though topic.coverage says there are sources — which was
  // the "sources not showing" bug.
  //
  // We fetch when:
  //  - articles is missing/empty (slim response), OR
  //  - articles length doesn't match coverage (partial/stale data)
  // Otherwise the topic already has its articles (e.g. opened from
  // archive or a non-slim fetch) and we skip the extra request.
  React.useEffect(() => {
    let cancelled = false
    const articleCount = Array.isArray(topic.articles) ? topic.articles.length : 0
    const needsFetch = articleCount === 0 || (topic.coverage > 0 && articleCount < topic.coverage)
    if (!needsFetch) {
      // Already have full articles — use them directly.
      setDisplayTopic(null)
      return
    }
    ;(async () => {
      try {
        const res = await fetch(`/api/topic/${encodeURIComponent(topic.topicId)}`)
        if (!res.ok) return
        const data = await res.json()
        if (cancelled || !data.topic) return
        // Only update if the fetched topic actually has articles —
        // otherwise we gain nothing and might overwrite good data.
        if (Array.isArray(data.topic.articles) && data.topic.articles.length > 0) {
          setDisplayTopic(data.topic as TopicArticle)
        }
      } catch {
        // silent — fall back to topic.articles
      }
    })()
    return () => {
      cancelled = true
    }
  }, [topic.topicId, topic.articles, topic.coverage])

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
            // Send the topic's own summary as a fallback context for when
            // articles is empty (e.g. topic loaded from archive without
            // the full articles array).
            topicSummary: topic.summary || '',
            articles: (topic.articles || []).map((a) => ({
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
    // Share ONLY the URL — no title, no summary text.
    // Some apps (WhatsApp, Messages) append the `text` field to the URL
    // which looks messy. Sending just the URL keeps shares clean.
    const shareUrl = `${window.location.origin}/?topic=${topic.topicId}`
    const shareData = {
      title: 'NeutralWire',
      url: shareUrl,
      // No `text` field — only the URL gets shared
    }
    // Track engagement: sharing is a strong signal (+15 per sector)
    const deviceId = getDeviceId()
    if (deviceId) {
      bumpEngagementForTopic(deviceId, topic.title, topic.summary || '', 'share').catch(() => {})
    }
    try {
      if (navigator.share) {
        await navigator.share(shareData)
      } else {
        // Clipboard fallback — also just the URL, no title/text
        await navigator.clipboard.writeText(shareUrl)
        setShared(true)
        setTimeout(() => setShared(false), 2000)
      }
    } catch {
      // User cancelled or clipboard failed — silent.
    }
  }

  const handleLike = () => {
    const newVote = likeState === 'liked' ? null : 'liked'
    setLikeState(newVote)
    saveVote(newVote)
    const deviceId = getDeviceId()
    if (deviceId && newVote === 'liked') {
      bumpEngagementForTopic(deviceId, topic.title, topic.summary || '', 'like').catch(() => {})
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('neutralwire:engagement-changed'))
      }, 300)
    }
  }

  const handleDislike = () => {
    const newVote = likeState === 'disliked' ? null : 'disliked'
    setLikeState(newVote)
    saveVote(newVote)
    const deviceId = getDeviceId()
    if (deviceId && newVote === 'disliked') {
      bumpEngagementForTopic(deviceId, topic.title, topic.summary || '', 'dislike').catch(() => {})
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('neutralwire:engagement-changed'))
      }, 300)
      // ── Dynamic country-news count ──
      // If the user disliked a GDELT-sourced country story (topicId starts
      // with 'g'), decrease the count of country stories to show in Relevant
      // (min 0). This adapts the mix — disliking country stories → fewer appear.
      if (topic.topicId.startsWith('g')) {
        import('@/lib/user-interests').then(({ bumpCountryNewsCount }) => {
          const newCount = bumpCountryNewsCount(-1)
          window.dispatchEvent(new CustomEvent('neutralwire:engagement-changed'))
          return newCount
        }).catch(() => {})
      }
    }
  }

  const total = topic.leanLeft + topic.leanCenter + topic.leanRight
  const showImage = topic.imageUrl && !imgError

  // Use displayTopic's articles (fetched from /api/topic/[id] if the slim
  // feed response didn't include them). This prevents the "sources not
  // showing" bug where the slim response stripped the articles array.
  // displayTopic may be null if the fetch hasn't completed or wasn't needed.
  const articles = displayTopic?.articles || topic.articles || []

  // Group articles by leaning for display.
  const leftArticles = articles.filter((a) => a.leaning === 'left')
  const centerArticles = articles.filter((a) => a.leaning === 'center')
  const rightArticles = articles.filter((a) => a.leaning === 'right')

  return (
    <motion.div
      className="fixed inset-0 z-50 overflow-y-auto bg-background"
      role="dialog"
      aria-modal="true"
      aria-label={topic.title}
      initial={{ opacity: 0, y: 40 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 40 }}
      transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
    >
      {/* Sticky top bar: Close (left) | right group (ml-auto) → like/dislike + Share + Ask AI(sticky) */}
      <div className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
        <Button variant="ghost" size="sm" onClick={onClose} className="gap-1.5 flex-shrink-0">
          <X className="h-4 w-4" />
          <span className="hidden sm:inline">Close</span>
        </Button>

        {/* Right group: like/dislike + Share + sticky Ask AI.
            Uses ml-auto so the whole group sits on the RIGHT side of the
            bar. When the sticky Ask AI button appears (on scroll), it
            slides in to the LEFT of the like/share group — the group
            shifts left just enough to make room, not all the way left. */}
        <div className="ml-auto flex items-center gap-2">
          {/* ── Sticky Ask AI button ──
              Sits to the LEFT of like/share (inside the right group).
              Appears ONLY when the user scrolls past the original Ask AI
              button. Fades + slides in from the right. */}
          <div
            className={`overflow-hidden transition-all duration-300 flex-shrink-0 ${
              askAiSticky ? 'max-w-32 opacity-100' : 'max-w-0 opacity-0'
            }`}
          >
            <button
              type="button"
              onClick={() => setAskAiOpen(true)}
              className="flex items-center gap-1.5 rounded-full p-[2px] bg-gradient-to-r from-purple-500 via-blue-500 to-cyan-400 hover:opacity-90 transition-opacity whitespace-nowrap"
              aria-label="Ask AI about this story"
            >
              <span className="flex items-center gap-1.5 rounded-full bg-background px-3 py-1.5 text-xs font-semibold">
                <MessageCircle className="h-3.5 w-3.5 text-purple-500" />
                <span>Ask AI</span>
              </span>
            </button>
          </div>

          {/* Like + Dislike buttons */}
          <div className="flex items-center gap-1 rounded-full border bg-muted/40 p-0.5">
            <motion.button
              type="button"
              onClick={handleLike}
              whileTap={{ scale: 1.2 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                likeState === 'liked'
                  ? 'bg-emerald-500 text-white'
                  : 'text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-600'
              }`}
              aria-label="Interested in this story"
              title="Interested — more stories like this"
            >
              <ThumbsUp className="h-4 w-4" />
            </motion.button>
            <motion.button
              type="button"
              onClick={handleDislike}
              whileTap={{ scale: 1.2 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                likeState === 'disliked'
                  ? 'bg-rose-500 text-white'
                  : 'text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600'
              }`}
              aria-label="Not interested in this story"
              title="Not interested — fewer stories like this"
            >
              <ThumbsDown className="h-4 w-4" />
            </motion.button>
          </div>
          <button
            type="button"
            onClick={handleShare}
            // Different gradient from the Ask AI button (which is
            // purple→blue→cyan). Share uses amber→orange→rose so the two
            // CTAs are visually distinct.
            className="flex items-center gap-1.5 rounded-full p-[2px] bg-gradient-to-r from-amber-400 via-orange-500 to-rose-500 hover:opacity-90 transition-opacity shadow-sm"
            aria-label="Share this story"
          >
            <span className="flex items-center gap-1.5 rounded-full bg-background px-4 py-1.5 text-xs font-semibold">
              <AnimatePresence mode="wait" initial={false}>
                {shared ? (
                  <motion.span
                    key="copied"
                    initial={{ scale: 0, rotate: -90, opacity: 0 }}
                    animate={{ scale: 1, rotate: 0, opacity: 1 }}
                    exit={{ scale: 0, rotate: 90, opacity: 0 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    className="flex items-center gap-1.5"
                  >
                    <Check className="h-3.5 w-3.5 text-emerald-500" />
                    <span>Copied!</span>
                  </motion.span>
                ) : (
                  <motion.span
                    key="share"
                    initial={{ scale: 0, rotate: 90, opacity: 0 }}
                    animate={{ scale: 1, rotate: 0, opacity: 1 }}
                    exit={{ scale: 0, rotate: -90, opacity: 0 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    className="flex items-center gap-1.5"
                  >
                    <Share2 className="h-3.5 w-3.5 text-orange-500" />
                    {/* Show "Share" on ALL viewports (mobile + desktop) */}
                    <span>Share</span>
                  </motion.span>
                )}
              </AnimatePresence>
            </span>
          </button>
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-4 py-6">
        {/* Header */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="text-[10px]">
            {topic.coverage} {topic.coverage === 1 ? 'source' : 'sources'}
          </Badge>
          <span className="inline-flex items-center gap-1 text-sm font-medium text-foreground">
            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            {mounted ? formatTime(topic.latestSeen) : ""}
          </span>
          {topic.localCoverage && topic.localCoverage > 0 && (
            <Badge variant="outline" className="text-[10px]">
              {topic.localCoverage} local
            </Badge>
          )}
          {/* View sources button — on the right of the date/time */}
          <button
            type="button"
            onClick={() => {
              const sourcesEl = document.getElementById('all-sources')
              if (sourcesEl) {
                sourcesEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            }}
            className="ml-auto text-xs font-medium text-foreground underline-offset-2 hover:underline"
          >
            View sources
          </button>
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
            <button
              ref={askAiButtonRef}
              onClick={() => setAskAiOpen(true)}
              className="ml-auto flex items-center gap-1.5 rounded-full p-[2px] bg-gradient-to-r from-purple-500 via-blue-500 to-cyan-400 hover:opacity-90 transition-opacity"
            >
              <span className="flex items-center gap-1.5 rounded-full bg-background px-4 py-1.5 text-xs font-semibold">
                <MessageCircle className="h-3.5 w-3.5 text-purple-500" />
                Ask AI
              </span>
            </button>
          </div>
          {summaryLoading ? (
            <SummarySkeleton />
          ) : summaryError ? (
            <div className="flex items-center gap-2 py-4 text-base text-muted-foreground">
              <AlertCircle className="h-5 w-5" />
              Could not generate summary. Showing original descriptions below.
            </div>
          ) : (
            <motion.div
              className="space-y-4 text-base leading-relaxed text-foreground/90 md:text-[17px] md:leading-[1.7]"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
            >
              {(() => {
                // The LLM may use \n\n or \n between heading and paragraph.
                // Normalise: split on \n\n first, then within each chunk,
                // if it starts with a known heading pattern, split that off.
                const knownHeadings = [
                  'The Big Picture', 'Why It Matters',
                  'How Different Outlets Are Covering It',
                  'What Happens Next',
                  'What Happened', 'The Context', 'Background',
                  'Different Perspectives', 'Reactions',
                  'Why It Matters', 'Key Facts', 'Analysis', 'Impact',
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
            </motion.div>
          )}
        </Card>

        {/* Sources grouped by leaning */}
        <div id="all-sources" className="space-y-4 scroll-mt-20">
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

      {/* Ask AI panel */}
      {askAiOpen && (
        <AskAiPanel
          topic={topic}
          summary={summary}
          onClose={() => setAskAiOpen(false)}
        />
      )}
    </motion.div>
  )
}

// ── Ask AI Panel ──
function AskAiPanel({
  topic,
  summary,
  onClose,
}: {
  topic: TopicArticle
  summary: string | null
  onClose: () => void
}) {
  const [messages, setMessages] = React.useState<Array<{ role: 'user' | 'assistant'; content: string; model?: string }>>([])
  const [input, setInput] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [debugMode, setDebugMode] = React.useState(false)

  const handleSend = async () => {
    const question = input.trim()
    if (!question || loading) return

    // Check for debug mode toggle
    if (question.toLowerCase() === 'advityaisland') {
      setDebugMode((v) => !v)
      setInput('')
      setMessages((m) => [...m, { role: 'assistant', content: debugMode ? 'Debug mode OFF.' : 'Debug mode ON. You will now see which AI model answers each message.' }])
      return
    }

    setInput('')
    setMessages((m) => [...m, { role: 'user', content: question }])
    setLoading(true)

    // Track engagement: asking AI is a strong interest signal (+10)
    const deviceId = getDeviceId()
    if (deviceId) {
      bumpEngagementForTopic(deviceId, topic.title, topic.summary || '', 'ai').catch(() => {})
      // Notify the news page to refresh its engagement cache
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('neutralwire:engagement-changed'))
      }, 300)
    }

    // Compulsory 1.5s loading delay
    const minDelay = new Promise((resolve) => setTimeout(resolve, 1500))

    try {
      // Client-side timeout: 12s (slightly above server's 10s maxDuration
      // so the server has time to return its own error JSON before we
      // give up).
      const controller = new AbortController()
      const clientTimeout = setTimeout(() => controller.abort(), 12000)

      const [_, res] = await Promise.all([
        minDelay,
        fetch('/api/ask-ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question,
            topicTitle: topic.title,
            topicSummary: summary || topic.summary || '',
            topicArticles: (topic.articles || []).map((a) => ({
              title: a.title,
              source: a.sourceName,
              leaning: a.leaning,
            })),
            debug: debugMode,
          }),
          signal: controller.signal,
        }),
      ])
      clearTimeout(clientTimeout)

      // Handle non-OK responses with a clear message instead of crashing
      if (!res.ok) {
        let errorMsg = 'The AI service is busy right now. Please try again.'
        try {
          const errData = await res.json()
          if (errData?.error) errorMsg = errData.error
        } catch {
          // Response wasn't JSON (probably Vercel's 504 HTML page)
          if (res.status === 504) {
            errorMsg = 'The AI took too long to respond. Please try a shorter question.'
          }
        }
        setMessages((m) => [...m, { role: 'assistant', content: errorMsg }])
        return
      }

      const data = await res.json()
      if (data.answer) {
        setMessages((m) => [...m, { role: 'assistant', content: data.answer, model: data.model }])
      } else {
        setMessages((m) => [...m, { role: 'assistant', content: data.error || 'Sorry, I could not answer that.', model: data.model }])
      }
    } catch (err) {
      // Distinguish abort (timeout) from real network errors
      const isAbort = err instanceof Error && err.name === 'AbortError'
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          content: isAbort
            ? 'The AI is taking too long to respond. Please try a shorter or simpler question.'
            : 'Connection error. Please check your internet and try again.',
        },
      ])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/20" onClick={onClose}>
      <div className="flex max-h-[50vh] w-full max-w-2xl flex-col rounded-t-2xl border-t-2 bg-background shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b p-4 pb-3">
            <MessageCircle className="h-4 w-4" />
            <span className="text-sm font-bold">Ask AI about this story</span>
            <button
              onClick={onClose}
              className="ml-auto text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
        </div>

        <div className="flex flex-1 flex-col overflow-hidden px-4 pt-4" style={{ minHeight: 0 }}>
          <div className="flex-1 space-y-3 overflow-y-auto pb-4" style={{ minHeight: 0 }}>
          {messages.length === 0 && (
            <div className="text-xs text-muted-foreground">
              Ask any question about this news story. The AI has access to
              the full article coverage and can search the web for context.
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i}>
              <div
                className={cn(
                  'rounded-lg p-3 text-sm',
                  msg.role === 'user'
                    ? 'bg-foreground text-background ml-auto max-w-[80%]'
                    : 'bg-muted max-w-[90%]',
                )}
              >
                {msg.content}
              </div>
              {debugMode && msg.model && msg.role === 'assistant' && (
                <div className="mt-1 ml-1 text-[10px] text-muted-foreground/60">
                  Model: {msg.model}
                </div>
              )}
            </div>
          ))}
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Searching and thinking...
            </div>
          )}
        </div>

        <div className="flex gap-2 pb-4" style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Ask about this story..."
            className="flex-1 rounded-full border bg-background px-4 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            disabled={loading}
          />
          <Button
            size="sm"
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="rounded-full"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
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
  // Only render time after mount — formatTime() is timezone-dependent and
  // would cause hydration mismatch (server uses UTC, client uses local TZ).
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

  return (
    <div>
      <div className={cn('mb-2 flex items-center gap-2 text-xs font-semibold uppercase', color)}>
        {label}
        <span className="text-muted-foreground">({count})</span>
      </div>
      <div className="space-y-2">
        {articles.map((a, i) => (
          <motion.a
            key={a.id}
            href={a.link}
            target="_blank"
            rel="noopener noreferrer"
            initial={{ opacity: 0, y: 8 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-20px' }}
            transition={{
              duration: 0.25,
              delay: Math.min(i * 0.04, 0.32),
              ease: 'easeOut',
            }}
            className="block rounded-lg border p-3 transition-colors hover:bg-muted/50"
          >
            <div className="line-clamp-2 text-sm font-medium leading-snug">
              {a.title}
            </div>
            <div className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
              <Globe className="h-2.5 w-2.5" />
              {/* Source name — clickable to show factuality rating popover.
                  Uses stopPropagation so clicking it doesn't open the article. */}
              <SourceNameWithRating sourceName={a.sourceName} sourceId={a.sourceId} />
              <span className="opacity-50">·</span>
              {a.country}
              <span className="opacity-50">·</span>
              {mounted ? formatTime(a.iso) : ""}
              <ExternalLink className="ml-auto h-2.5 w-2.5" />
            </div>
          </motion.a>
        ))}
      </div>
    </div>
  )
}

/**
 * Source name with a factuality rating popover.
 * Clicking the source name opens a small popover showing the MBFC
 * factuality score, ownership info, and a one-line explanation.
 * If the source isn't rated, shows "Unrated".
 *
 * Uses stopPropagation so the click doesn't trigger the parent <a> link.
 */
function SourceNameWithRating({
  sourceName,
  sourceId,
}: {
  sourceName: string
  sourceId: string
}) {
  const [open, setOpen] = React.useState(false)
  const popoverRef = React.useRef<HTMLDivElement | null>(null)

  // Close on outside click
  React.useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Look up the rating (client-side, from the static data file)
  const rating = React.useMemo(() => {
    // sourceId is the short name (e.g. "theguardian", "bbc")
    // sourceName is the display name (e.g. "The Guardian", "BBC")
    return getRating(sourceId) || getRating(sourceName)
  }, [sourceId, sourceName])

  return (
    <div ref={popoverRef} className="relative inline-block">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        className="font-medium text-foreground/80 hover:text-foreground hover:underline cursor-pointer"
      >
        {sourceName}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.96 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute bottom-full left-0 z-20 mb-2 w-64 rounded-lg border bg-popover p-3 shadow-lg"
          >
            <div className="mb-1.5 text-xs font-bold">{sourceName}</div>
            {rating ? (
              <>
                <div className="mb-1.5 flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Factuality:</span>
                  <span className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] font-bold border',
                    // Inline color logic (avoids extra import)
                    rating.factuality === 'Very High' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
                    : rating.factuality === 'High' ? 'bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30'
                    : rating.factuality === 'Mostly Factual' ? 'bg-lime-500/15 text-lime-600 dark:text-lime-400 border-lime-500/30'
                    : rating.factuality === 'Mixed' ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
                    : rating.factuality === 'Low' ? 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30'
                    : 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30'
                  )}>
                    {rating.factuality}
                  </span>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {rating.explanation}
                </p>
                {rating.ownership && (
                  <p className="mt-1.5 text-[10px] text-muted-foreground">
                    <span className="font-medium">Ownership:</span> {rating.ownership}
                  </p>
                )}
                <p className="mt-1.5 text-[9px] text-muted-foreground/60">
                  Source: Media Bias/Fact Check
                </p>
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                <span className="font-medium text-amber-600 dark:text-amber-400">Unrated</span>
                <br />
                No factuality data available for this source.
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Skeleton loader for the neutral summary ──
// Shimmer effect that looks like the network is loading content,
// while actually the AI is generating the summary in the background.
function SummarySkeleton() {
  return (
    <div className="space-y-4">
      {/* Fake heading */}
      <div className="space-y-2">
        <div className="h-4 w-32 animate-pulse rounded bg-muted" />
      </div>
      {/* Fake paragraph */}
      <div className="space-y-2">
        <div className="h-3 w-full animate-pulse rounded bg-muted" />
        <div className="h-3 w-full animate-pulse rounded bg-muted" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
      </div>
      {/* Fake heading */}
      <div className="space-y-2 pt-2">
        <div className="h-4 w-28 animate-pulse rounded bg-muted" />
      </div>
      {/* Fake paragraph */}
      <div className="space-y-2">
        <div className="h-3 w-full animate-pulse rounded bg-muted" />
        <div className="h-3 w-full animate-pulse rounded bg-muted" />
        <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
      </div>
      {/* Fake heading */}
      <div className="space-y-2 pt-2">
        <div className="h-4 w-36 animate-pulse rounded bg-muted" />
      </div>
      {/* Fake paragraph */}
      <div className="space-y-2">
        <div className="h-3 w-full animate-pulse rounded bg-muted" />
        <div className="h-3 w-5/6 animate-pulse rounded bg-muted" />
      </div>
    </div>
  )
}
