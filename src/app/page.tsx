import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { firebaseRead } from '@/lib/firebase-server'
import { findTopicAnywhere } from '@/lib/topic-lookup'
import {
  normalizePopupMode,
  type PopupMode,
} from '@/lib/popup-mode'
import { VideoWatchProvider, VideoPreviewProvider } from '@/lib/video-watch'
import PageClient from './page-client'

// Force dynamic rendering so metadata is generated per-request (needed for
// ?topic= OG image previews).
export const dynamic = 'force-dynamic'
export const revalidate = 0

// ── Server-rendered subtopic-nav flag ──────────────────────────────────
// The homepage category header has TEN selectable designs, switched for
// ALL users from /debug (stored in Firebase at featureFlags/subtopicNav).
//
// WHY SERVER-SIDE: previously the client started on the default ('cards')
// and fetched /api/flags after mount — every refresh briefly flashed the
// big-chips design before snapping to the selected one. Reading the flag
// HERE and passing it down means the very first paint (SSR HTML) already
// uses the right design. No flash, ever.
//
// Module-level 5s memo bounds Firebase reads on warm instances; flipping
// the flag in /debug and refreshing therefore applies within ≤5s.
//
// PER-USER OVERRIDE: any visitor can pick their own design in Account →
// Feature Flags ("Your header style"). It's stored in the `nw_nav` cookie —
// read HERE, server-side, so the user's own choice is in the first paint
// with the same zero-flash guarantee. The personal cookie WINS over the
// site-wide default; when it's absent (the vast majority), the Firebase
// flag decides. See src/lib/nav-override.ts.
type SubtopicNavMode =
  | 'cards' | 'classic' | 'tabs' | 'tiles' | 'sheet' | 'dock'
  | 'maxipills' | 'headerdock' | 'tabsarrow' | 'cardsarrow'
const NAV_MODES: SubtopicNavMode[] = [
  'cards', 'classic', 'tabs', 'tiles', 'sheet', 'dock',
  'maxipills', 'headerdock', 'tabsarrow', 'cardsarrow',
]
let navFlagMemo: { value: SubtopicNavMode; ts: number } | null = null
const NAV_FLAG_TTL_MS = 5 * 1000

async function getSubtopicNav(): Promise<SubtopicNavMode> {
  if (navFlagMemo && Date.now() - navFlagMemo.ts < NAV_FLAG_TTL_MS) {
    return navFlagMemo.value
  }
  try {
    const stored = await firebaseRead<string>('featureFlags/subtopicNav')
    const value = NAV_MODES.includes(stored as SubtopicNavMode)
      ? (stored as SubtopicNavMode)
      : 'cards'
    navFlagMemo = { value, ts: Date.now() }
    return value
  } catch {
    return 'cards'
  }
}

// ── Server-rendered popup-system flag ──────────────────────────────
// Which popup system runs site-wide: the ORIGINAL popups, the smart
// behavioral system, or smart + a first-visit classic install popup.
// Switched for ALL users from /debug (Firebase featureFlags/popupSystem).
// Same SSR logic as the nav flag: read HERE so the first paint already
// mounts the right popup components — no wrong-popup flash. 5s memo.
// An absent flag → 'smart' (the live behavioral system).
let popupFlagMemo: { value: PopupMode; ts: number } | null = null
const POPUP_FLAG_TTL_MS = 5 * 1000

async function getPopupSystem(): Promise<PopupMode> {
  if (popupFlagMemo && Date.now() - popupFlagMemo.ts < POPUP_FLAG_TTL_MS) {
    return popupFlagMemo.value
  }
  try {
    const stored = await firebaseRead<string>('featureFlags/popupSystem')
    const value = normalizePopupMode(stored)
    popupFlagMemo = { value, ts: Date.now() }
    return value
  } catch {
    return 'smart'
  }
}

// ── Server-rendered videoWatch flag (experimental Watch button) ──
// Same SSR pattern as the nav + popup flags: read HERE so the first
// paint already knows whether to render the Watch pill on article
// images — no button-then-vanish flash. 5s memo. Absent → ON (the
// experiment starts live; /debug can flip it off instantly).
let videoFlagMemo: { value: boolean; ts: number } | null = null
const VIDEO_FLAG_TTL_MS = 5 * 1000

async function getVideoWatch(): Promise<boolean> {
  if (videoFlagMemo && Date.now() - videoFlagMemo.ts < VIDEO_FLAG_TTL_MS) {
    return videoFlagMemo.value
  }
  try {
    const stored = await firebaseRead<boolean | string>('featureFlags/videoWatch')
    const value = !(stored === false || stored === 'false')
    videoFlagMemo = { value, ts: Date.now() }
    return value
  } catch {
    return true
  }
}

// ── Server-rendered videoPreview flag (experimental top-story preview) ──
// Same SSR pattern: read HERE so the first paint already knows whether
// the home feed's top card should autoplay a muted video preview. Absent
// → OFF (this one is a pure experiment; enable it from /debug). 5s memo.
let videoPreviewFlagMemo: { value: boolean; ts: number } | null = null

async function getVideoPreview(): Promise<boolean> {
  if (videoPreviewFlagMemo && Date.now() - videoPreviewFlagMemo.ts < VIDEO_FLAG_TTL_MS) {
    return videoPreviewFlagMemo.value
  }
  try {
    const stored = await firebaseRead<boolean | string>('featureFlags/videoPreview')
    const value = stored === true || stored === 'true'
    videoPreviewFlagMemo = { value, ts: Date.now() }
    return value
  } catch {
    return false
  }
}

/**
 *  Generate dynamic OG metadata for shared links.
 *
 * When a link like /?topic=abc123 is shared on WhatsApp/Twitter/etc, the
 * crawler fetches the page HTML and reads the og:image meta tag. We look
 * up the topic in Firebase and return its image + title as OG tags so the
 * link preview shows the news photo.
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}): Promise<Metadata> {
  const params = await searchParams
  const topicId = typeof params.topic === 'string' ? params.topic : undefined

  const defaultMeta: Metadata = {
    title: 'NeutralWire — See How Every Outlet Spins the Same Story',
    description:
      'Is your news feeding you the full picture? NeutralWire compares how left, right, and center outlets cover the SAME story — side by side. See the bias, spot the spin, decide for yourself. Free, no paywalls, auto-detects your country.',
    openGraph: {
      title: 'NeutralWire — See How Every Outlet Spins the Same Story',
      description: 'Is your news feeding you the full picture? Compare how left, right, and center outlets cover the SAME story — side by side. See the bias, spot the spin, decide for yourself.',
      type: 'website',
      // Default OG image — the branded neutralwire preview
      images: [{ url: '/api/og-image', width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image',
      title: 'NeutralWire — See How Every Outlet Spins the Same Story',
      description: 'Is your news feeding you the full picture? Compare how left, right, and center outlets cover the SAME story — side by side.',
      images: ['/api/og-image'],
    },
  }

  if (!topicId) return defaultMeta

  try {
    // ONE shared lookup: archive first, then EVERY live newsCache key
    // (dynamically listed — covers relevant__CC / mycountry__CC keys the
    // old hardcoded lists missed, which is why some shared links had no
    // image card). Found topics are archived so they're findable forever.
    const topic = await findTopicAnywhere(topicId)

    if (topic) {
      // ── Dynamic OG image: article image + NW logo (bottom-right) + bias bar ──
      // This endpoint generates a composite 1200x630 image that ALWAYS
      // renders in WhatsApp/Twitter/etc (even if the article image is
      // stale or blocked). The NW logo + bias bar are overlaid on top.
      const ogImage = `/api/og-image?topicId=${encodeURIComponent(topicId)}`
      return {
        title: `${topic.title} — NeutralWire`,
        description: topic.summary?.slice(0, 200) || topic.title,
        openGraph: {
          title: topic.title,
          description: topic.summary?.slice(0, 200) || 'Read this story on NeutralWire',
          type: 'article',
          images: [{ url: ogImage, width: 1200, height: 630 }],
        },
        twitter: {
          card: 'summary_large_image',
          title: topic.title,
          description: topic.summary?.slice(0, 200) || '',
          images: [ogImage],
        },
      }
    }
  } catch {
    // Fall through to default
  }

  return defaultMeta
}

export default async function Page() {
  // Read the subtopic-nav flag on the SERVER so the SSR HTML already
  // renders the selected header design (no default-then-swap flash).
  let initialSubtopicNav = await getSubtopicNav()

  // Popup system flag — same server-side read, same zero-flash guarantee.
  const popupSystem = await getPopupSystem()

  // Experimental Watch button flag — same server-side read, so the SSR
  // HTML already includes (or omits) the Watch pills on card images.
  const videoWatch = await getVideoWatch()

  // Experimental top-story video preview flag — same server-side read
  // (defaults OFF; flipped on from /debug).
  const videoPreview = await getVideoPreview()

  // Personal override (Account → Feature Flags → "Your header style"):
  // a cookie, so the server sees it during SSR — the visitor's own pick
  // renders in the very first paint, no flash. Invalid values fall back
  // to the site-wide default above.
  try {
    const cookieNav = (await cookies()).get('nw_nav')?.value
    if (cookieNav && NAV_MODES.includes(cookieNav as SubtopicNavMode)) {
      initialSubtopicNav = cookieNav as SubtopicNavMode
    }
  } catch {
    // cookies() can throw in some render modes — the global flag already
    // loaded, so just fall back to it.
  }

  return (
    <VideoWatchProvider enabled={videoWatch}>
      <VideoPreviewProvider enabled={videoPreview}>
        <PageClient initialSubtopicNav={initialSubtopicNav} popupSystem={popupSystem} />
      </VideoPreviewProvider>
    </VideoWatchProvider>
  )
}
