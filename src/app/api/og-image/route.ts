import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'
import { firebaseRead } from '@/lib/firebase-server'
import type { TopicArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
// OG image generation involves fetching the article image + compositing —
// can take 3-5s. 15s is a safe ceiling.
export const maxDuration = 15

// Cache the NW logo in memory (read once from disk, reused across requests)
let nwLogoBuffer: Buffer | null = null
async function getNwLogo(): Promise<Buffer | null> {
  if (nwLogoBuffer) return nwLogoBuffer
  try {
    // Use the icon-512.png as the NW logo, trimmed to a circular badge
    const logo = await sharp('public/icon-512.png')
      .resize(120, 120, { fit: 'cover' })
      .composite([{
        input: Buffer.from('<svg width="120" height="120"><circle cx="60" cy="60" r="60" fill="#fff"/></svg>'),
        blend: 'dest-in',
      }])
      .png()
      .toBuffer()
    nwLogoBuffer = logo
    return logo
  } catch {
    return null
  }
}

/**
 * Generate a dynamic OG image for a shared topic link.
 *
 * The image is a 1200x630 composite:
 *   - Article image (fetched + resized to fill the canvas)
 *   - NW logo badge (bottom-right corner, 96px circle with white background)
 *   - Bias bar (bottom of the image, showing L/C/R coverage proportions)
 *
 * If the article image can't be fetched, falls back to a dark background
 * with the NW logo + bias bar (so the preview ALWAYS shows, never a broken
 * image).
 *
 * Usage:
 *   /api/og-image?topicId=abc123
 *
 * The image is cached by the SW (cache-first) and by WhatsApp's crawler
 * (which caches OG images for ~7 days). So the generation cost is amortized.
 */
export async function GET(req: NextRequest) {
  const topicId = req.nextUrl.searchParams.get('topicId') || ''
  if (!topicId) {
    return NextResponse.json({ error: 'Missing topicId' }, { status: 400 })
  }

  try {
    // ── 1. Fetch the topic from Firebase (archive first, then cache) ──
    let topic: (TopicArticle & { archivedAt?: number }) | null = null
    try {
      topic = await firebaseRead<TopicArticle & { archivedAt?: number }>(`archive/${topicId}`)
    } catch {
      // silent
    }

    // Fallback: check the live news cache for this topic
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

    if (!topic) {
      // Topic not found — return a default OG image
      return generateFallbackImage('Story not found — NeutralWire')
    }

    const { imageUrl, leanLeft = 0, leanCenter = 0, leanRight = 0, title } = topic
    const total = leanLeft + leanCenter + leanRight

    // ── 2. Fetch the article image ──
    let articleImageBuffer: Buffer | null = null
    if (imageUrl) {
      try {
        const imgRes = await fetch(imageUrl, {
          signal: AbortSignal.timeout(8000),
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; NeutralWireBot/1.0; +https://neutralwire.org)',
            Accept: 'image/*',
          },
        })
        if (imgRes.ok) {
          const ct = imgRes.headers.get('content-type') || ''
          if (ct.startsWith('image/')) {
            articleImageBuffer = Buffer.from(await imgRes.arrayBuffer())
          }
        }
      } catch {
        // Image fetch failed — we'll use the fallback background
      }
    }

    // ── 3. Build the composite image (1200x630) ──
    const W = 1200
    const H = 630

    // Base: article image (or dark fallback)
    let base: sharp.Sharp
    if (articleImageBuffer) {
      base = sharp(articleImageBuffer)
        .resize(W, H, { fit: 'cover', position: 'center' })
    } else {
      // Dark gradient fallback
      const gradient = Buffer.from(
        `<svg width="${W}" height="${H}">
          <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#0a0a0a"/>
              <stop offset="100%" stop-color="#1a1a1a"/>
            </linearGradient>
          </defs>
          <rect width="${W}" height="${H}" fill="url(#bg)"/>
        </svg>`
      )
      base = sharp(gradient).png()
    }

    // ── 4. Build the bias bar SVG overlay ──
    // Position: bottom of the image, full width, 12px tall
    const barHeight = 14
    const barY = H - barHeight - 16 // 16px padding from bottom
    const barWidth = W - 32 // 16px padding left/right
    const barX = 16

    let biasBarSvg = ''
    if (total > 0) {
      const leftPct = (leanLeft / total) * 100
      const centerPct = (leanCenter / total) * 100
      const rightPct = (leanRight / total) * 100

      // Build the bar segments with rounded corners on the outer edges
      const leftW = (leftPct / 100) * barWidth
      const centerW = (centerPct / 100) * barWidth
      const rightW = (rightPct / 100) * barWidth

      biasBarSvg = `
        <rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="7" fill="#000" opacity="0.5"/>
        ${leftW > 0 ? `<rect x="${barX}" y="${barY}" width="${leftW}" height="${barHeight}" rx="7" fill="#3b82f6"/>` : ''}
        ${centerW > 0 ? `<rect x="${barX + leftW}" y="${barY}" width="${centerW}" height="${barHeight}" fill="#71717a"/>` : ''}
        ${rightW > 0 ? `<rect x="${barX + leftW + centerW}" y="${barY}" width="${rightW}" height="${barHeight}" rx="7" fill="#ef4444"/>` : ''}
      `
    }

    // ── 5. Build the NW logo badge (bottom-right) ──
    // 80px circle with white background + NW icon
    const logoSize = 80
    const logoX = W - logoSize - 24 // 24px padding from right
    const logoY = H - logoSize - 40 // above the bias bar

    const logoBadgeSvg = `
      <circle cx="${logoX + logoSize / 2}" cy="${logoY + logoSize / 2}" r="${logoSize / 2 + 4}" fill="#000" opacity="0.6"/>
      <circle cx="${logoX + logoSize / 2}" cy="${logoY + logoSize / 2}" r="${logoSize / 2}" fill="#fff"/>
    `

    // ── 6. Composite everything ──
    const overlaySvg = Buffer.from(`
      <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        ${biasBarSvg}
        ${logoBadgeSvg}
      </svg>
    `)

    let composite = base.composite([{ input: overlaySvg, blend: 'over' }])

    // Add the NW logo image on top of the white circle
    const logo = await getNwLogo()
    if (logo) {
      composite = composite.composite([{
        input: await sharp(logo).resize(logoSize - 16, logoSize - 16).toBuffer(),
        blend: 'over',
        top: logoY + 8,
        left: logoX + 8,
      }])
    }

    // ── 7. Output as JPEG (smaller than PNG for OG images) ──
    const outputBuffer = await composite
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer()

    return new NextResponse(outputBuffer, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400, s-maxage=604800',
        // Allow WhatsApp/Twitter/etc crawlers to fetch this
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (err) {
    console.error('[og-image] Error:', err)
    return generateFallbackImage('NeutralWire')
  }
}

/**
 * Generate a simple fallback OG image (dark background + NW text).
 * Used when the topic or article image can't be found.
 */
async function generateFallbackImage(text: string): Promise<NextResponse> {
  const W = 1200
  const H = 630
  const svg = Buffer.from(`
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#0a0a0a"/>
          <stop offset="100%" stop-color="#1a1a1a"/>
        </linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#bg)"/>
      <text x="${W / 2}" y="${H / 2}" font-family="-apple-system, sans-serif" font-size="48" font-weight="bold" fill="#fff" text-anchor="middle">${text}</text>
    </svg>
  `)
  const buf = await sharp(svg).jpeg({ quality: 85 }).toBuffer()
  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
