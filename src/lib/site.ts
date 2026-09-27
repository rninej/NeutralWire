/**
 * Central site identity constants for the SEO / Google Discover surface.
 *
 * One source of truth for the canonical origin, brand strings and the
 * Discover-critical image endpoints — used by /story/[id], /feed.xml,
 * /news-sitemap.xml, the JSON-LD generators and the /debug Discover Kit
 * so they can never drift apart.
 *
 * (The older routes keep their own local SITE_URL constants — this module
 * is the going-forward home; new code imports from HERE.)
 */

export const SITE_URL = 'https://neutralwire.org'

export const SITE_NAME = 'NeutralWire'

export const SITE_TAGLINE =
  'See how every outlet spins the same story — left, centre and right, side by side.'

export const SITE_DESCRIPTION =
  'NeutralWire compares how left, right, and centre outlets cover the SAME story — side by side. See the bias, spot the spin, decide for yourself. Free, no paywalls, auto-detects your country.'

/** Publisher logo for JSON-LD (NewsMediaOrganization.image). */
export const SITE_LOGO_URL = `${SITE_URL}/icon-512.png`

/**
 * Composite 1200×630 OG image for any topic (photo + NW logo + bias bar).
 * Always renders — even when the story has no photo — which makes it the
 * guaranteed-safe og:image for social previews.
 */
export function ogImageForTopic(topicId: string): string {
  return `/api/og-image?topicId=${encodeURIComponent(topicId)}`
}

/**
 * Proxied hero image for a raw article photo (bypasses referrer/CORS
 * blocks; served with 7-day CDN caching — see /api/img).
 * Returns null when the story has no photo (NEVER a black placeholder).
 */
export function heroImageForUrl(imageUrl: string | null | undefined): string | null {
  if (!imageUrl || typeof imageUrl !== 'string') return null
  return `/api/img?url=${encodeURIComponent(imageUrl)}`
}
