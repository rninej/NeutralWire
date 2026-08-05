import type { Metadata } from 'next'
import { firebaseRead } from '@/lib/firebase-server'
import type { TopicArticle } from '@/lib/news-aggregator'
import PageClient from './page-client'

// Force dynamic rendering so metadata is generated per-request (needed for
// ?topic= OG image previews).
export const dynamic = 'force-dynamic'
export const revalidate = 0

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

    // Fallback: check the live news cache categories
    if (!topic) {
      const cacheCategories = ['relevant', 'top', 'world', 'politics', 'business', 'technology']
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

export default function Page() {
  return <PageClient />
}
