import type { MetadataRoute } from 'next'
import { firebaseRead } from '@/lib/firebase-server'
import type { CategoryCachePayload } from '@/lib/news-aggregator'

/**
 * Dynamic sitemap for Google Search Console.
 *
 * Generates a sitemap.xml that includes:
 *   - The homepage (neutralwire.org)
 *   - All category pages (/?category=world, /?category=politics, etc.)
 *   - All cached news topics (/?topic=<topicId>) — so every news story
 *     gets indexed by Google
 *
 * Topics are read from the Firebase news cache. The sitemap is regenerated
 * on each request (Google crawls it periodically), so new stories that
 * arrive via GDELT/RSS are automatically included.
 *
 * URL: https://neutralwire.org/sitemap.xml
 */

const SITE_URL = 'https://neutralwire.org'

const CATEGORIES = [
  'relevant',
  'mycountry',
  'top',
  'world',
  'politics',
  'business',
  'technology',
  'science',
  'health',
  'sports',
] as const

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = []

  // 1. Homepage
  entries.push({
    url: SITE_URL,
    lastModified: new Date(),
    changeFrequency: 'hourly',
    priority: 1.0,
  })

  // 2. Category pages
  for (const cat of CATEGORIES) {
    if (cat === 'relevant') continue // relevant is the homepage
    entries.push({
      url: `${SITE_URL}/?category=${cat}`,
      lastModified: new Date(),
      changeFrequency: 'hourly',
      priority: 0.9,
    })
  }

  // 3. All cached news topics (so every story gets indexed)
  try {
    const allCache = await firebaseRead<Record<string, CategoryCachePayload>>('newsCache')
    if (allCache) {
      const now = new Date()
      for (const [cacheKey, payload] of Object.entries(allCache)) {
        if (!payload?.topics) continue
        for (const topic of payload.topics) {
          // Only include topics with a valid topicId and recent lastSeen
          if (!topic.topicId) continue
          const lastMod = topic.latestSeen ? new Date(topic.latestSeen) : now
          entries.push({
            url: `${SITE_URL}/?topic=${topic.topicId}`,
            lastModified: lastMod,
            changeFrequency: 'daily',
            priority: 0.7,
          })
        }
      }
    }
  } catch {
    // If Firebase read fails, still return the homepage + category pages
  }

  // 4. Archive topics (old stories that have been pushed out of the live
  // cache but are still accessible via /?topic=). These have lower priority
  // since they're older, but Google should still index them so shared links
  // work in search results.
  try {
    const archive = await firebaseRead<Record<string, { archivedAt?: number; latestSeen?: number }>>('archive')
    if (archive) {
      // Only include the 500 most recent archived topics (to keep the sitemap
      // under Google's 50,000 URL limit)
      const archivedEntries = Object.entries(archive)
        .filter(([id]) => id)
        .sort((a, b) => (b[1]?.archivedAt || 0) - (a[1]?.archivedAt || 0))
        .slice(0, 500)
      for (const [topicId, data] of archivedEntries) {
        const lastMod = data.archivedAt ? new Date(data.archivedAt) : new Date()
        entries.push({
          url: `${SITE_URL}/?topic=${topicId}`,
          lastModified: lastMod,
          changeFrequency: 'monthly',
          priority: 0.4,
        })
      }
    }
  } catch {
    // silent
  }

  // Google allows max 50,000 URLs per sitemap. If we somehow exceed that,
  // slice to the highest-priority entries (homepage + categories first,
  // then most-recent topics).
  const MAX_URLS = 50000
  if (entries.length > MAX_URLS) {
    return entries.slice(0, MAX_URLS)
  }

  return entries
}
