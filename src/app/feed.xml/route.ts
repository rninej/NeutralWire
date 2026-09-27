import { NextRequest, NextResponse } from 'next/server'
import { readCachedNews } from '@/lib/news-cache'
import { SITE_URL, SITE_NAME } from '@/lib/site'

/**
 * ── RSS 2.0 feed — the Google Discover / Publisher Center surface ──
 *
 * Full-content feed of the top wire: real titles, summaries, dates and
 * STABLE GUIDs (the topicId — the same id /story/<id> serves, so a feed
 * item and its article URL can never drift apart).
 *
 * ── Bandwidth safety (the 6.2 GB rule) ──
 * ONE room read per regeneration: readCachedNews('top') goes through the
 * ETag conditional-read layer → a warm serverless instance pays 0 bytes
 * when the room is unchanged (which is ~30 min at a time). The response
 * is served from the Vercel CDN for 15 minutes (s-maxage) with
 * stale-while-revalidate, and carries its own ETag so repeat consumers
 * (Publisher Center's crawler, feed readers) get a zero-byte 304.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_ITEMS = 30
const CDN_CACHE = 'public, s-maxage=900, stale-while-revalidate=3600'

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** RFC-822 date (RSS spec) from a ms epoch. */
function rfc822(ts: number): string {
  return new Date(ts).toUTCString()
}

function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, ']]&gt;')}]]>`
}

export async function GET(req: NextRequest) {
  let items = ''
  let updatedAt = Date.now()

  try {
    const payload = await readCachedNews('top')
    updatedAt = payload?.updatedAt || updatedAt
    const topics = (payload?.topics || []).slice(0, MAX_ITEMS)

    for (const t of topics) {
      if (!t?.topicId || !t.title) continue
      const link = `${SITE_URL}/story/${encodeURIComponent(t.topicId)}`
      const desc = t.summary
        ? `${t.summary} — compared across ${t.articles?.length || 0} outlets, left to right.`
        : `How ${t.articles?.length || 'multiple'} outlets across the political spectrum cover this story.`
      items += [
        '    <item>',
        `      <title>${cdata(t.title)}</title>`,
        `      <link>${xmlEscape(link)}</link>`,
        `      <guid isPermaLink="false">${xmlEscape(t.topicId)}</guid>`,
        `      <pubDate>${rfc822(t.latestSeen || t.firstSeen || updatedAt)}</pubDate>`,
        `      <description>${cdata(desc)}</description>`,
        '    </item>',
      ].join('\n')
    }
  } catch {
    // Firebase hiccup → still emit a valid (empty) channel below.
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xmlEscape(SITE_NAME)}</title>
    <link>${SITE_URL}</link>
    <description>${xmlEscape('How left, centre and right outlets cover the SAME story — side by side. See the bias, spot the spin, decide for yourself.')}</description>
    <language>en</language>
    <lastBuildDate>${rfc822(updatedAt)}</lastBuildDate>
    <docs>https://www.rssboard.org/rss-specification</docs>
    <atom:link href="${SITE_URL}/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`

  // Feed-level ETag: repeat consumers (feed readers, Publisher Center)
  // revalidate with If-None-Match and get a zero-byte 304.
  const etag = `"nw-feed-${updatedAt}"`
  if (req.headers.get('if-none-match') === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': CDN_CACHE },
    })
  }

  return new NextResponse(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': CDN_CACHE,
      ETag: etag,
    },
  })
}
