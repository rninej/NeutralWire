'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useTransform,
  useAnimationControls,
} from 'framer-motion'
import { Clock, ExternalLink, Globe, ThumbsDown, Share2, Check, Loader2, Layers, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { cn, safeImageUrl } from '@/lib/utils'
import { BiasBar } from '@/components/bias-bar'
import { HeroVideoPreview } from '@/components/video-preview'
import { useVideoPreview } from '@/lib/video-watch'
import { armVideoIfPlaying } from '@/lib/video-preview-store'
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
  /** EXPERIMENTAL (videoPreview flag, /debug): auto-play a half-volume
   *  video preview inside this card's image ~0.8s after it's been on
   *  screen (landscape videos only — never Shorts). Passed to EVERY
   *  card with a large image (hero + desktop magazine grid) — each one
   * arms on scroll, throttled by a 2-slot resolution semaphore. */
  videoPreview?: boolean
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
  // safeImageUrl: degrade malformed entries (nested objects) to null
  // instead of passing garbage into the img proxy.
  const own = safeImageUrl(topic.imageUrl)
  if (own) return own
  for (const a of topic.articles) {
    const aImg = safeImageUrl(a.imageUrl)
    if (aImg) return aImg
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
 * NEUTRALWIRE wordmark on larger images). NON-absolute: it sits inside the
 * ImageBadges container (bottom-right of card images). Mirrors the
 * branding on generated share/notification images (bias bar +
 * NEUTRALWIRE banner) so cards,
 * shares and notifications all read as one brand. pointer-events-none —
 * never blocks card clicks, and it stays fixed while the image zooms
 * underneath on hover (broadcast-watermark behaviour).
 */
function NWMark({ withText = true }: { withText?: boolean }) {
  return (
    <div className="pointer-events-none flex items-center gap-1 rounded-md bg-black/55 py-[3px] pl-1 pr-1.5 backdrop-blur-[2px]">
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

/**
 * Bottom-right brand watermark row on card images. The experimental
 * Watch pill now renders ONLY inside the article view (user request:
 * videos are watched from the article, never from the home feed) — so
 * this row is back to the NW chip alone, exactly the pre-experiment
 * watermark.
 */
function ImageBadges() {
  return (
    <div className="pointer-events-none absolute bottom-1.5 right-1.5 z-[2]">
      <NWMark />
    </div>
  )
}

function TopicCard({ topic, variant = 'default', onOpenDetail, onDismiss, index = 0, videoPreview = false }: TopicCardProps) {
  // NOTE: this component is wrapped in React.memo at the bottom of the file.
  // Parent re-renders (search typing, engagement ticks, unrelated state)
  // no longer re-render every card in the feed — topic object identities
  // are stable across renders, and onOpenDetail/onDismiss are useCallback'd
  // in the parent, so memo comparison works as intended.
  // "View sources" opens a frosted-glass popup (portaled to document.body —
  // no transform-ancestor issues, no stuck scroll lock). "Share" sits next
  // to it inside one combined pill button (same design as the header's
  // account|country pill).
  // The experimental preview only fires when BOTH are true: the layout
  // marked THIS card as the top story (videoPreview prop) AND the global
  // videoPreview feature flag is on (SSR context — flipped in /debug).
  const previewFlagOn = useVideoPreview()
  const showVideoPreview = videoPreview && previewFlagOn
  const [showSources, setShowSources] = React.useState(false)
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

  /** Combined pill button — ONE pill with TWO sub-buttons separated by a
   *  divider, matching the header's account|country pill design:
   *    [ ≡ Sources | ⇗ ]
   *  Left sub-button opens the frosted-glass sources popup; right
   *  sub-button shares (green check for 2s on clipboard copy).
   *  The "Sources" label shows on EVERY card size (mini included) —
   *  `compact` only scales the pill down slightly for mini cards. */
  const sourcesSharePill = (compact = false) => (
    <div
      className={cn(
        'ml-auto flex shrink-0 items-center overflow-hidden rounded-full border border-border bg-muted/50',
        compact ? 'scale-95' : '',
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Sources sub-button */}
      <button
        type="button"
        onClick={() => setShowSources(true)}
        className="flex items-center gap-1 px-2 py-1 transition-colors hover:bg-muted active:scale-95"
        aria-label="View sources"
        title="View all sources for this story"
      >
        <Layers className="h-3 w-3 text-foreground/80" />
        <span className="text-[10px] font-medium text-foreground/80">Sources</span>
      </button>
      {/* Divider — same as the header pill */}
      <div className="h-3.5 w-px bg-border" />
      {/* Share sub-button */}
      <button
        type="button"
        onClick={handleShare}
        className="flex items-center px-2 py-1 transition-colors hover:bg-muted active:scale-95"
        aria-label="Share this story"
        title="Share this story"
      >
        {shared ? (
          <Check className="h-3 w-3 text-emerald-500" />
        ) : (
          <Share2 className="h-3 w-3 text-foreground/80" />
        )}
      </button>
    </div>
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
    // If THIS card's video preview resolved (it's playing/about to), arm
    // the handoff BEFORE opening — the article then starts with the video
    // already rolling instead of the photo + Watch square (user spec).
    // Synchronous so it lands before any state update flushes.
    if (showVideoPreview) armVideoIfPlaying(topic.topicId)
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
    // h-full chain: grid items stretch to the row height — h-full on the
    // wrapper lets the Card's mt-auto footer (bias bar) anchor to the
    // bottom, so cards in one row align their footers on desktop.
    if (!onDismiss) {
      return (
        <motion.div {...cardMotion} className="group card-glow card-lift h-full rounded-lg" style={glowStyle}>
          {content}
        </motion.div>
      )
    }
    return (
      <motion.div {...cardMotion} className="group card-glow card-lift h-full rounded-lg" style={glowStyle}>
        <div className="relative h-full">
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
          'card-glass h-full overflow-hidden p-0 gap-0 flex flex-row items-stretch min-h-[96px]',
          !showImage && 'border-l-4 border-l-foreground/20',
          onOpenDetail && 'cursor-pointer hover:ring-2 hover:ring-foreground/20 transition-all',
        )}
        onClick={handleCardClick}
      >
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
            {/* NO NWMark and no Watch pill here — the brand watermark
                only appears on LARGE form factors (hero/default cards +
                the article detail view), and the experimental video
                button lives exclusively inside the article view. On tiny
                thumbnails the watermark just covered the photo. */}
          </div>
        )}
        <div className="flex flex-col gap-1 p-2.5 flex-1 min-w-0 justify-center">
          <div className="flex items-center gap-1.5 min-w-0">
            <Badge variant="secondary" className="text-[9px] px-1.5 py-0 shrink-0">
              {topic.coverage}src
            </Badge>
            <span className="text-[10px] text-muted-foreground whitespace-nowrap truncate">
              {mounted ? formatTime(topic.latestSeen) : ''}
            </span>
            {/* Combined Sources | Share pill — same design as the header's
                account|country pill. Slightly scaled down on mini cards;
                the "Sources" label shows on every size. */}
            {sourcesSharePill(true)}
          </div>
          <h3 className="font-bold text-sm leading-tight line-clamp-3">
            {topic.title}
          </h3>
          {/* Compact bias bar — every card shows the red/blue/grey spectrum */}
          <div className="mt-auto pt-1">
            <BiasBar left={topic.leanLeft} center={topic.leanCenter} right={topic.leanRight} />
          </div>
        </div>
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
            loading="eager"
            decoding="async"
            fetchPriority="high"
            className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.08]"
            onError={() => setImgErrorMap((m) => ({ ...m, [imageUrl!]: true }))}
          />
          <ImageBadges />
          {/* Experimental video preview — half-volume inline video the
              moment the card is on screen (WATCH chip bottom-left). */}
          {showVideoPreview && <HeroVideoPreview topicId={topic.topicId} />}
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
          {/* Combined Sources | Share pill (hero cards). Sources opens the
              frosted-glass popup. */}
          {isHero && sourcesSharePill()}
        </div>
        <h3
          className={cn(
            'font-bold leading-snug',
            isHero ? 'text-xl sm:text-2xl' : 'text-base line-clamp-3',
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
            fetchPriority={variant === 'featured' ? 'high' : 'low'}
            className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.08]"
            onError={() => setImgErrorMap((m) => ({ ...m, [imageUrl!]: true }))}
          />
          <ImageBadges />
          {/* Same experimental preview for non-hero cards with a large
              image (desktop magazine grid). */}
          {showVideoPreview && <HeroVideoPreview topicId={topic.topicId} />}
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

      {/* ── DEFAULT + COMPACT: bias bar + count + sources/share pill ── */}
      {!isHero && (
        <div className="mt-auto flex flex-col gap-3 p-4 pt-3">
          <BiasBar left={topic.leanLeft} center={topic.leanCenter} right={topic.leanRight} />
          <div className="flex items-center justify-between gap-2 min-w-0">
            <span className="text-[11px] text-muted-foreground truncate">
              {total} {total === 1 ? 'article' : 'articles'} across the spectrum
            </span>
            {/* Combined Sources | Share pill — same design as the header's
                account|country pill. */}
            {sourcesSharePill()}
          </div>
        </div>
      )}
    </Card>,
    )
  }

  // Render the card + sources popup (portaled to document.body so no
  // transformed ancestor can trap the fixed positioning, and so the
  // AnimatePresence exit animation always runs).
  return (
    <>
      {renderCard()}
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {showSources && (
              <SourcesPopup topic={topic} onClose={() => setShowSources(false)} />
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  )
}

// ── Memoized TopicCard ──
// The feed renders 30-60 cards. Without memo, every parent state change
// (typing in search, the 2-min engagement tick, country pill update…)
// re-rendered ALL of them. Topic object identities are stable between
// renders and the parent's callbacks are useCallback'd, so a shallow
// memo comparison skips re-rendering unchanged cards entirely.
const TopicCardMemo = React.memo(TopicCard)
export { TopicCardMemo as TopicCard }

// ── Sources Popup (frosted glass) ──
// A scrollable frosted-glass overlay showing all sources for a topic,
// grouped by leaning (Left / Center / Right). Rendered via createPortal
// to document.body from the TopicCard, wrapped in AnimatePresence so the
// exit animation runs.
//
// Why portal: the old popup rendered inside the card's DOM subtree, where
// transformed ancestors (framer-motion entrance/hover transforms on the
// card) break position:fixed — the overlay ended up trapped/mispositioned,
// which looked like a frozen black screen. Portaling to document.body
// guarantees clean fixed positioning. The scroll lock below also saves +
// restores the previous value and compensates for scrollbar removal, so
// it can never get stuck.
const LEANING_LABELS: Record<string, { label: string; cls: string; color: string }> = {
  left: { label: 'Left', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300', color: 'text-blue-600 dark:text-blue-400' },
  center: { label: 'Center', cls: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300', color: 'text-zinc-600 dark:text-zinc-400' },
  right: { label: 'Right', cls: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300', color: 'text-red-600 dark:text-red-400' },
}

function SourcesPopup({ topic, onClose }: { topic: TopicArticle; onClose: () => void }) {
  const hasArticles = topic.articles && topic.articles.length > 0
  const [fullTopic, setFullTopic] = React.useState<TopicArticle | null>(hasArticles ? topic : null)
  const [loading, setLoading] = React.useState(!hasArticles)

  // Fetch the full topic (with articles) when the feed topic is slim.
  React.useEffect(() => {
    if (hasArticles) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/topic/${encodeURIComponent(topic.topicId)}`, { cache: 'no-store' })
        if (res.ok) {
          const data = await res.json()
          if (!cancelled && data.topic) {
            setFullTopic(data.topic as TopicArticle)
            return
          }
        }
        if (!cancelled) setFullTopic(topic)
      } catch {
        if (!cancelled) setFullTopic(topic)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [topic.topicId])

  // Scroll lock + Escape key — with bulletproof cleanup. The previous
  // version could leave the page locked (the "freeze" bug) if unmount was
  // interrupted; saving/restoring the previous inline styles guarantees
  // the page always scrolls again.
  React.useEffect(() => {
    const prevOverflow = document.body.style.overflow
    const prevPR = document.body.style.paddingRight
    const scrollbarW = window.innerWidth - document.documentElement.clientWidth
    document.body.style.overflow = 'hidden'
    if (scrollbarW > 0) document.body.style.paddingRight = `${scrollbarW}px`
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      document.body.style.paddingRight = prevPR
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const articles = fullTopic?.articles || []
  const leftArticles = articles.filter((a) => a.leaning === 'left')
  const centerArticles = articles.filter((a) => a.leaning === 'center')
  const rightArticles = articles.filter((a) => a.leaning === 'right')

  return (
    <motion.div
      className="fixed inset-0 z-[90] flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center sm:p-6"
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
    >
      {/* Frosted glass panel — bottom sheet on mobile, centered dialog on
          desktop. bg-background/85 + backdrop-blur-2xl = frosted glass that
          shows the (blurred) page behind it instead of a flat black overlay. */}
      <motion.div
        className="flex max-h-[88vh] w-full flex-col overflow-hidden rounded-t-2xl border border-border/60 bg-background/85 shadow-2xl backdrop-blur-2xl sm:max-w-lg sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        initial={{ y: 48, opacity: 0, scale: 0.98 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 24, opacity: 0, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 380, damping: 34 }}
        role="dialog"
        aria-modal="true"
        aria-label="Sources"
      >
        {/* Drag handle indicator (mobile only) */}
        <div className="sm:hidden flex justify-center pt-2 pb-1 shrink-0">
          <div className="h-1 w-10 rounded-full bg-foreground/20" />
        </div>
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Badge variant="secondary" className="text-[10px] shrink-0">
              {topic.coverage} {topic.coverage === 1 ? 'source' : 'sources'}
            </Badge>
            <h3 className="text-sm font-bold truncate">{topic.title}</h3>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground shrink-0 p-1"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Bias bar with percentages + counts */}
        <div className="border-b px-4 py-2.5 shrink-0">
          <BiasBar left={topic.leanLeft} center={topic.leanCenter} right={topic.leanRight} showLabels />
          <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
            <span>Left ({topic.leanLeft})</span>
            <span>Center ({topic.leanCenter})</span>
            <span>Right ({topic.leanRight})</span>
          </div>
        </div>

        {/* Scrollable sources list */}
        <div className="nw-scrollbar overflow-y-auto p-4 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Loading sources…</span>
            </div>
          ) : articles.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              No sources available for this story.
            </div>
          ) : (
            <>
              {leftArticles.length > 0 && (
                <SourceGroup label="Left" count={leftArticles.length} color={LEANING_LABELS.left.color} articles={leftArticles} />
              )}
              {centerArticles.length > 0 && (
                <SourceGroup label="Center" count={centerArticles.length} color={LEANING_LABELS.center.color} articles={centerArticles} />
              )}
              {rightArticles.length > 0 && (
                <SourceGroup label="Right" count={rightArticles.length} color={LEANING_LABELS.right.color} articles={rightArticles} />
              )}
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}

function SourceGroup({ label, count, color, articles }: {
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
        {articles.map((a) => {
          const lean = LEANING_LABELS[a.leaning] || LEANING_LABELS.center
          return (
            <a
              key={a.id}
              href={a.link}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-lg border bg-background/40 p-3 transition-colors hover:bg-muted/50"
            >
              <div className="line-clamp-2 text-sm font-medium leading-snug">
                {a.title}
              </div>
              <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className={cn('inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase', lean.cls)}>
                  {lean.label}
                </span>
                <Globe className="h-2.5 w-2.5" />
                {a.sourceName}
                <span className="opacity-50">·</span>
                {a.country}
                <ExternalLink className="ml-auto h-2.5 w-2.5" />
              </div>
            </a>
          )
        })}
      </div>
    </div>
  )
}
