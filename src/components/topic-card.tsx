'use client'

import * as React from 'react'
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useTransform,
  useAnimationControls,
} from 'framer-motion'
import { Clock, ExternalLink, Globe, ThumbsDown, Share2, Check, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { BiasBar } from '@/components/bias-bar'
import type { TopicArticle } from '@/lib/news-aggregator'
import { getDeviceId } from '@/lib/referral'
import { bumpEngagementForTopic } from '@/lib/user-interests'

interface TopicCardProps {
  topic: TopicArticle
  variant?: 'default' | 'featured' | 'compact' | 'hero' | 'mini'
  defaultOpen?: boolean
  onOpenDetail?: (topic: TopicArticle) => void
  /** Called when the user swipes the card LEFT past the dismiss threshold
   *  (50% of the card width). When provided, enables horizontal
   *  drag-to-dismiss with a red glow + thumbs-down indicator behind the
   *  card. When undefined, the card is not draggable (used anywhere swipe
   *  isn't wanted, e.g. inside the topic detail overlay). */
  onDismiss?: (topic: TopicArticle) => void
  /** Index within its parent list — used to stagger entrance animations.
   *  Capped internally so long lists don't get a giant delay. */
  index?: number
}

// Shared easing curve for card entrances — smooth, slightly fast-out.
const EASE_OUT = [0.16, 1, 0.3, 1] as const

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

/**
 * NW brand watermark — a small dark chip with the NW logo icon (plus the
 * NEUTRALWIRE wordmark on larger images), pinned to the bottom-right of
 * card images. Mirrors the branding on generated share/notification images
 * (bias bar + NEUTRALWIRE banner) so cards, shares and notifications all
 * read as one brand. pointer-events-none — never blocks card clicks, and
 * it stays fixed while the image zooms underneath on hover (broadcast-
 * watermark behaviour).
 */
function NWMark({ withText = true }: { withText?: boolean }) {
  return (
    <div className="pointer-events-none absolute bottom-1.5 right-1.5 z-[1] flex items-center gap-1 rounded-md bg-black/55 py-[3px] pl-1 pr-1.5 backdrop-blur-[2px]">
      <img
        src="/icon-192.png"
        alt=""
        loading="lazy"
        decoding="async"
        className="h-3.5 w-3.5 rounded-[3px]"
      />
      {withText && (
        <span className="text-[8px] font-extrabold uppercase leading-none tracking-[0.14em] text-white">
          NeutralWire
        </span>
      )}
    </div>
  )
}

function TopicCard({ topic, variant = 'default', defaultOpen = false, onOpenDetail, onDismiss, index = 0 }: TopicCardProps) {
  // NOTE: this component is wrapped in React.memo at the bottom of the file.
  // Parent re-renders (search typing, engagement ticks, unrelated state)
  // no longer re-render every card in the feed — topic object identities
  // are stable across renders, and onOpenDetail/onDismiss are useCallback'd
  // in the parent, so memo comparison works as intended.
  // Sources are HIDDEN by default on ALL cards (including the featured
  // first card). Users tap "View sources" to expand. Previously the featured
  // card auto-opened its source list, which made the first news story look
  // different from the rest.
  const [open, setOpen] = React.useState(defaultOpen)
  // Articles fetched lazily the first time the user expands sources on a
  // slim-feed topic (feed responses strip articles to keep payloads small).
  const [fetchedArticles, setFetchedArticles] = React.useState<TopicArticle['articles'] | null>(null)
  const [sourcesLoading, setSourcesLoading] = React.useState(false)
  const fetchedRef = React.useRef(false)
  // "Copied" feedback for the share button (clipboard fallback only).
  const [shared, setShared] = React.useState(false)
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

  // ── Inline sources expansion ──
  // The list expands IN PLACE inside the card (the original, pre-popup
  // behaviour): no black backdrop, no body scroll lock, nothing that can
  // freeze the page. Slim feed topics arrive without articles, so we fetch
  // the full topic once on first expand and cache it in local state.
  const displayArticles =
    topic.articles && topic.articles.length > 0 ? topic.articles : fetchedArticles || []

  const toggleSources = () => {
    setOpen((v) => !v)
    if (
      !open &&
      !(topic.articles && topic.articles.length > 0) &&
      !fetchedRef.current
    ) {
      fetchedRef.current = true
      setSourcesLoading(true)
      fetch(`/api/topic/${encodeURIComponent(topic.topicId)}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d?.topic?.articles?.length) setFetchedArticles(d.topic.articles)
        })
        .catch(() => {})
        .finally(() => setSourcesLoading(false))
    }
  }

  // ── Share (same behaviour as the topic detail view) ──
  // Shares ONLY the URL — some apps append `text` to the URL which looks
  // messy. The link unfurls with the branded OG image (bias bar + NW).
  const handleShare = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const shareUrl = `${window.location.origin}/?topic=${topic.topicId}`
    // Sharing is a strong engagement signal for ranking
    const deviceId = getDeviceId()
    if (deviceId) {
      bumpEngagementForTopic(deviceId, topic.title, topic.summary || '', 'share').catch(() => {})
    }
    try {
      if (navigator.share) {
        await navigator.share({ title: 'NeutralWire', url: shareUrl })
      } else {
        await navigator.clipboard.writeText(shareUrl)
        setShared(true)
        setTimeout(() => setShared(false), 2000)
      }
    } catch {
      // user cancelled the share sheet — silent
    }
  }

  /** Small icon share button — sits to the RIGHT of the View sources
   *  button on every card variant. Shows a green check for 2s when the
   *  URL was copied to the clipboard (no Web Share API fallback). */
  const shareButton = (cls: string) => (
    <button
      type="button"
      onClick={handleShare}
      aria-label="Share this story"
      title="Share this story"
      className={cn(
        'inline-flex shrink-0 items-center font-medium text-foreground/70 transition-colors hover:text-foreground',
        cls,
      )}
    >
      {shared ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <Share2 className="h-3.5 w-3.5" />
      )}
    </button>
  )

  /** Inline sources list — expands/collapses in place with a smooth
   *  height animation (no overlay, no scroll lock — can't freeze). */
  const renderSourcesList = (innerCls: string) => (
    <motion.div
      key="sources"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.28, ease: EASE_OUT }}
      className="overflow-hidden"
    >
      <div className={innerCls}>
        {sourcesLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading sources…
          </div>
        ) : displayArticles.length === 0 ? (
          <p className="text-xs text-muted-foreground">No sources available for this story yet.</p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-md border">
            {displayArticles.slice(0, 12).map((a) => {
              const lean = LEANING_BADGE[a.leaning] || LEANING_BADGE.center
              return (
                <li key={a.id}>
                  <a
                    href={a.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-start gap-2 px-3 py-2 transition-colors hover:bg-muted/50"
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
                      <div className="line-clamp-2 text-xs font-medium leading-snug">{a.title}</div>
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
    </motion.div>
  )

  // ── Swipe-to-dismiss state ──
  // dragHappenedRef is set to true in onDragStart and reset (after a short
  // timeout) in onDragEnd. The card's onClick handler checks this ref so a
  // swipe doesn't also open the topic detail (the click event fires after
  // pointerup → dragend in the browser).
  const dragHappenedRef = React.useRef(false)
  // Live drag x position — drives the red glow opacity + thumbs-down scale.
  const dragX = useMotionValue(0)
  // Animation controls for the dismiss (slide off-screen) + snap-back spring.
  const dragControls = useAnimationControls()
  // Ref to the draggable card element — used to measure its width so the
  // 50% dismiss threshold is computed from the ACTUAL card width, not a guess.
  const dragCardRef = React.useRef<HTMLDivElement>(null)
  const cardWidthRef = React.useRef(0)

  // Glow opacity + thumbs-down opacity: 0 at rest → 1 at the dismiss
  // threshold (50% of card width). Capped at 1 so it doesn't keep growing
  // past the threshold.
  const glowOpacity = useTransform(dragX, (v) => {
    const threshold = (cardWidthRef.current || 300) * 0.5
    if (threshold <= 0) return 0
    return Math.min(Math.abs(v) / threshold, 1)
  })
  // Thumbs-down scale: 0.6 (small, just appearing) → 1.2 (full-size, popped)
  // as the user swipes from 0 to the threshold.
  const thumbScale = useTransform(dragX, (v) => {
    const threshold = (cardWidthRef.current || 300) * 0.5
    if (threshold <= 0) return 0.6
    const progress = Math.min(Math.abs(v) / threshold, 1)
    return 0.6 + progress * 0.6
  })

  const handleCardClick = (e: React.MouseEvent) => {
    // Don't open detail if the user clicked a link or button inside the card.
    const target = e.target as HTMLElement
    if (target.closest('a, button')) return
    // Don't open detail if this click came right after a drag (swipe).
    // The browser fires a click event after pointerup even when the user
    // was dragging — we suppress it so a swipe doesn't also open the detail.
    if (dragHappenedRef.current) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    onOpenDetail?.(topic)
  }

  const handleDragStart = () => {
    dragHappenedRef.current = true
    // Measure the card width NOW (lazily) so the threshold is based on the
    // actual rendered width, not a hardcoded guess. This matters because
    // cards have different widths (mini vs hero vs featured).
    if (dragCardRef.current) {
      cardWidthRef.current = dragCardRef.current.offsetWidth
    }
  }

  const handleDragEnd = async () => {
    const cardWidth = cardWidthRef.current || 300
    // HALF-SWIPE THRESHOLD: the user must drag the card at least 50% of its
    // width before the dismiss triggers. Before that, the card snaps back.
    // This prevents accidental swipes and card jitter on small movements.
    const threshold = cardWidth * 0.5
    const currentX = dragX.get()

    if (currentX < -threshold) {
      // Past threshold — animate the card off-screen to the left + fade out,
      // THEN call onDismiss. The await ensures the animation completes
      // before the parent removes the topic from state (which unmounts the
      // card). This gives a smooth exit animation rather than a sudden pop.
      await dragControls.start({
        x: -(cardWidth + 100),
        opacity: 0,
        transition: { duration: 0.25, ease: [0.4, 0, 1, 1] },
      })
      onDismiss?.(topic)
    } else {
      // Not past threshold — spring back to origin. The spring is stiffer
      // than the default so the snap-back feels snappy, not sluggish.
      dragControls.start({
        x: 0,
        transition: { type: 'spring', stiffness: 500, damping: 35 },
      })
    }
    // Reset the drag flag after a short delay — the click event fires
    // synchronously after dragend, so by the time this timeout runs, the
    // click has already been checked (and suppressed). 100ms is enough for
    // the browser to flush the click event.
    setTimeout(() => {
      dragHappenedRef.current = false
    }, 100)
  }

  // Stagger delay: cap so the last card in a long list isn't waiting seconds.
  // 0.03s per card — snappy spread that finishes within ~0.25s for the first
  // 10 cards. Combined with the 0.28s duration and small y offset (5px),
  // the entrance feels quick and premium — cards settle into place without
  // the feed feeling like it's slowly dripping in.
  const staggerDelay = Math.min(index * 0.03, 0.25)
  const cardMotion = {
    initial: { opacity: 0, y: 5 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.28, delay: staggerDelay, ease: EASE_OUT },
    // Hover lift: 1.02 scale + 2px translateY (via .card-lift CSS class).
    // The .card-lift class also adds a 0.25s transition for transform +
    // box-shadow so the lift + bias-tinted glow (from .card-glow) animate
    // in together smoothly.
    whileHover: onOpenDetail ? { scale: 1.015, y: -2 } : undefined,
    whileTap: onOpenDetail ? { scale: 0.985 } : undefined,
  }

  // ── Card hover glow (desktop only — see .card-glow CSS rule) ──
  // Compute the dominant leaning so we can tint the glow. Blue for left,
  // red for right, neutral grey for center. The actual hover effect is
  // driven by CSS — here we just expose the color as CSS variables on
  // the card's root motion.div.
  const dominantLean: 'left' | 'right' | 'center' =
    topic.leanLeft >= topic.leanRight && topic.leanLeft > topic.leanCenter
      ? 'left'
      : topic.leanRight >= topic.leanLeft && topic.leanRight > topic.leanCenter
        ? 'right'
        : 'center'
  const glowStyle: React.CSSProperties = {
    // Semi-transparent tint so the glow reads as a colored halo, not a
    // solid ring. The shadow uses the same color at higher opacity.
    ['--glow-color' as string]:
      dominantLean === 'left'
        ? 'rgb(59 130 246 / 0.35)' // blue-500/35
        : dominantLean === 'right'
          ? 'rgb(239 68 68 / 0.35)' // red-500/35
          : 'rgb(113 113 122 / 0.30)', // zinc-500/30
    ['--glow-shadow' as string]:
      dominantLean === 'left'
        ? 'rgb(59 130 246 / 0.20)'
        : dominantLean === 'right'
          ? 'rgb(239 68 68 / 0.20)'
          : 'rgb(113 113 122 / 0.18)',
  }

  /**
   * Wraps the card content with the swipe-to-dismiss UI.
   *
   * When `onDismiss` is undefined (e.g. inside the topic detail overlay),
   * this just renders the card in a plain motion.div — no drag, no glow,
   * no thumbs-down. The existing click-to-open behavior is fully preserved.
   *
   * When `onDismiss` is provided, the structure is:
   *   <motion.div>            ← outer grid item (entrance animation)
   *     <div class="relative"> ← positioning context for glow + icon
   *       <motion.div>         ← red glow background (opacity = swipe progress)
   *       <motion.div>         ← thumbs-down icon overlay (opacity = progress)
   *       <motion.div drag="x"> ← the draggable card itself
   *         {children}
   *       </motion.div>
   *     </div>
   *   </motion.div>
   *
   * The glow + thumbs-down are absolutely positioned BEHIND the card. As the
   * card slides left, the area to its right (previously covered) becomes
   * visible, revealing the red glow + thumbs-down.
   */
  const wrapWithSwipe = (content: React.ReactNode): React.ReactNode => {
    // No onDismiss → no swipe. Plain card, plain click. This preserves the
    // original behavior for any TopicCard used outside the main feed.
    if (!onDismiss) {
      return (
        <motion.div {...cardMotion} className="group card-glow card-lift rounded-lg" style={glowStyle}>
          {content}
        </motion.div>
      )
    }
    return (
      <motion.div {...cardMotion} className="group card-glow card-lift rounded-lg" style={glowStyle}>
        <div className="relative">
          {/* Red glow background — intensifies with swipe distance.
              Uses bg-red-500 (a solid red) with a motion-driven opacity
              (0 → 1) so the glow "fills in" as the card slides away. */}
          <motion.div
            className="absolute inset-0 rounded-lg bg-red-500 pointer-events-none"
            style={{ opacity: glowOpacity }}
            aria-hidden
          />
          {/* Thumbs-down icon — centered, grows in opacity + scale with the
              swipe. The inner motion.div handles the scale (0.6 → 1.2); the
              outer motion.div handles the opacity (0 → 1). Splitting them
              lets us animate opacity + scale independently. */}
          <motion.div
            className="absolute inset-0 flex items-center justify-center pointer-events-none"
            style={{ opacity: glowOpacity }}
            aria-hidden
          >
            <motion.div
              style={{ scale: thumbScale }}
              className="rounded-full bg-red-500/25 p-3 backdrop-blur-sm ring-2 ring-red-400/40"
            >
              <ThumbsDown className="h-10 w-10 text-white" strokeWidth={2.5} />
            </motion.div>
          </motion.div>
          {/* The draggable card.
              - drag="x" + dragDirectionLock: only horizontal drag is allowed.
                dragDirectionLock means once the drag starts moving
                horizontally, it won't accidentally catch vertical scroll.
              - dragConstraints={{ left: -300, right: 0 }}: the card can only
                move LEFT (right is clamped at 0). -300 is the max drag.
              - dragElastic={0.6}: allows the card to move slightly beyond
                the constraints with 60% elasticity, for a natural feel.
              - style={{ x: dragX }}: uses our motion value as the x
                position, so useTransform can derive glowOpacity + thumbScale
                from it in real time.
              - animate={dragControls}: programmatic animations for the
                dismiss (slide off-screen) + snap-back (spring to 0).
              - z-10: above the glow + thumbs-down so the card sits on top. */}
          <motion.div
            ref={dragCardRef}
            drag="x"
            dragDirectionLock
            dragConstraints={{ left: -300, right: 0 }}
            dragElastic={{ left: 0.6, right: 0 }}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            animate={dragControls}
            style={{ x: dragX }}
            className="relative z-10 h-full"
          >
            {content}
          </motion.div>
        </div>
      </motion.div>
    )
  }

  // ── MINI variant: compact horizontal card (thumbnail left, title right) ──
  // Used in dense lists where 4+ stories should be visible at once on mobile.
  // Includes a compact bias bar so every card shows the red/blue/grey spectrum.
  // When no image: uses a colored left border accent instead of a blank space
  // so the card looks intentional and pleasant next to image cards.
  const renderCard = () => {
    if (variant === 'mini') {
      return wrapWithSwipe(
      <Card
        className={cn(
          'card-glass h-full overflow-hidden p-0 gap-0 flex flex-col min-h-[96px]',
          !showImage && 'border-l-4 border-l-foreground/20',
          onOpenDetail && 'cursor-pointer hover:ring-2 hover:ring-foreground/20 transition-all',
        )}
        onClick={handleCardClick}
      >
        <div className="flex flex-row items-stretch flex-1">
        {showImage && (
          <div className="relative w-24 min-h-[96px] shrink-0 overflow-hidden bg-muted">
            <img
              src={proxyImage(imageUrl!)}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.08]"
              onError={() => setImgErrorMap((m) => ({ ...m, [imageUrl!]: true }))}
            />
            <NWMark withText={false} />
          </div>
        )}
        <div className="flex flex-col gap-1 p-2.5 flex-1 min-w-0 justify-center">
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" className="text-[9px] px-1.5 py-0">
              {topic.coverage}src
            </Badge>
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">
              {mounted ? formatTime(topic.latestSeen) : ''}
            </span>
            {/* View sources + Share — right of the date/time. Sources
                expand INLINE inside the card (no overlay, no scroll lock). */}
            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); toggleSources() }}
                className="text-[10px] font-medium text-foreground/70 underline-offset-2 hover:underline"
              >
                {open ? 'Hide' : 'View'} sources
              </button>
              {shareButton('text-[10px]')}
            </div>
          </div>
          <h3 className="font-bold text-sm leading-tight line-clamp-3">
            {topic.title}
          </h3>
          {/* Compact bias bar — every card shows the red/blue/grey spectrum */}
          <div className="mt-auto pt-1">
            <BiasBar left={topic.leanLeft} center={topic.leanCenter} right={topic.leanRight} />
          </div>
        </div>
        </div>
        {/* Inline sources list — expands in place, below the card content */}
        <AnimatePresence initial={false}>
          {open && renderSourcesList('px-2.5 pb-2.5 pt-1')}
        </AnimatePresence>
      </Card>,
      )
    }

  // ── HERO variant: large card with image on TOP, big title below ──
  // Used for the top story in each section. Full-width on mobile.
  const isHero = variant === 'hero'

  return wrapWithSwipe(
    <Card
      className={cn(
        'card-glass h-full overflow-hidden p-0 gap-0 flex flex-col',
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
            decoding="async"
            // @ts-expect-error — fetchPriority is a valid HTML attr but not in TS DOM types yet
            fetchPriority={variant === 'featured' || isHero ? 'high' : 'low'}
            className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.08]"
            onError={() => setImgErrorMap((m) => ({ ...m, [imageUrl!]: true }))}
          />
          <NWMark />
        </div>
      )}

      {/* Header: title + meta */}
      <div className={cn('flex flex-col gap-2', isHero ? 'p-4 pb-3' : 'p-4 pb-3')}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="text-[10px]">
            {topic.coverage} {topic.coverage === 1 ? 'source' : 'sources'}
          </Badge>
          {/* Blindspot badge — only shown for blindspot topics.
              Shows which side is covering the story (the side with ≥80%).
              Blue badge = left-leaning blindspot (right isn't covering).
              Red badge = right-leaning blindspot (left isn't covering). */}
          {topic.blindspotSide && (
            <Badge
              className={cn(
                'text-[9px] font-bold',
                topic.blindspotSide === 'left'
                  ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30'
                  : 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30',
              )}
              variant="outline"
            >
              {topic.blindspotSide === 'left' ? 'Left' : 'Right'}
            </Badge>
          )}
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            {mounted ? formatTime(topic.latestSeen) : ''}
          </span>
          {/* View sources + Share (hero cards only — default/compact cards
              have these in the bottom row next to the article count).
              Sources expand inline inside the card — no overlay, no scroll
              lock, nothing that can freeze the page. */}
          {isHero && (
            <div className="ml-auto flex items-center gap-2.5">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); toggleSources() }}
                className="text-xs font-medium text-foreground underline-offset-2 hover:underline"
              >
                {open ? 'Hide' : 'View'} sources
              </button>
              {shareButton('text-xs')}
            </div>
          )}
        </div>
        <h3
          className={cn(
            'font-bold leading-snug',
            isHero ? 'text-xl sm:text-2xl' : 'text-base',
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
            decoding="async"
            // @ts-expect-error — fetchPriority is a valid HTML attr but not in TS DOM types yet
            fetchPriority={variant === 'featured' ? 'high' : 'low'}
            className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.08]"
            onError={() => setImgErrorMap((m) => ({ ...m, [imageUrl!]: true }))}
          />
          <NWMark />
        </div>
      )}

      {/* Description (hidden for hero + compact to keep the card compact) */}
      {topic.summary && variant !== 'compact' && !isHero && (
        <div className={cn('px-4', showImage && !isHero ? 'pt-3' : '')}>
          <p className="text-sm text-muted-foreground line-clamp-3">{topic.summary}</p>
        </div>
      )}

      {/* ── HERO: compact bias bar at the bottom ── */}
      {isHero && (
        <div className="mt-auto px-4 pb-3 pt-2">
          <BiasBar left={topic.leanLeft} center={topic.leanCenter} right={topic.leanRight} />
        </div>
      )}

      {/* ── HERO: inline sources expansion below the bias bar ── */}
      {isHero && (
        <AnimatePresence initial={false}>
          {open && renderSourcesList('px-4 pb-3 pt-1')}
        </AnimatePresence>
      )}

      {/* ── DEFAULT + COMPACT: bias bar + count + sources/share row ── */}
      {!isHero && (
        <div className="mt-auto flex flex-col gap-3 p-4 pt-3">
          <BiasBar left={topic.leanLeft} center={topic.leanCenter} right={topic.leanRight} />

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              {total} {total === 1 ? 'article' : 'articles'} across the spectrum
            </span>
            {/* View sources + Share — sources expand INLINE inside the card
                (the original pre-popup behaviour). */}
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); toggleSources() }}
                className="text-xs font-medium text-foreground underline-offset-2 hover:underline"
              >
                {open ? 'Hide' : 'View'} sources
              </button>
              {shareButton('text-xs')}
            </div>
          </div>

          <AnimatePresence initial={false}>
            {open && renderSourcesList('pt-2')}
          </AnimatePresence>
        </div>
      )}
    </Card>,
    )
  }

  return renderCard()
}

// ── Memoized TopicCard ──
// The feed renders 30-60 cards. Without memo, every parent state change
// (typing in search, the 2-min engagement tick, country pill update…)
// re-rendered ALL of them. Topic object identities are stable between
// renders and the parent's callbacks are useCallback'd, so a shallow
// memo comparison skips re-rendering unchanged cards entirely.
const TopicCardMemo = React.memo(TopicCard)
export { TopicCardMemo as TopicCard }
