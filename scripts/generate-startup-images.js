import sharp from 'sharp'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * generate-startup-images.js — iOS PWA launch ("apple-touch-startup-image")
 * set for NeutralWire.
 *
 * WHY: iOS ignores the manifest's background_color for the home-screen app
 * launch screen — without startup images it shows a plain WHITE screen for
 * a beat before the first paint. That white flash sat right before our dark
 * tri-color splash. These static PNGs are a FRAME of that exact splash
 * (dark #0a0a0a, blue/red corner glows, NeutralWire wordmark, converging
 * tri-color bias bar, LEFT · CENTER · RIGHT tagline), so iOS users get:
 *   OS launch (this static frame) → CSS splash (same design, animates)
 *   → app — one continuous dark branded moment, zero white flash.
 *
 * HOW iOS picks one: it matches <link rel="apple-touch-startup-image"
 * media="(device-width: Wpx) and (device-height: Hpx) and
 * (-webkit-device-pixel-ratio: D) and (orientation: …)"> against the device.
 * We generate one PNG per modern iPhone portrait size + iPad portrait AND
 * landscape sizes (iPhone launch is locked to portrait by the manifest's
 * orientation: portrait-primary; iPads can rotate). Rendered at physical
 * pixels (CSS size × dpr) so viewportFit=cover full-screen sizes are exact.
 *
 * Regenerate with:  node scripts/generate-startup-images.js
 * (or: bun scripts/generate-startup-images.js)
 */

// ── Device matrix: [cssWidth, cssHeight, dpr] ──
// iPhone portrait (orientation locked to portrait by the manifest).
const IPHONES = [
  [320, 568, 2], // 5 / SE(1st)
  [375, 667, 2], // 6 / 7 / 8 / SE(2nd/3rd)
  [375, 812, 3], // X / XS / 11 Pro / 12 mini / 13 mini
  [390, 844, 3], // 12 / 12 Pro / 13 / 13 Pro / 14 / 16e
  [393, 852, 3], // 14 Pro / 15 / 15 Pro / 16
  [402, 874, 3], // 16 Pro
  [414, 736, 3], // 6 / 7 / 8 Plus
  [414, 896, 2], // XR / 11
  [414, 896, 3], // XS Max / 11 Pro Max
  [428, 926, 3], // 12 / 13 / 14 Pro Max · 14 / 15 Plus
  [430, 932, 3], // 14 / 15 Pro Max · 16 Plus
  [440, 956, 3], // 16 Pro Max
]

// iPad (portrait AND landscape — tablets rotate even with the orientation lock).
const IPADS = [
  [768, 1024, 2], // mini (legacy) / 9.7 / Pro 9.7
  [810, 1080, 2], // iPad 10.2
  [820, 1180, 2], // Air 10.9
  [834, 1112, 2], // Pro 10.5
  [834, 1194, 2], // Pro 11
  [744, 1133, 2], // mini 6 / 7
  [1024, 1366, 2], // Pro 12.9 / 13
]

// ── Brand constants (match the animated splash's dark design exactly) ──
const BG = '#0a0a0a'
const WORD_COLOR = '#ececec'
const TAG_COLOR = '#9a9a9a'
const SEG_BLUE = '#3b82f6'
const SEG_GREY = '#a1a1a1' // dark-mode grey segment from the animated splash
const SEG_RED = '#ef4444'
const ORB_BLUE = 'rgba(59,130,246,0.38)'
const ORB_RED = 'rgba(239,68,68,0.34)'

/**
 * Build the splash-frame SVG at PHYSICAL pixel size.
 * All CSS-pixel values from the animated splash are multiplied by dpr so the
 * static frame lines up 1:1 with what the CSS splash then animates.
 */
function buildSvg(cssW, cssH, dpr) {
  const W = cssW * dpr
  const H = cssH * dpr

  // Splash metrics (css px) → physical px.
  const wordSize = 26 * dpr
  const barW = Math.min(0.62 * cssW, 300) * dpr
  const barH = 12 * dpr
  const gap = 16 * dpr
  const tagSize = 11 * dpr
  const tagTrack = 0.24 * tagSize

  // Vertical block: wordmark + gap + bar + gap + tagline, centered.
  const blockH = wordSize + gap + barH + gap + tagSize
  const y0 = (H - blockH) / 2
  const cx = W / 2
  const wordY = y0 + wordSize * 0.8 // baseline ≈ 80% of cap height
  const barY = y0 + wordSize + gap
  const tagY = barY + barH + gap + tagSize * 0.8

  // Bar segments: blue 37% | grey 26% | red 37% (same as the animated bar).
  const segB = barW * 0.37
  const segG = barW * 0.26
  const barX = cx - barW / 2
  // Track behind the segments (matches the CSS rgba(127,127,127,.16) rail).
  const railY = barY
  const railH = barH

  // Corner glow radii — sized to the largest dimension (the CSS orbs are
  // 62vmax circles parked off the corners; userSpaceOnUse gradients in
  // real pixels approximate them).
  const orbR = Math.max(W, H) * 0.55
  const bx = 0.16 * W
  const by = 0.1 * H
  const rx = 0.84 * W
  const ry = 0.9 * H

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="ob" gradientUnits="userSpaceOnUse" cx="${bx}" cy="${by}" r="${orbR}">
      <stop offset="0" stop-color="${ORB_BLUE}"/>
      <stop offset="1" stop-color="rgba(59,130,246,0)"/>
    </radialGradient>
    <radialGradient id="or" gradientUnits="userSpaceOnUse" cx="${rx}" cy="${ry}" r="${orbR}">
      <stop offset="0" stop-color="${ORB_RED}"/>
      <stop offset="1" stop-color="rgba(239,68,68,0)"/>
    </radialGradient>
    <clipPath id="barclip">
      <rect x="${barX}" y="${railY}" width="${barW}" height="${railH}" rx="${railH / 2}"/>
    </clipPath>
  </defs>

  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect width="${W}" height="${H}" fill="url(#ob)"/>
  <rect width="${W}" height="${H}" fill="url(#or)"/>

  <text x="${cx}" y="${wordY}" font-family="Arial, Helvetica, sans-serif" font-size="${wordSize}" font-weight="bold" fill="${WORD_COLOR}" text-anchor="middle">NeutralWire</text>

  <rect x="${barX}" y="${railY}" width="${barW}" height="${railH}" rx="${railH / 2}" fill="rgba(127,127,127,0.16)"/>
  <g clip-path="url(#barclip)">
    <rect x="${barX}" y="${railY}" width="${segB + 2}" height="${railH}" fill="${SEG_BLUE}"/>
    <rect x="${barX + segB}" y="${railY}" width="${segG}" height="${railH}" fill="${SEG_GREY}"/>
    <rect x="${barX + segB + segG - 2}" y="${railY}" width="${barW - segB - segG + 2}" height="${railH}" fill="${SEG_RED}"/>
  </g>

  <text x="${cx}" y="${tagY}" font-family="Arial, Helvetica, sans-serif" font-size="${tagSize}" font-weight="bold" fill="${TAG_COLOR}" text-anchor="middle" letter-spacing="${tagTrack}">LEFT · CENTER · RIGHT</text>
</svg>`
}

async function generate() {
  const outDir = path.join(__dirname, '..', 'public', 'apple-launch')
  fs.mkdirSync(outDir, { recursive: true })

  const entries = [] // { file, cssW, cssH, dpr, orientation }
  let count = 0

  for (const [w, h, dpr] of IPHONES) {
    const file = `startup-${w * dpr}x${h * dpr}.png`
    const svg = buildSvg(w, h, dpr)
    await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(path.join(outDir, file))
    entries.push({ file, cssW: w, cssH: h, dpr, orientation: 'portrait' })
    count++
  }

  for (const [w, h, dpr] of IPADS) {
    // Portrait
    const pFile = `startup-${w * dpr}x${h * dpr}.png`
    const pSvg = buildSvg(w, h, dpr)
    await sharp(Buffer.from(pSvg)).png({ compressionLevel: 9 }).toFile(path.join(outDir, pFile))
    entries.push({ file: pFile, cssW: w, cssH: h, dpr, orientation: 'portrait' })
    count++
    // Landscape (swapped)
    const lFile = `startup-${h * dpr}x${w * dpr}.png`
    const lSvg = buildSvg(h, w, dpr)
    await sharp(Buffer.from(lSvg)).png({ compressionLevel: 9 }).toFile(path.join(outDir, lFile))
    entries.push({ file: lFile, cssW: h, cssH: w, dpr, orientation: 'landscape' })
    count++
  }

  // Emit the ready-to-paste <link> block for layout.tsx <head>.
  const links = entries
    .map(
      (e) =>
        `        <link rel="apple-touch-startup-image" href="/apple-launch/${e.file}" media="(device-width: ${e.cssW}px) and (device-height: ${e.cssH}px) and (-webkit-device-pixel-ratio: ${e.dpr}) and (orientation: ${e.orientation})" />`,
    )
    .join('\n')

  fs.writeFileSync(path.join(outDir, '_links.txt'), links + '\n')
  console.log(`Generated ${count} startup images → public/apple-launch/`)
  console.log('Link tags written to public/apple-launch/_links.txt')
}

generate().catch((err) => {
  console.error(err)
  process.exit(1)
})
