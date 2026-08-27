import type { Metadata } from 'next'
import { firebaseRead } from '@/lib/firebase-server'
import type { TopicArticle } from '@/lib/news-aggregator'
import type { Category } from '@/lib/news-sources'
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
    // Look up the topic in the archive first (permanent storage for
    // topics sent via notifications). If not found, check the live cache.
    let topic: (TopicArticle & { archivedAt?: number }) | null = null

    topic = await firebaseRead<TopicArticle & { archivedAt?: number }>(
      `archive/${topicId}`,
    )

    // Fallback: check the live news cache categories.
    // Check ALL categories (not just a few) so every topic can be found
    // for OG metadata — missing a category means the share preview shows
    // the default NeutralWire image instead of the article's image.
    if (!topic) {
      const cacheCategories: Category[] = [
        'relevant', 'top', 'world', 'politics', 'business',
        'technology', 'science', 'health', 'sports',
      ]
      // Also check mycountry for common country codes
      const myCountryCodes = ['GB', 'US', 'IN', 'HK', 'AU', 'CA', 'IE', 'NZ']
      for (const cat of cacheCategories) {
        try {
          const payload = await firebaseRead<{ topics?: TopicArticle[] }>(`newsCache/${cat}`)
          if (payload?.topics) {
            topic = payload.topics.find((t) => t.topicId === topicId) || null
            if (topic) break
          }
        } catch {
          // continue
        }
      }
      // Check mycountry caches if not found yet
      if (!topic) {
        for (const cc of myCountryCodes) {
          try {
            const payload = await firebaseRead<{ topics?: TopicArticle[] }>(`newsCache/mycountry__${cc}`)
            if (payload?.topics) {
              topic = payload.topics.find((t) => t.topicId === topicId) || null
              if (topic) break
            }
          } catch {
            // continue
          }
        }
      }
    }

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
  const initialSubtopicNav = await getSubtopicNav()
  return <PageClient initialSubtopicNav={initialSubtopicNav} />
}
