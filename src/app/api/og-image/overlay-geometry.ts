/**
 * ── OG overlay geometry — SINGLE SOURCE OF TRUTH ──────────────────────
 *
 * Shared by:
 *   - route.ts            (runtime compositing)
 *   - scripts/gen-og-overlays.ts (build-time pre-rendering of the
 *     NEUTRALWIRE banner PNG + the fallback JPEG)
 *
 * ── WHY THIS EXISTS (Fluid Active CPU) ──
 * The old route rasterized a FULL 1200x630 SVG canvas (756k px) on every
 * request: the bias bar + the 11 NEUTRALWIRE letter paths + the digit
 * paths, all through librsvg + sharp. Now:
 *
 *   1. The NEUTRALWIRE banner (shadow + pill + letters — 100% static,
 *      byte-for-byte identical on every render) is PRE-BAKED ONCE into
 *      a transparent PNG (see overlay-assets.ts). Per request it is a
 *      cheap raster composite — zero vector rasterization.
 *
 *   2. The bias bar (variable segment widths + percentages, so it must
 *      stay dynamic) is rasterized as a TINY 1160x52 region SVG instead
 *      of the full canvas — 92% less rasterization area — and composited
 *      at its exact device position.
 *
 * PIXEL IDENTITY: every shape keeps its exact device-pixel coordinates
 * (integer translate of (-20, -558) for the bar region; the banner PNG
 * is extracted/composited at the same integer device origin), and PNG
 * encode/decode is lossless — so the composed output is pixel-identical
 * to the old full-canvas render. Verified by scripts/test-og-pixels.mjs.
 */

import { renderTextAsPaths, renderTextAsPathsSpaced } from './char-paths'

// ── Canvas ──
export const OG_W = 1200
export const OG_H = 630

// ── Bias bar geometry (absolute device coords) ──
const BAR_HEIGHT = 52
const BAR_PADDING = 20
export const BAR = {
  x: BAR_PADDING, // 20
  y: OG_H - BAR_HEIGHT - 20, // 558
  width: OG_W - BAR_PADDING * 2, // 1160
  height: BAR_HEIGHT,
  radius: BAR_HEIGHT / 2, // 26 (pill)
} as const

// ── NEUTRALWIRE banner geometry (absolute device coords) ──
const BANNER_TEXT = 'NEUTRALWIRE'
const BANNER_HEIGHT = 72
const BANNER_CHAR_HEIGHT = 50
const BANNER_LETTER_SPACING = 12
const BANNER_CHAR_WIDTH = 100 * (BANNER_CHAR_HEIGHT / 140) * 0.6
const BANNER_TEXT_WIDTH =
  BANNER_TEXT.length * BANNER_CHAR_WIDTH + (BANNER_TEXT.length - 1) * BANNER_LETTER_SPACING
const BANNER_WIDTH = BANNER_TEXT_WIDTH + 56
const BANNER_X = OG_W - BANNER_WIDTH - 24
const BANNER_Y = BAR.y - BANNER_HEIGHT - 16
const BANNER_RADIUS = 14

/**
 * The integer device rectangle that fully contains the banner layer
 * (shadow rect + pill + letters), including every anti-aliased edge
 * pixel. The pre-baked PNG is exactly this region; the route composites
 * it back at the same origin — pixels land on the same device coords
 * they always did.
 *
 * bannerX-4 = 760.2857… (fractional) → start at integer 760 (the extra
 * 0.28px sliver of columns is transparent, compositing it is a no-op).
 */
export const BANNER_REGION = {
  left: 760,
  top: BANNER_Y - 4, // 466
  width: 421, // 760 → 1180 inclusive (banner right edge lands exactly on 1180)
  height: 81, // 466 → 546 inclusive (shadow bottom edge lands exactly on 546)
} as const

/**
 * Full-canvas banner layer (TRANSPARENT background) — used ONLY by the
 * build-time generator: rasterized once, extracted to BANNER_REGION,
 * saved as a lossless PNG.
 */
export function buildBannerLayerSvg(): string {
  return `<svg width="${OG_W}" height="${OG_H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${BANNER_X - 4}" y="${BANNER_Y - 4}" width="${BANNER_WIDTH + 8}" height="${BANNER_HEIGHT + 8}" rx="${BANNER_RADIUS + 4}" fill="#000" opacity="0.5"/>
      <rect x="${BANNER_X}" y="${BANNER_Y}" width="${BANNER_WIDTH}" height="${BANNER_HEIGHT}" rx="${BANNER_RADIUS}" fill="#0a0a0a"/>
      ${renderTextAsPathsSpaced(BANNER_TEXT, BANNER_X + BANNER_WIDTH / 2, BANNER_Y + (BANNER_HEIGHT - BANNER_CHAR_HEIGHT) / 2, BANNER_CHAR_HEIGHT, '#fff', BANNER_LETTER_SPACING)}
    </svg>`
}

/**
 * The bias bar as a REGION-sized SVG (width=BAR.width, height=BAR.height).
 *
 * Identical geometry to the old full-canvas version — every element is
 * translated by the integer vector (-BAR.x, -BAR.y) so the rasterized
 * shapes land on exactly the same device pixels when composited at
 * (left: BAR.x, top: BAR.y).
 *
 * Returns null when there is no bar (total === 0) — same as before.
 */
export function buildBiasBarRegionSvg(
  leanLeft: number,
  leanCenter: number,
  leanRight: number,
): Buffer | null {
  const total = leanLeft + leanCenter + leanRight
  if (total <= 0) return null

  const leftW = (leanLeft / total) * BAR.width
  const centerW = (leanCenter / total) * BAR.width
  const rightW = (leanRight / total) * BAR.width

  let svg = ''
  const clipId = 'barClip'
  // All coordinates are REGION-relative: absolute coord − (BAR.x, BAR.y).
  svg += `<defs><clipPath id="${clipId}"><rect x="0" y="0" width="${BAR.width}" height="${BAR.height}" rx="${BAR.radius}" ry="${BAR.radius}"/></clipPath></defs>`

  // Dark background (visible through any gaps)
  svg += `<rect x="0" y="0" width="${BAR.width}" height="${BAR.height}" rx="${BAR.radius}" fill="#000" opacity="0.8"/>`

  // Segments (clipped to pill shape)
  svg += `<g clip-path="url(#${clipId})">`
  if (leftW > 0) {
    svg += `<rect x="0" y="0" width="${leftW}" height="${BAR.height}" fill="#3b82f6"/>`
  }
  if (centerW > 0) {
    svg += `<rect x="${leftW}" y="0" width="${centerW}" height="${BAR.height}" fill="#71717a"/>`
  }
  if (rightW > 0) {
    svg += `<rect x="${leftW + centerW}" y="0" width="${rightW}" height="${BAR.height}" fill="#ef4444"/>`
  }
  svg += `</g>`

  // Percentages drawn as SVG paths (same 7-segment digit style + sizes)
  const lPct = Math.round((leanLeft / total) * 100)
  const cPct = Math.round((leanCenter / total) * 100)
  const rPct = Math.round((leanRight / total) * 100)
  const digitTopY = (BAR.height - 34) / 2 // was barY + (barHeight-34)/2 − barY
  if (leftW > 35) {
    svg += renderTextAsPaths(String(lPct), leftW / 2, digitTopY, 34, '#fff')
  }
  if (centerW > 35) {
    svg += renderTextAsPaths(String(cPct), leftW + centerW / 2, digitTopY, 34, '#fff')
  }
  if (rightW > 35) {
    svg += renderTextAsPaths(String(rPct), leftW + centerW + rightW / 2, digitTopY, 34, '#fff')
  }

  return Buffer.from(
    `<svg width="${BAR.width}" height="${BAR.height}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`,
  )
}

/**
 * The static fallback OG image (dark gradient + big NW monogram).
 * Rendered ONCE at build time by the generator — the runtime serves the
 * pre-baked JPEG bytes with zero sharp work. Same SVG string + same
 * encoder settings (`.jpeg({ quality: 85 })`, no mozjpeg) as the old
 * runtime path, so the bytes are identical.
 */
export function buildFallbackSvg(): string {
  const nwPaths = renderTextAsPaths('NW', OG_W / 2, OG_H / 2 - 70, 140, '#fff')
  return `
    <svg width="${OG_W}" height="${OG_H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#0a0a0a"/>
          <stop offset="100%" stop-color="#1a1a1a"/>
        </linearGradient>
      </defs>
      <rect width="${OG_W}" height="${OG_H}" fill="url(#bg)"/>
      ${nwPaths}
    </svg>
  `
}

// ── Exposed for the pixel-identity test (old pipeline reconstruction) ──
export const BANNER_GEOMETRY = {
  x: BANNER_X,
  y: BANNER_Y,
  width: BANNER_WIDTH,
  height: BANNER_HEIGHT,
  radius: BANNER_RADIUS,
  text: BANNER_TEXT,
} as const
