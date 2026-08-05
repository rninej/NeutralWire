import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'
import { firebaseRead } from '@/lib/firebase-server'
import type { TopicArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 15

/**
 * Generate a dynamic OG image for a shared topic link.
 *
 * The image is a 1200x630 composite:
 *   - Article image (fetched + resized to fill the canvas)
 *   - NW logo badge (bottom-right corner — white circle with "NW" text)
 *   - Chunky bias bar (bottom of image — showing L/C/R counts as colored
 *     segments with the numbers inside each segment)
 *
 * If the article image can't be fetched, falls back to a dark background
 * with the NW logo + bias bar (so the preview ALWAYS shows, never a broken
 * image).
 *
 * Usage:
 *   /api/og-image?topicId=abc123
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
      return generateFallbackImage('Story not found — NeutralWire')
    }

    const { imageUrl, leanLeft = 0, leanCenter = 0, leanRight = 0 } = topic
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

    // ── 4. Build the chunky bias bar with numbers ──
    // The bar is at the bottom of the image, full width, 48px tall.
    // Each segment is proportional to its count, with the number centered
    // inside. Colors: blue (left), grey (center), red (right).
    const barHeight = 48
    const barPadding = 20
    const barWidth = W - barPadding * 2
    const barX = barPadding
    const barY = H - barHeight - 20 // 20px from bottom

    let biasBarSvg = ''
    if (total > 0) {
      const leftW = (leanLeft / total) * barWidth
      const centerW = (leanCenter / total) * barWidth
      const rightW = (leanRight / total) * barWidth

      // Background bar (dark, rounded)
      biasBarSvg += `<rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="8" fill="#000" opacity="0.7"/>`

      // Left segment (blue) — only if > 0
      if (leftW > 0) {
        // Clip the left side to rounded corners
        const leftClip = `M${barX + 8} ${barY} L${barX + leftW} ${barY} L${barX + leftW} ${barY + barHeight} L${barX + 8} ${barY + barHeight} Q${barX} ${barY + barHeight} ${barX} ${barY + barHeight - 8} L${barX} ${barY + 8} Q${barX} ${barY} ${barX + 8} ${barY} Z`
        biasBarSvg += `<path d="${leftClip}" fill="#3b82f6"/>`
        // Number inside (only if segment is wide enough)
        if (leftW > 30) {
          biasBarSvg += `<text x="${barX + leftW / 2}" y="${barY + barHeight / 2 + 7}" font-family="Arial, sans-serif" font-size="22" font-weight="bold" fill="#fff" text-anchor="middle">${leanLeft}</text>`
        }
      }

      // Center segment (grey)
      if (centerW > 0) {
        biasBarSvg += `<rect x="${barX + leftW}" y="${barY}" width="${centerW}" height="${barHeight}" fill="#71717a"/>`
        if (centerW > 30) {
          biasBarSvg += `<text x="${barX + leftW + centerW / 2}" y="${barY + barHeight / 2 + 7}" font-family="Arial, sans-serif" font-size="22" font-weight="bold" fill="#fff" text-anchor="middle">${leanCenter}</text>`
        }
      }

      // Right segment (red) — rounded right corners
      if (rightW > 0) {
        const rightX = barX + leftW + centerW
        const rightClip = `M${rightX} ${barY} L${rightX + rightW - 8} ${barY} Q${rightX + rightW} ${barY} ${rightX + rightW} ${barY + 8} L${rightX + rightW} ${barY + barHeight - 8} Q${rightX + rightW} ${barY + barHeight} ${rightX + rightW - 8} ${barY + barHeight} L${rightX} ${barY + barHeight} Z`
        biasBarSvg += `<path d="${rightClip}" fill="#ef4444"/>`
        if (rightW > 30) {
          biasBarSvg += `<text x="${rightX + rightW / 2}" y="${barY + barHeight / 2 + 7}" font-family="Arial, sans-serif" font-size="22" font-weight="bold" fill="#fff" text-anchor="middle">${leanRight}</text>`
        }
      }
    }

    // ── 5. Build the NW logo badge (bottom-right) ──
    // White circle with "NW" text inside. Positioned to the right of the
    // bias bar, above it.
    const logoSize = 72
    const logoX = W - logoSize - 24
    const logoY = barY - logoSize - 12 // above the bias bar

    const logoSvg = `
      <circle cx="${logoX + logoSize / 2}" cy="${logoY + logoSize / 2}" r="${logoSize / 2 + 4}" fill="#000" opacity="0.6"/>
      <circle cx="${logoX + logoSize / 2}" cy="${logoY + logoSize / 2}" r="${logoSize / 2}" fill="#fff"/>
      <text x="${logoX + logoSize / 2}" y="${logoY + logoSize / 2 + 12}" font-family="Arial, sans-serif" font-size="30" font-weight="900" fill="#0a0a0a" text-anchor="middle">NW</text>
    `

    // ── 6. Composite everything ──
    const overlaySvg = Buffer.from(`
      <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        ${biasBarSvg}
        ${logoSvg}
      </svg>
    `)

    const composite = base.composite([{ input: overlaySvg, blend: 'over' }])

    // ── 7. Output as JPEG ──
    const outputBuffer = await composite
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer()

    return new NextResponse(outputBuffer, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400, s-maxage=604800',
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
      <text x="${W / 2}" y="${H / 2}" font-family="Arial, sans-serif" font-size="48" font-weight="bold" fill="#fff" text-anchor="middle">${text}</text>
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
