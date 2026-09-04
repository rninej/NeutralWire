/**
 * Build-time generator for the OG image's STATIC overlay assets.
 *
 * Run:  bun scripts/gen-og-overlays.ts
 *
 * Produces src/app/api/og-image/overlay-assets.ts containing:
 *   - BANNER_PNG_BASE64  — the NEUTRALWIRE banner layer (shadow + pill +
 *     letter paths) pre-rasterized as a lossless transparent PNG at its
 *     exact device-pixel position. Composited per request as a raster —
 *     zero librsvg work for the banner.
 *   - FALLBACK_JPG_BASE64 — the "no topic" fallback image, rendered ONCE
 *     through the exact same sharp pipeline the runtime used
 *     (`.jpeg({ quality: 85 })`, no mozjpeg) so the served bytes are
 *     identical to what the old runtime produced.
 *
 * The geometry comes from overlay-geometry.ts (single source of truth),
 * so the pre-baked assets can never drift from the runtime layout.
 */

import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildBannerLayerSvg,
  buildFallbackSvg,
  BANNER_REGION,
} from '../src/app/api/og-image/overlay-geometry'

async function main() {
  // ── 1. Banner layer → lossless PNG at its exact device region ──
  // Rendered on a full transparent 1200x630 canvas (identical librsvg
  // conditions to the old runtime), then cropped to BANNER_REGION and
  // composited back at the same origin by the route — same pixels,
  // no vector work per request.
  const bannerPng = await sharp(Buffer.from(buildBannerLayerSvg()))
    .extract({
      left: BANNER_REGION.left,
      top: BANNER_REGION.top,
      width: BANNER_REGION.width,
      height: BANNER_REGION.height,
    })
    .png({ compressionLevel: 9 })
    .toBuffer()

  // ── 2. Fallback OG image → JPEG, exact old pipeline settings ──
  const fallbackJpg = await sharp(Buffer.from(buildFallbackSvg()))
    .jpeg({ quality: 85 })
    .toBuffer()

  const bannerInfo = await sharp(bannerPng).metadata()
  const fallbackInfo = await sharp(fallbackJpg).metadata()

  const out = `/**
 * ── GENERATED FILE — DO NOT EDIT BY HAND ─────────────────────────────
 * Produced by scripts/gen-og-overlays.ts from overlay-geometry.ts.
 * Regenerate with: bun scripts/gen-og-overlays.ts
 *
 * Pre-baked OG overlay assets (Fluid Active CPU optimization):
 *
 *   BANNER_PNG_BASE64 — the NEUTRALWIRE banner rendered once as a
 *   lossless transparent PNG (${bannerInfo.width}x${bannerInfo.height},
 *   ${bannerPng.length} bytes). Compositing this raster at request time
 *   replaces rasterizing 11 letter paths through librsvg on a full
 *   1200x630 canvas — identical pixels, ~zero CPU.
 *
 *   FALLBACK_JPG_BASE64 — the static "topic not found" OG image
 *   (${fallbackInfo.width}x${fallbackInfo.height}, ${fallbackJpg.length}
 *   bytes), rendered through the exact pipeline the route used at
 *   runtime (sharp(svg).jpeg({ quality: 85 })). Served byte-for-byte
 *   identical with ZERO sharp work per request.
 */

export const BANNER_PNG_BASE64 = ${JSON.stringify(bannerPng.toString('base64'))}

export const FALLBACK_JPG_BASE64 = ${JSON.stringify(fallbackJpg.toString('base64'))}
`

  const outPath = fileURLToPath(
    new URL('../src/app/api/og-image/overlay-assets.ts', import.meta.url),
  )
  fs.writeFileSync(outPath, out)

  console.log(
    `[gen-og-overlays] banner.png ${bannerInfo.width}x${bannerInfo.height} ` +
      `(${bannerPng.length} bytes) + fallback.jpg ${fallbackInfo.width}x${fallbackInfo.height} ` +
      `(${fallbackJpg.length} bytes) → ${outPath}`,
  )
}

main().catch((err) => {
  console.error('[gen-og-overlays] FAILED:', err)
  process.exit(1)
})
