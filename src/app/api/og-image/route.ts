import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'
import { firebaseRead } from '@/lib/firebase-server'
import type { TopicArticle } from '@/lib/news-aggregator'
import { renderTextAsPaths } from './char-paths'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 15

/**
 * Generate a dynamic OG image for a shared topic link.
 *
 * The image is a 1200x630 composite:
 *   - Article image (fetched + resized to fill the canvas)
 *   - NW logo badge (bottom-right corner — white circle with "NW" drawn
 *     as SVG paths, NOT font-based text)
 *   - Chunky bias bar (bottom — L/C/R counts as colored segments with
 *     the numbers drawn as SVG paths inside each segment)
 *
 * IMPORTANT: All text is rendered as SVG vector paths, NOT <text> elements.
 * Sharp's SVG renderer (librsvg) has no system fonts and @font-face with
 * base64 TTF doesn't work reliably — it shows "tofu" boxes (□) instead
 * of actual characters. Drawing as paths guarantees the text always
 * renders correctly regardless of the server environment.
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
    // ── 1. Fetch the topic from Firebase ──
    let topic: (TopicArticle & { archivedAt?: number }) | null = null
    try {
      topic = await firebaseRead<TopicArticle & { archivedAt?: number }>(`archive/${topicId}`)
    } catch {
      // silent
    }

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
      return generateFallbackImage()
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
        // fall back to dark background
      }
    }

    // ── 3. Build the composite image (1200x630) ──
    const W = 1200
    const H = 630

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

    // ── 4. Build the chunky bias bar with numbers (as SVG paths) ──
    const barHeight = 48
    const barPadding = 20
    const barWidth = W - barPadding * 2
    const barX = barPadding
    const barY = H - barHeight - 20

    let biasBarSvg = ''
    if (total > 0) {
      const leftW = (leanLeft / total) * barWidth
      const centerW = (leanCenter / total) * barWidth
      const rightW = (leanRight / total) * barWidth

      // Dark background bar (rounded)
      biasBarSvg += `<rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="8" fill="#000" opacity="0.7"/>`

      // Left segment (blue)
      if (leftW > 0) {
        const clip = `M${barX + 8} ${barY} L${barX + leftW} ${barY} L${barX + leftW} ${barY + barHeight} L${barX + 8} ${barY + barHeight} Q${barX} ${barY + barHeight} ${barX} ${barY + barHeight - 8} L${barX} ${barY + 8} Q${barX} ${barY} ${barX + 8} ${barY} Z`
        biasBarSvg += `<path d="${clip}" fill="#3b82f6"/>`
        // Draw the number as SVG paths (NOT <text>)
        if (leftW > 30) {
          biasBarSvg += renderTextAsPaths(
            String(leanLeft),
            barX + leftW / 2, // center X
            barY + 8,         // top Y (centered in 48px bar: 8px padding top, 32px text)
            32,               // character height
            '#fff',           // white
          )
        }
      }

      // Center segment (grey)
      if (centerW > 0) {
        biasBarSvg += `<rect x="${barX + leftW}" y="${barY}" width="${centerW}" height="${barHeight}" fill="#71717a"/>`
        if (centerW > 30) {
          biasBarSvg += renderTextAsPaths(
            String(leanCenter),
            barX + leftW + centerW / 2,
            barY + 8,
            32,
            '#fff',
          )
        }
      }

      // Right segment (red)
      if (rightW > 0) {
        const rightX = barX + leftW + centerW
        const clip = `M${rightX} ${barY} L${rightX + rightW - 8} ${barY} Q${rightX + rightW} ${barY} ${rightX + rightW} ${barY + 8} L${rightX + rightW} ${barY + barHeight - 8} Q${rightX + rightW} ${barY + barHeight} ${rightX + rightW - 8} ${barY + barHeight} L${rightX} ${barY + barHeight} Z`
        biasBarSvg += `<path d="${clip}" fill="#ef4444"/>`
        if (rightW > 30) {
          biasBarSvg += renderTextAsPaths(
            String(leanRight),
            rightX + rightW / 2,
            barY + 8,
            32,
            '#fff',
          )
        }
      }
    }

    // ── 5. Build the NW logo badge (bottom-right) ──
    // White circle with "NW" drawn as SVG paths inside.
    const logoSize = 72
    const logoX = W - logoSize - 24
    const logoY = barY - logoSize - 12 // above the bias bar

    const logoSvg = `
      <circle cx="${logoX + logoSize / 2}" cy="${logoY + logoSize / 2}" r="${logoSize / 2 + 4}" fill="#000" opacity="0.6"/>
      <circle cx="${logoX + logoSize / 2}" cy="${logoY + logoSize / 2}" r="${logoSize / 2}" fill="#fff"/>
      ${renderTextAsPaths('NW', logoX + logoSize / 2, logoY + 18, 36, '#0a0a0a')}
    `

    // ── 6. Composite everything ──
    const overlaySvg = Buffer.from(`
      <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        ${biasBarSvg}
        ${logoSvg}
      </svg>
    `)

    const composite = base.composite([{ input: overlaySvg, blend: 'over' }])

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
    return generateFallbackImage()
  }
}

/**
 * Generate a simple fallback OG image (dark background + NW paths).
 */
async function generateFallbackImage(): Promise<NextResponse> {
  const W = 1200
  const H = 630
  const nwPaths = renderTextAsPaths('NW', W / 2, H / 2 - 70, 140, '#fff')
  const svg = Buffer.from(`
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#0a0a0a"/>
          <stop offset="100%" stop-color="#1a1a1a"/>
        </linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#bg)"/>
      ${nwPaths}
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
