import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead, firebaseReadShallow } from '@/lib/firebase-server'
import { SITE_URL, ogImageForTopic } from '@/lib/site'
import type { TopicArticle } from '@/lib/news-aggregator'

/**
 * ── Google News sitemap (the freshness contract for Discover) ──
 *
 * Lists ONLY stories published in the last 48 hours (Google News sitemap
 * spec: articles ≤2 days old), each with:
 *   <loc>          → the /story/<id> crawlable page
 *   <news:news>    → publication name, language, date, title
 *   <image:image>  → the NOTIFICATION composite (story photo + NEUTRALWIRE
 *                    banner + L/C/R bias bar, rendered by /api/og-image —
 *                    the branded image Google should index, per the Sep
 *                    2026 user request). Same URL as the story page's
 *                    og:image, so one CDN render serves both.
 *
 * ── AUTO-UPDATES (the Sep 2026 sitemap fix) ──
 * The sitemap previously listed ONLY the 'top' room — stories surfaced in
 * any OTHER live room (relevant__GB, world, politics, mycountry__GB, …)
 * appeared in NO sitemap at all, which is exactly how story pages ended
 * up "failed to be indexed" in Search Console. Now EVERY live room is
 * scanned (priority rooms first, deduped by topicId, capped), and because
 * the route is CDN-cached for 15 minutes with stale-while-revalidate, it
 * re-derives itself from the live rooms on every crawl — new stories from
 * each 30-min cron refresh are in the sitemap within ≤15 min, with fresh
 * <lastmod> values Google re-crawls. No static file, no manual updates.
 *
 * ── Bandwidth safety (the 6.2 GB rule) ──
 *   - ONE shallow key listing (~48 key names, <1KB) per regeneration.
 *   - Rooms are read through firebaseRead's ETag cache — a room that did
 *     not change since the last regeneration (only ~3 rooms change per
 *     30-min cron tick) costs ZERO bytes (HTTP 304).
 *   - The scan STOPS as soon as MAX_URLS fresh stories are collected, so
 *     a warm sitemap typically reads just the first 3-6 rooms.
 *   - Vercel CDN serves the XML for 15 minutes (s-maxage) with
 *     stale-while-revalidate, and the response ETag gives crawlers
 *     zero-byte 304s. The static /sitemap.xml stays the default sitemap
 *     in robots.txt; this one is the news-specific companion.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FRESH_WINDOW_MS = 48 * 60 * 60 * 1000 // Google News sitemap: ≤48h
const MAX_URLS = 200
const CDN_CACHE = 'public, s-maxage=900, stale-while-revalidate=3600'

/** Scanned first — cheapest + most likely to fill the sitemap alone. */
const PRIORITY_ROOMS = ['top', 'relevant', 'world', 'politics', 'relevant__INT']

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

/** Priority rooms first, then plain categories, then country variants. */
function orderRooms(keys: string[]): string[] {
  const priority = PRIORITY_ROOMS.filter((p) => keys.includes(p))
  const plain = keys.filter((k) => !PRIORITY_ROOMS.includes(k) && !k.includes('__'))
  const country = keys.filter((k) => !PRIORITY_ROOMS.includes(k) && k.includes('__'))
  return [...priority, ...plain, ...country]
}

interface SitemapTopic {
  topicId: string
  title: string
  ts: number // latestSeen || firstSeen
}

export async function GET(req: NextRequest) {
  const now = Date.now()
  const seen = new Set<string>()
  const topics: SitemapTopic[] = []
  let lastmod = 0

  try {
    // ── List every live room (shallow — key names only, <1KB) ──
    const keys = await firebaseReadShallow('newsCache')
    const rooms = orderRooms(keys.length > 0 ? keys : PRIORITY_ROOMS)

    // ── Scan rooms until we have MAX_URLS fresh, deduped stories ──
    for (const room of rooms) {
      if (topics.length >= MAX_URLS) break
      // firebaseRead → ETag-cached: unchanged rooms cost 0 bytes.
      const payload = await firebaseRead<{ updatedAt?: number; topics?: TopicArticle[] }>(
        `newsCache/${room}`,
      )
      const roomTopics = payload?.topics
      if (!Array.isArray(roomTopics)) continue
      if (payload?.updatedAt && payload.updatedAt > lastmod) {
        lastmod = payload.updatedAt
      }
      for (const t of roomTopics) {
        if (topics.length >= MAX_URLS) break
        const ts = t?.latestSeen || t?.firstSeen || 0
        if (!t?.topicId || !t?.title || now - ts > FRESH_WINDOW_MS) continue
        if (seen.has(t.topicId)) continue
        seen.add(t.topicId)
        topics.push({ topicId: t.topicId, title: t.title, ts })
        if (ts > lastmod) lastmod = ts
      }
    }
  } catch {
    // Firebase hiccup → still emit a valid (empty) sitemap below.
  }

  if (lastmod === 0) lastmod = Date.now()

  let urls = ''
  for (const t of topics) {
    const loc = `${SITE_URL}/story/${encodeURIComponent(t.topicId)}`
    // The branded notification composite (photo + NW banner + bias bar) —
    // the SAME URL the story page uses as its primary og:image, so the
    // CDN render is shared between sitemap crawls, social unfurls and
    // the page hero.
    const image = `      <image:image>\n        <image:loc>${xmlEscape(
      new URL(ogImageForTopic(t.topicId), SITE_URL).toString(),
    )}</image:loc>\n        <image:title>${xmlEscape(t.title.slice(0, 90))}</image:title>\n      </image:image>\n`
    urls += [
      '  <url>',
      `    <loc>${xmlEscape(loc)}</loc>`,
      `    <lastmod>${w3cDate(t.ts)}</lastmod>`,
      `    <news:news>`,
      '      <news:publication>',
      '        <news:name>NeutralWire</news:name>',
      '        <news:language>en</news:language>',
      '      </news:publication>',
      `      <news:publication_date>${w3cDate(t.ts)}</news:publication_date>`,
      `      <news:title>${xmlEscape(t.title.slice(0, 110))}</news:title>`,
      '    </news:news>',
      image.trimEnd(),
      '  </url>',
    ]
      .filter(Boolean)
      .join('\n')
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls}
</urlset>`

  const etag = `"nw-news-${lastmod}-${topics.length}"`
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
