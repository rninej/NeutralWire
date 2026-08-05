import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { firebaseRead } from '@/lib/firebase-server'
import type { TopicArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 15

// Cache the base64-encoded bold font so we only read it once per instance.
let boldFontB64: string | null = null
async function getBoldFontB64(): Promise<string> {
  if (boldFontB64) return boldFontB64
  try {
    const fontPath = join(process.cwd(), 'src/app/api/og-image/fonts/bold.ttf')
    const fontBuffer = await readFile(fontPath)
    boldFontB64 = fontBuffer.toString('base64')
    return boldFontB64
  } catch {
    return ''
  }
}

/**
 * Generate a dynamic OG image for a shared topic link.
 *
 * The image is a 1200x630 composite:
 *   - Article image (fetched + resized to fill the canvas)
 *   - NW logo badge (bottom-right corner — white circle with "NW" text)
 *   - Chunky bias bar (bottom — L/C/R counts as colored segments with
 *     the numbers rendered inside each segment)
 *
 * Uses an embedded bold font (base64 @font-face in the SVG) so text
 * renders correctly in sharp's SVG renderer (which has no system fonts).
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
      return generateFallbackImage('Story not found')
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

    // ── 3. Load the bold font (base64 for SVG @font-face) ──
    const fontB64 = await getBoldFontB64()

    // ── 4. Build the composite image (1200x630) ──
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

    // ── 5. Build the chunky bias bar with numbers ──
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

      // Left segment (blue) with rounded left corners
      if (leftW > 0) {
        const clip = `M${barX + 8} ${barY} L${barX + leftW} ${barY} L${barX + leftW} ${barY + barHeight} L${barX + 8} ${barY + barHeight} Q${barX} ${barY + barHeight} ${barX} ${barY + barHeight - 8} L${barX} ${barY + 8} Q${barX} ${barY} ${barX + 8} ${barY} Z`
        biasBarSvg += `<path d="${clip}" fill="#3b82f6"/>`
        if (leftW > 30) {
          biasBarSvg += `<text x="${barX + leftW / 2}" y="${barY + barHeight / 2 + 8}" font-family="NWBold" font-size="24" fill="#fff" text-anchor="middle">${leanLeft}</text>`
        }
      }

      // Center segment (grey)
      if (centerW > 0) {
        biasBarSvg += `<rect x="${barX + leftW}" y="${barY}" width="${centerW}" height="${barHeight}" fill="#71717a"/>`
        if (centerW > 30) {
          biasBarSvg += `<text x="${barX + leftW + centerW / 2}" y="${barY + barHeight / 2 + 8}" font-family="NWBold" font-size="24" fill="#fff" text-anchor="middle">${leanCenter}</text>`
        }
      }

      // Right segment (red) with rounded right corners
      if (rightW > 0) {
        const rightX = barX + leftW + centerW
        const clip = `M${rightX} ${barY} L${rightX + rightW - 8} ${barY} Q${rightX + rightW} ${barY} ${rightX + rightW} ${barY + 8} L${rightX + rightW} ${barY + barHeight - 8} Q${rightX + rightW} ${barY + barHeight} ${rightX + rightW - 8} ${barY + barHeight} L${rightX} ${barY + barHeight} Z`
        biasBarSvg += `<path d="${clip}" fill="#ef4444"/>`
        if (rightW > 30) {
          biasBarSvg += `<text x="${rightX + rightW / 2}" y="${barY + barHeight / 2 + 8}" font-family="NWBold" font-size="24" fill="#fff" text-anchor="middle">${leanRight}</text>`
        }
      }
    }

    // ── 6. Build the NW logo badge (bottom-right) ──
    const logoSize = 72
    const logoX = W - logoSize - 24
    const logoY = barY - logoSize - 12

    const logoSvg = `
      <circle cx="${logoX + logoSize / 2}" cy="${logoY + logoSize / 2}" r="${logoSize / 2 + 4}" fill="#000" opacity="0.6"/>
      <circle cx="${logoX + logoSize / 2}" cy="${logoY + logoSize / 2}" r="${logoSize / 2}" fill="#fff"/>
      <text x="${logoX + logoSize / 2}" y="${logoY + logoSize / 2 + 11}" font-family="NWBold" font-size="32" fill="#0a0a0a" text-anchor="middle">NW</text>
    `

    // ── 7. Build the full SVG with embedded font ──
    // The @font-face embeds the bold TTF as base64 so sharp's SVG renderer
    // (resvg) can render text without system fonts. Without this, text
    // shows as "tofu" boxes (□□□).
    const fontFace = fontB64
      ? `<style>@font-face { font-family: "NWBold"; src: url(data:font/ttf;base64,${fontB64}) format("truetype"); }</style>`
      : ''

    const overlaySvg = Buffer.from(`
      <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        ${fontFace}
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
    return generateFallbackImage('NeutralWire')
  }
}

async function generateFallbackImage(text: string): Promise<NextResponse> {
  const W = 1200
  const H = 630
  const fontB64 = await getBoldFontB64()
  const fontFace = fontB64
    ? `<style>@font-face { font-family: "NWBold"; src: url(data:font/ttf;base64,${fontB64}) format("truetype"); }</style>`
    : ''
  const svg = Buffer.from(`
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      ${fontFace}
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#0a0a0a"/>
          <stop offset="100%" stop-color="#1a1a1a"/>
        </linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#bg)"/>
      <text x="${W / 2}" y="${H / 2}" font-family="NWBold" font-size="48" fill="#fff" text-anchor="middle">${text}</text>
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
