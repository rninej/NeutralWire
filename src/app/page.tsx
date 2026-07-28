import type { Metadata } from 'next'
import { firebaseRead } from '@/lib/firebase-server'
import type { CategoryCachePayload, TopicArticle } from '@/lib/news-aggregator'
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
    },
  }

  if (!topicId) return defaultMeta

  try {
    // Search all cached categories for the topic.
    const all = await firebaseRead<Record<string, CategoryCachePayload>>('newsCache')
    if (!all) return defaultMeta

    for (const payload of Object.values(all)) {
      if (!payload?.topics) continue
      const topic = payload.topics.find(
        (t: TopicArticle) => t.topicId === topicId,
      )
      if (topic) {
        const ogImage = topic.imageUrl
          ? `/api/img?url=${encodeURIComponent(topic.imageUrl)}`
          : undefined
        return {
          title: `${topic.title} — NeutralWire`,
          description: topic.summary?.slice(0, 200) || topic.title,
          openGraph: {
            title: topic.title,
            description: topic.summary?.slice(0, 200) || 'Read this story on NeutralWire',
            type: 'article',
            images: ogImage ? [{ url: ogImage, width: 1200, height: 630 }] : [],
          },
          twitter: {
            card: 'summary_large_image',
            title: topic.title,
            description: topic.summary?.slice(0, 200) || '',
            images: ogImage ? [ogImage] : [],
          },
        }
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
