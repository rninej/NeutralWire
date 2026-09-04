import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'
import { findTopicAnywhere } from '@/lib/topic-lookup'
import type { TopicArticle } from '@/lib/news-aggregator'
import { BANNER_PNG_BASE64, FALLBACK_JPG_BASE64 } from './overlay-assets'
import { OG_W, OG_H, BAR, BANNER_REGION, buildBiasBarRegionSvg } from './overlay-geometry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 15

/**
 * Generate a dynamic OG image for a shared topic link.
 *
 * The image is a 1200x630 composite:
 *   - Article image (fetched + resized to fill the canvas)
 *   - NEUTRALWIRE banner (bottom-right) — PRE-BAKED as a lossless
 *     transparent PNG (see overlay-assets.ts, generated once by
 *     scripts/gen-og-overlays.ts from overlay-geometry.ts). Composited
 *     as a raster at its exact device position — pixel-identical to the
 *     old per-request librsvg render (verified by
 *     scripts/test-og-pixels.mjs: byte-identical JPEG output), but with
 *     ~zero CPU: no letter-path rasterization per request.
 *   - Chunky bias bar (bottom) — L/C/R counts as colored segments with
 *     the numbers drawn as SVG paths inside each segment. The bar is
 *     variable per story, so it stays dynamic, but it renders as a
 *     TINY 1160x52 region SVG (92% less rasterization area than the old
 *     full 1200x630 canvas) composited at its exact device position.
 *
 * ── Fluid Active CPU context ──
 * This route runs once per unique notification/share unfurl (the OS or
 * messenger fetches the image URL; the CDN caches it for 7 days after).
 * The old route rasterized the full canvas (756k px) + 11 letter paths +
 * digit paths through librsvg on EVERY render. The new route decodes a
 * 4.8KB PNG + rasterizes a 60k px bar region — the sharp work is now
 * dominated by the (unavoidable) base resize + mozjpeg encode, and the
 * overlay rendering cost is effectively eliminated. Verified output is
 * byte-for-byte identical — the image does not change one bit.
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

// ── Pre-baked overlay assets (decoded once per instance, then reused) ──
// Buffer.from(base64) of ~15KB combined is a memcpy — negligible on a
// cold start, and it means zero sharp/librsvg work for the static layers.
let bannerPngBuffer: Buffer | null = null
function getBannerPng(): Buffer {
  if (!bannerPngBuffer) {
    bannerPngBuffer = Buffer.from(BANNER_PNG_BASE64, 'base64')
  }
  return bannerPngBuffer
}

let fallbackJpgBuffer: Buffer | null = null
function getFallbackJpg(): Buffer {
  if (!fallbackJpgBuffer) {
    fallbackJpgBuffer = Buffer.from(FALLBACK_JPG_BASE64, 'base64')
  }
  return fallbackJpgBuffer
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const topicId = sp.get('topicId') || ''
  if (!topicId) {
    return NextResponse.json({ error: 'Missing topicId' }, { status: 400 })
  }

  // ── Allow override params for faster notification image generation ──
  // When the cron trigger sends a push notification, it passes the bias
  // counts + imageUrl directly so the OG image route doesn't need to
  // read from Firebase. This saves ~200ms per notification.
  const overrideTitle = sp.get('title')
  const overrideImageUrl = sp.get('imageUrl')
  const overrideLeanLeft = sp.get('leanLeft')
  const overrideLeanCenter = sp.get('leanCenter')
  const overrideLeanRight = sp.get('leanRight')
  const hasOverrides = overrideLeanLeft !== null && overrideLeanRight !== null

  try {
    // ── 1. Fetch the topic (skip if overrides provided) ──
    // ONE shared lookup — archive first, then EVERY live newsCache key
    // (dynamically listed). Fixes the bug where topics in country caches
    // (relevant__CC etc.) produced a generic OG image with no article photo.
    let topic: (TopicArticle & { archivedAt?: number }) | null = null

    if (!hasOverrides) {
      topic = await findTopicAnywhere(topicId)
    } // end if (!hasOverrides)

    // If overrides were provided, construct a minimal topic object
    if (!topic && hasOverrides) {
      topic = {
        topicId,
        title: overrideTitle || '',
        summary: '',
        imageUrl: overrideImageUrl || null,
        coverage: 0,
        leanLeft: parseInt(overrideLeanLeft || '0', 10),
        leanCenter: parseInt(overrideLeanCenter || '0', 10),
        leanRight: parseInt(overrideLeanRight || '0', 10),
        firstSeen: Date.now(),
        latestSeen: Date.now(),
        articles: [],
      } as TopicArticle
    }

    if (!topic) {
      return serveFallbackImage()
    }

    const { imageUrl, leanLeft = 0, leanCenter = 0, leanRight = 0 } = topic

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

    // ── 3. Build the base layer (article photo or dark gradient) ──
    let base: sharp.Sharp
    if (articleImageBuffer) {
      base = sharp(articleImageBuffer)
        .resize(OG_W, OG_H, { fit: 'cover', position: 'center' })
    } else {
      const gradient = Buffer.from(
        `<svg width="${OG_W}" height="${OG_H}">
          <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#0a0a0a"/>
              <stop offset="100%" stop-color="#1a1a1a"/>
            </linearGradient>
          </defs>
          <rect width="${OG_W}" height="${OG_H}" fill="url(#bg)"/>
        </svg>`
      )
      base = sharp(gradient).png()
    }

    // ── 4. Composite the overlay IMAGE layers ──
    // (a) Bias bar — variable widths/percentages, so it renders as a tiny
    //     1160x52 region SVG at its exact device position (same geometry
    //     as the old full-canvas version: integer translate of (-20,-558)).
    // (b) NEUTRALWIRE banner — pre-baked raster PNG at its exact device
    //     region. Zero vector work.
    // The two regions do not overlap (banner rows 466-546, bar rows
    // 558-610), so compositing order is irrelevant — the result is
    // byte-identical to the old single-overlay render (verified).
    const composites: sharp.OverlayOptions[] = []
    const barRegionSvg = buildBiasBarRegionSvg(leanLeft, leanCenter, leanRight)
    if (barRegionSvg) {
      composites.push({ input: barRegionSvg, left: BAR.x, top: BAR.y, blend: 'over' })
    }
    composites.push({
      input: getBannerPng(),
      left: BANNER_REGION.left,
      top: BANNER_REGION.top,
      blend: 'over',
    })

    const composite = base.composite(composites)

    const outputBuffer = await composite
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer()

    // sharp's Buffer isn't assignable to BodyInit under TS 5.9's stricter
    // ArrayBuffer generics — the runtime handles it fine, so cast.
    return new NextResponse(outputBuffer as unknown as BodyInit, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400, s-maxage=604800',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (err) {
    console.error('[og-image] Error:', err)
    return serveFallbackImage()
  }
}

/**
 * Serve the fallback OG image (dark background + NW monogram).
 *
 * The image bytes are PRE-BAKED (rendered once at build time through the
 * exact same sharp pipeline this route used — `.jpeg({ quality: 85 })`,
 * no mozjpeg), so serving a fallback costs ZERO sharp work: just the
 * cached Buffer + response headers. Byte-for-byte identical output
 * (verified by scripts/test-og-pixels.mjs).
 */
function serveFallbackImage(): NextResponse {
  return new NextResponse(getFallbackJpg() as unknown as BodyInit, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
