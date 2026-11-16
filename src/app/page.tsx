import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { findTopicAnywhere } from '@/lib/topic-lookup'
import { isUsefulSummary } from '@/lib/story-quality'
import {
  NAV_MODES,
  readHomeFlags,
  type SubtopicNavMode,
} from '@/lib/home-flags'
import { VideoWatchProvider, VideoPreviewProvider } from '@/lib/video-watch'
import PageClient from './page-client'

// Force dynamic rendering so metadata is generated per-request (needed for
// ?topic= OG image previews) and the per-user nw_nav cookie override below
// applies in the first paint. Plain, query-less, cookie-less navigations to
// '/' never reach this page any more — middleware rewrites them to the ISR
// /home shell (Nov 17, 2026 CPU fix; see src/middleware.ts), so this
// force-dynamic render only runs for:
//   - ?topic= / ?ref= / ?category=… deep links (searchParams present)
//   - visitors with the nw_nav personal header-design cookie
//   - authenticated/special-cookie traffic that skips the rewrite
export const dynamic = 'force-dynamic'
export const revalidate = 0

// ── Server-rendered feature flags ──────────────────────────────────
// The ten SSR flags (subtopic-nav design, popup system, videoWatch,
// videoPreview, milestoneDonate, meshRelay, userCron, notifRaiseFix,
// smartPersonalization, monetizationModel) are read in ONE place now:
// src/lib/home-flags.ts — shared with the ISR /home variant so the two
// variants can never drift (same defaults, same 5s memos). See the
// comments there for the no-flash rationale.

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
      // Description — QUALITY-GATED (the share-card "U.S." bug): a topic's
      // stored summary can be a bare section word ("U.S."), a two-word
      // quip, or a GDELT "Shown because…" note. isUsefulSummary (shared
      // with the aggregator, so the rules never drift) rejects those; the
      // fallback describes what a share of NeutralWire actually IS instead
      // of repeating the headline or leaking a fragment.
      const goodSummary = isUsefulSummary(topic.summary)
      const description = goodSummary
        ? (topic.summary || '').slice(0, 200)
        : 'Compare how left, right and center outlets cover this story — side by side on NeutralWire.'
      return {
        title: `${topic.title} — NeutralWire`,
        description,
        openGraph: {
          title: topic.title,
          description,
          type: 'article',
          images: [{ url: ogImage, width: 1200, height: 630 }],
        },
        twitter: {
          card: 'summary_large_image',
          title: topic.title,
          description,
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
  // All ten SSR flags in one call (shared module — see home-flags.ts).
  const flags = await readHomeFlags()
  let initialSubtopicNav = flags.initialSubtopicNav

  // Personal override (Account → Feature Flags → "Your header style"):
  // a cookie, so the server sees it during SSR — the visitor's own pick
  // renders in the very first paint, no flash. Invalid values fall back
  // to the site-wide default above. (ISR /home visitors have no such
  // cookie by construction — the middleware only rewrites cookie-less
  // navigations — so the dynamic page here is the ONLY place the
  // override matters.)
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
    <VideoWatchProvider enabled={flags.videoWatch}>
      <VideoPreviewProvider enabled={flags.videoPreview}>
        <PageClient
          initialSubtopicNav={initialSubtopicNav}
          popupSystem={flags.popupSystem}
          milestoneDonate={flags.milestoneDonate}
          meshRelay={flags.meshRelay}
          userCron={flags.userCron}
          notifRaiseFix={flags.notifRaiseFix}
          smartPersonalization={flags.smartPersonalization}
          monetizationModel={flags.monetizationModel}
        />
      </VideoPreviewProvider>
    </VideoWatchProvider>
  )
}
