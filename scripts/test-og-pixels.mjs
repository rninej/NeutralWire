/**
 * PIXEL-IDENTITY VERIFICATION for the OG image optimization.
 *
 * Run:  bun scripts/test-og-pixels.mjs
 *
 * Reconstructs the OLD pipeline (full-canvas 1200x630 overlay SVG with the
 * bias bar in absolute coordinates + the NEUTRALWIRE banner, rasterized
 * per request) and the NEW pipeline (region-sized bar SVG + pre-baked
 * banner PNG composite), renders both for several bias combinations, and
 * compares the final JPEG output pixel-by-pixel (decoded to raw RGBA).
 *
 * PASS = every case byte-identical (or genuinely pixel-identical after
 * JPEG decode). The user requirement: the image must not change one bit.
 */

import sharp from 'sharp'
import {
  OG_W,
  OG_H,
  BAR,
  BANNER_REGION,
  BANNER_GEOMETRY,
  buildBiasBarRegionSvg,
  buildBannerLayerSvg,
} from '../src/app/api/og-image/overlay-geometry.ts'
import {
  BANNER_PNG_BASE64,
  FALLBACK_JPG_BASE64,
} from '../src/app/api/og-image/overlay-assets.ts'
import {
  renderTextAsPaths,
  renderTextAsPathsSpaced,
} from '../src/app/api/og-image/char-paths.ts'

// ── OLD pipeline reconstruction (verbatim geometry from the pre-change route) ──
function buildOldOverlaySvg(leanLeft, leanCenter, leanRight) {
  const W = OG_W
  const H = OG_H
  const barHeight = BAR.height
  const barPadding = BAR.x
  const barWidth = W - barPadding * 2
  const barX = barPadding
  const barY = H - barHeight - 20
  const radius = barHeight / 2
  const total = leanLeft + leanCenter + leanRight

  let biasBarSvg = ''
  if (total > 0) {
    const leftW = (leanLeft / total) * barWidth
    const centerW = (leanCenter / total) * barWidth
    const rightW = (leanRight / total) * barWidth

    const clipId = 'barClip'
    biasBarSvg += `<defs><clipPath id="${clipId}"><rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="${radius}" ry="${radius}"/></clipPath></defs>`
    biasBarSvg += `<rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="${radius}" fill="#000" opacity="0.8"/>`
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

    const lPct = Math.round((leanLeft / total) * 100)
    const cPct = Math.round((leanCenter / total) * 100)
    const rPct = Math.round((leanRight / total) * 100)
    if (leftW > 35) {
      biasBarSvg += renderTextAsPaths(
        String(lPct),
        barX + leftW / 2,
        barY + (barHeight - 34) / 2,
        34,
        '#fff',
      )
    }
    if (centerW > 35) {
      biasBarSvg += renderTextAsPaths(
        String(cPct),
        barX + leftW + centerW / 2,
        barY + (barHeight - 34) / 2,
        34,
        '#fff',
      )
    }
    if (rightW > 35) {
      const rightX = barX + leftW + centerW
      biasBarSvg += renderTextAsPaths(
        String(rPct),
        rightX + rightW / 2,
        barY + (barHeight - 34) / 2,
        34,
        '#fff',
      )
    }
  }

  // Banner (verbatim from the old route)
  const bannerText = BANNER_GEOMETRY.text
  const bannerHeight = BANNER_GEOMETRY.height
  const bannerCharHeight = 50
  const letterSpacing = 12
  const bannerCharWidth = 100 * (bannerCharHeight / 140) * 0.6
  const bannerTextWidth =
    bannerText.length * bannerCharWidth + (bannerText.length - 1) * letterSpacing
  const bannerWidth = bannerTextWidth + 56
  const bannerX = BANNER_GEOMETRY.x
  const bannerY = BANNER_GEOMETRY.y
  const bannerRadius = BANNER_GEOMETRY.radius

  const logoSvg = `
      <rect x="${bannerX - 4}" y="${bannerY - 4}" width="${bannerWidth + 8}" height="${bannerHeight + 8}" rx="${bannerRadius + 4}" fill="#000" opacity="0.5"/>
      <rect x="${bannerX}" y="${bannerY}" width="${bannerWidth}" height="${bannerHeight}" rx="${bannerRadius}" fill="#0a0a0a"/>
      ${renderTextAsPathsSpaced(
        bannerText,
        bannerX + bannerWidth / 2,
        bannerY + (bannerHeight - bannerCharHeight) / 2,
        bannerCharHeight,
        '#fff',
        letterSpacing,
      )}
    `

  return Buffer.from(`
      <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        ${biasBarSvg}
        ${logoSvg}
      </svg>
    `)
}

// ── Deterministic synthetic base images (stand-ins for the article photo) ──
async function makeBase(variant) {
  if (variant === 0) {
    // Solid mid-tone (any alpha/AA rounding shows loudly)
    return sharp({
      create: { width: OG_W, height: OG_H, channels: 3, background: { r: 90, g: 120, b: 160 } },
    }).png().toBuffer()
  }
  if (variant === 1) {
    // Busy gradient (like a real photo)
    const svg = Buffer.from(
      `<svg width="${OG_W}" height="${OG_H}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="0.7" y2="1"><stop offset="0%" stop-color="#c2541a"/><stop offset="35%" stop-color="#e8b06b"/><stop offset="70%" stop-color="#27618f"/><stop offset="100%" stop-color="#0c2135"/></linearGradient></defs><rect width="${OG_W}" height="${OG_H}" fill="url(#g)"/></svg>`,
    )
    return sharp(svg).resize(OG_W, OG_H, { fit: 'cover', position: 'center' }).png().toBuffer()
  }
  // Dark gradient (same as the route's no-article background)
  const svg = Buffer.from(
    `<svg width="${OG_W}" height="${OG_H}"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0a0a"/><stop offset="100%" stop-color="#1a1a1a"/></linearGradient></defs><rect width="${OG_W}" height="${OG_H}" fill="url(#bg)"/></svg>`,
  )
  return sharp(svg).png().toBuffer()
}

async function renderOld(baseBuffer, leanLeft, leanCenter, leanRight) {
  const base = sharp(baseBuffer).resize(OG_W, OG_H, { fit: 'cover', position: 'center' })
  const overlay = buildOldOverlaySvg(leanLeft, leanCenter, leanRight)
  return base
    .composite([{ input: overlay, blend: 'over' }])
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer()
}

async function renderNew(baseBuffer, leanLeft, leanCenter, leanRight) {
  const base = sharp(baseBuffer).resize(OG_W, OG_H, { fit: 'cover', position: 'center' })
  const composites = []
  const barSvg = buildBiasBarRegionSvg(leanLeft, leanCenter, leanRight)
  if (barSvg) {
    composites.push({ input: barSvg, left: BAR.x, top: BAR.y, blend: 'over' })
  }
  composites.push({
    input: Buffer.from(BANNER_PNG_BASE64, 'base64'),
    left: BANNER_REGION.left,
    top: BANNER_REGION.top,
    blend: 'over',
  })
  return base.composite(composites).jpeg({ quality: 85, mozjpeg: true }).toBuffer()
}

async function diffBuffers(bufA, bufB) {
  if (bufA.equals(bufB)) return { identical: true, jpegBytes: true }
  const [rawA, rawB] = await Promise.all([
    sharp(bufA).raw().toBuffer(),
    sharp(bufB).raw().toBuffer(),
  ])
  if (rawA.equals(rawB)) return { identical: true, jpegBytes: false }
  let maxDiff = 0
  let differing = 0
  for (let i = 0; i < rawA.length; i++) {
    const d = Math.abs(rawA[i] - rawB[i])
    if (d > 0) {
      differing++
      if (d > maxDiff) maxDiff = d
    }
  }
  return { identical: false, jpegBytes: false, maxDiff, differingBytes: differing }
}

async function main() {
  const cases = [
    [5, 2, 3],
    [0, 4, 0],
    [10, 0, 0],
    [1, 1, 1],
    [0, 0, 0],
    [3, 0, 9],
    [7, 12, 2],
  ]
  const bases = await Promise.all([makeBase(0), makeBase(1), makeBase(2)])

  let pass = 0
  let fail = 0

  for (let b = 0; b < bases.length; b++) {
    for (const [l, c, r] of cases) {
      const oldBuf = await renderOld(bases[b], l, c, r)
      const newBuf = await renderNew(bases[b], l, c, r)
      const result = await diffBuffers(oldBuf, newBuf)
      const label = `base#${b} lean(${l},${c},${r})`
      if (result.identical) {
        pass++
        console.log(
          `  PASS ${label} — ${result.jpegBytes ? 'byte-identical JPEG' : 'pixel-identical after decode'}`,
        )
      } else {
        fail++
        console.log(
          `  FAIL ${label} — maxDiff=${result.maxDiff} differingBytes=${result.differingBytes}`,
        )
      }
    }
  }

  // ── Fallback image: old runtime pipeline vs pre-baked bytes ──
  {
    const nwPaths = renderTextAsPaths('NW', OG_W / 2, OG_H / 2 - 70, 140, '#fff')
    const oldSvg = Buffer.from(`
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
  `)
    const oldFallback = await sharp(oldSvg).jpeg({ quality: 85 }).toBuffer()
    const newFallback = Buffer.from(FALLBACK_JPG_BASE64, 'base64')
    const result = await diffBuffers(oldFallback, newFallback)
    if (result.identical) {
      pass++
      console.log(`  PASS fallback image — ${result.jpegBytes ? 'byte-identical JPEG' : 'pixel-identical after decode'}`)
    } else {
      fail++
      console.log(`  FAIL fallback image — maxDiff=${result.maxDiff} differingBytes=${result.differingBytes}`)
    }
  }

  // ── Banner layer standalone: old full-canvas region vs pre-baked PNG ──
  {
    const oldFull = await sharp(Buffer.from(buildBannerLayerSvg()))
      .extract({
        left: BANNER_REGION.left,
        top: BANNER_REGION.top,
        width: BANNER_REGION.width,
        height: BANNER_REGION.height,
      })
      .png()
      .toBuffer()
    const newBanner = Buffer.from(BANNER_PNG_BASE64, 'base64')
    const result = await diffBuffers(oldFull, newBanner)
    if (result.identical) {
      pass++
      console.log(`  PASS banner PNG — ${result.jpegBytes ? 'byte-identical' : 'pixel-identical after decode'}`)
    } else {
      fail++
      console.log(`  FAIL banner PNG — maxDiff=${result.maxDiff} differingBytes=${result.differingBytes}`)
    }
  }

  console.log(`\n[test-og-pixels] ${pass} passed, ${fail} failed (of ${pass + fail})`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error('[test-og-pixels] FAILED:', err)
  process.exit(1)
})
