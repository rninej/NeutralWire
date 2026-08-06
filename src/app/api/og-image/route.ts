import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'
import { firebaseRead } from '@/lib/firebase-server'
import type { TopicArticle } from '@/lib/news-aggregator'
import { renderTextAsPaths, renderTextAsPathsSpaced } from './char-paths'

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
      // Check ALL live news cache categories (not just a few) so every
      // topic can be found for OG image generation.
      const cacheCategories = [
        'relevant', 'top', 'world', 'politics', 'business',
        'technology', 'science', 'health', 'sports',
      ]
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
      // Check mycountry caches for common country codes
      if (!topic) {
        const myCountryCodes = ['GB', 'US', 'IN', 'HK', 'AU', 'CA', 'IE', 'NZ']
        for (const cc of myCountryCodes) {
          try {
            const payload = await firebaseRead<{ topics?: TopicArticle[] }>(`newsCache/mycountry__${cc}`)
            if (payload?.topics) {
              topic = payload.topics.find((t) => t.topicId === topicId) || null
              if (topic) break
            }
          } catch {
            // continue
          }
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

    // ── 4. Build the chunky bias bar with pill-shaped edges + numbers ──
    // The bar is fully rounded (pill shape) on the outer edges. Inner
    // segment borders are straight. Numbers are solid (not segmented).
    const barHeight = 52
    const barPadding = 20
    const barWidth = W - barPadding * 2
    const barX = barPadding
    const barY = H - barHeight - 20
    const radius = barHeight / 2 // pill shape = radius = half height

    let biasBarSvg = ''
    if (total > 0) {
      const leftW = (leanLeft / total) * barWidth
      const centerW = (leanCenter / total) * barWidth
      const rightW = (leanRight / total) * barWidth

      // Use a clipPath to make the entire bar pill-shaped (rounded ends).
      // All segments are drawn as plain rectangles, then clipped to the
      // pill shape. This gives clean rounded outer edges without complex
      // per-segment path math.
      const clipId = 'barClip'
      biasBarSvg += `<defs><clipPath id="${clipId}"><rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="${radius}" ry="${radius}"/></clipPath></defs>`

      // Dark background (visible through any gaps)
      biasBarSvg += `<rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="${radius}" fill="#000" opacity="0.8"/>`

      // Segments (clipped to pill shape)
      biasBarSvg += `<g clip-path="url(#${clipId})">`
      if (leftW > 0) {
        biasBarSvg += `<rect x="${barX}" y="${barY}" width="${leftW}" height="${barHeight}" fill="#3b82f6"/>`
      }
      if (centerW > 0) {
        biasBarSvg += `<rect x="${barX + leftW}" y="${barY}" width="${centerW}" height="${barHeight}" fill="#71717a"/>`
      }
      if (rightW > 0) {
        const rightX = barX + leftW + centerW
        biasBarSvg += `<rect x="${rightX}" y="${barY}" width="${rightW}" height="${barHeight}" fill="#ef4444"/>`
      }
      biasBarSvg += `</g>`

      // Percentages (drawn as <text> elements with sans-serif font).
      // We use font-family="sans-serif" (the generic family) which
      // sharp's SVG renderer (librsvg) supports. Specific fonts like
      // "Arial" don't work and render as tofu boxes.
      const lPct = Math.round((leanLeft / total) * 100)
      const cPct = Math.round((leanCenter / total) * 100)
      const rPct = Math.round((leanRight / total) * 100)
      const textY = barY + barHeight / 2 + 12 // vertically centered (font baseline)
      if (leftW > 35) {
        biasBarSvg += `<text x="${barX + leftW / 2}" y="${textY}" font-family="sans-serif" font-size="28" font-weight="bold" fill="#fff" text-anchor="middle">${lPct}</text>`
      }
      if (centerW > 35) {
        biasBarSvg += `<text x="${barX + leftW + centerW / 2}" y="${textY}" font-family="sans-serif" font-size="28" font-weight="bold" fill="#fff" text-anchor="middle">${cPct}</text>`
      }
      if (rightW > 35) {
        const rightX = barX + leftW + centerW
        biasBarSvg += `<text x="${rightX + rightW / 2}" y="${textY}" font-family="sans-serif" font-size="28" font-weight="bold" fill="#fff" text-anchor="middle">${rPct}</text>`
      }
    }

    // ── 5. Build the "NEUTRALWIRE" rectangle banner (bottom-right) ──
    // Uses <text> with font-family="sans-serif" (works in sharp's renderer)
    // and letter-spacing for readability.
    const bannerText = 'NEUTRALWIRE'
    const bannerHeight = 60
    const bannerFontSize = 32
    // Approximate text width: char_count * font_size * 0.65 + letter_spacing
    const letterSp = 4
    const bannerTextWidth = bannerText.length * bannerFontSize * 0.65 + (bannerText.length - 1) * letterSp
    const bannerWidth = bannerTextWidth + 48
    const bannerX = W - bannerWidth - 24
    const bannerY = barY - bannerHeight - 16
    const bannerRadius = 12

    const logoSvg = `
      <rect x="${bannerX - 4}" y="${bannerY - 4}" width="${bannerWidth + 8}" height="${bannerHeight + 8}" rx="${bannerRadius + 4}" fill="#000" opacity="0.5"/>
      <rect x="${bannerX}" y="${bannerY}" width="${bannerWidth}" height="${bannerHeight}" rx="${bannerRadius}" fill="#0a0a0a"/>
      <text x="${bannerX + bannerWidth / 2}" y="${bannerY + bannerHeight / 2 + 11}" font-family="sans-serif" font-size="${bannerFontSize}" font-weight="bold" fill="#fff" text-anchor="middle" letter-spacing="${letterSp}">${bannerText}</text>
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
