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
 * CACHED for 1 hour in-memory to avoid excessive Firebase reads. Google
 * crawls the sitemap periodically; without caching, each crawl triggered
 * 2 full Firebase reads (newsCache + archive) which caused 700MB/day
 * download usage. With caching, Firebase is read at most once per hour.
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

// ── In-memory cache (1 hour TTL) ──
// Prevents excessive Firebase reads when Google crawls the sitemap.
let SITEMAP_CACHE: { ts: number; data: MetadataRoute.Sitemap } | null = null
const SITEMAP_CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

export const dynamic = 'force-dynamic'
export const revalidate = 3600 // 1 hour — Next.js-level cache as backup

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Return cached result if fresh
  if (SITEMAP_CACHE && Date.now() - SITEMAP_CACHE.ts < SITEMAP_CACHE_TTL_MS) {
    return SITEMAP_CACHE.data
  }

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

  // 4. Archive topics (old stories that are still accessible via /?topic=)
  // Limited to 500 most recent to keep Firebase read small.
  try {
    const archive = await firebaseRead<Record<string, { archivedAt?: number; latestSeen?: number }>>('archive')
    if (archive) {
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

  // Google allows max 50,000 URLs per sitemap.
  const MAX_URLS = 50000
  const result = entries.length > MAX_URLS ? entries.slice(0, MAX_URLS) : entries

  // Cache the result
  SITEMAP_CACHE = { ts: Date.now(), data: result }

  return result
}
