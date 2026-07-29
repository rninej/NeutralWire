import type { MetadataRoute } from 'next'

/**
 * EMERGENCY: Static sitemap with ZERO Firebase reads.
 *
 * The dynamic sitemap was reading the ENTIRE newsCache + archive from
 * Firebase on every request (Vercel serverless doesn't persist in-memory
 * cache between invocations), causing 10GB+ download usage.
 *
 * This static version only includes the homepage + category pages — no
 * topic URLs. Google can still crawl the site via links; the sitemap just
 * won't list every individual story URL.
 *
 * URL: https://neutralwire.org/sitemap.xml
 */

const SITE_URL = 'https://neutralwire.org'

const CATEGORIES = [
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

// Static export — no Firebase reads, no dynamic data
export const dynamic = 'force-static'
export const revalidate = 86400 // 24 hours

export default function sitemap(): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = []

  // Homepage
  entries.push({
    url: SITE_URL,
    lastModified: new Date(),
    changeFrequency: 'hourly',
    priority: 1.0,
  })

  // Category pages
  for (const cat of CATEGORIES) {
    entries.push({
      url: `${SITE_URL}/?category=${cat}`,
      lastModified: new Date(),
      changeFrequency: 'hourly',
      priority: 0.9,
    })
  }

  return entries
}
