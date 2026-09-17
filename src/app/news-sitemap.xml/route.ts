import { NextRequest, NextResponse } from 'next/server'
import { readCachedNews } from '@/lib/news-cache'
import { SITE_URL } from '@/lib/site'

/**
 * ── Google News sitemap (the freshness contract for Discover) ──
 *
 * Lists ONLY stories published in the last 48 hours (Google News sitemap
 * spec: articles ≤2 days old), each with:
 *   <loc>          → the /story/<id> crawlable page
 *   <news:news>    → publication name, language, date, title
 *   <image:image>  → the story's photo (the explicit "use this picture"
 *                    signal that helps Discover pick the card image)
 *
 * ── Bandwidth safety (the 6.2 GB rule) ──
 * Same design as /feed.xml: ONE ETag-cached room read ('top') per
 * regeneration, Vercel CDN serves the XML for 15 minutes (s-maxage) with
 * stale-while-revalidate, and the response ETag gives crawlers zero-byte
 * 304s. The static /sitemap.xml stays the default sitemap in robots.txt;
 * this one is the news-specific companion (also referenced in robots.txt).
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FRESH_WINDOW_MS = 48 * 60 * 60 * 1000 // Google News sitemap: ≤48h
const MAX_URLS = 200
const CDN_CACHE = 'public, s-maxage=900, stale-while-revalidate=3600'

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function w3cDate(ts: number): string {
  return new Date(ts).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function GET(req: NextRequest) {
  let urls = ''
  let count = 0
  let lastmod = Date.now()

  try {
    const payload = await readCachedNews('top')
    lastmod = payload?.updatedAt || lastmod
    const now = Date.now()
    const topics = (payload?.topics || [])
      .filter((t) => {
        const ts = t?.latestSeen || t?.firstSeen || 0
        return t?.topicId && t?.title && now - ts <= FRESH_WINDOW_MS
      })
      .slice(0, MAX_URLS)

    for (const t of topics) {
      const ts = t.latestSeen || t.firstSeen || lastmod
      const loc = `${SITE_URL}/story/${encodeURIComponent(t.topicId)}`
      const image = t.imageUrl
        ? `      <image:image>\n        <image:loc>${xmlEscape(
            `${SITE_URL}/api/img?url=${encodeURIComponent(t.imageUrl)}`,
          )}</image:loc>\n        <image:title>${xmlEscape(t.title.slice(0, 90))}</image:title>\n      </image:image>\n`
        : ''
      urls += [
        '  <url>',
        `    <loc>${xmlEscape(loc)}</loc>`,
        `    <lastmod>${w3cDate(ts)}</lastmod>`,
        `    <news:news>`,
        '      <news:publication>',
        '        <news:name>NeutralWire</news:name>',
        '        <news:language>en</news:language>',
        '      </news:publication>',
        `      <news:publication_date>${w3cDate(ts)}</news:publication_date>`,
        `      <news:title>${xmlEscape(t.title.slice(0, 110))}</news:title>`,
        '    </news:news>',
        image ? image.trimEnd() : '',
        '  </url>',
      ]
        .filter(Boolean)
        .join('\n')
      count++
    }
  } catch {
    // Firebase hiccup → still emit a valid (empty) sitemap below.
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls}
</urlset>`

  const etag = `"nw-news-${lastmod}-${count}"`
  if (req.headers.get('if-none-match') === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': CDN_CACHE },
    })
  }

  return new NextResponse(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': CDN_CACHE,
      ETag: etag,
    },
  })
}
