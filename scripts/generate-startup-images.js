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
 * a beat before the first paint. These static PNGs are a FRAME of the
 * splash (corner glows, NeutralWire wordmark, converging tri-color bias
 * bar, LEFT · CENTER · RIGHT tagline), so iOS users get:
 *   OS launch (this static frame) → CSS splash (same design, animates)
 *   → app — one continuous branded moment, zero white flash.
 *
 * THEME-AWARE (v26): TWO sets are generated — dark (the classic #0a0a0a
 * design) and light (white bg, dark wordmark, softer orbs). The <link>
 * tags in layout.tsx qualify each set's media attribute with
 * (prefers-color-scheme: dark|light), so the OS launch image follows the
 * DEVICE colour scheme and hands off into the in-app splash, which is
 * themed exactly to the user's chosen family+mode (see layout.tsx). The
 * OS cannot read the in-app theme (localStorage) before the page loads,
 * so system-scheme neutrals are the closest possible match; the themed
 * in-app splash takes over from the webview's first frame.
 *
 * HOW iOS picks one: it matches <link rel="apple-touch-startup-image"
 * media="(device-width: Wpx) and (device-height: Hpx) and
 * (-webkit-device-pixel-ratio: D) and (orientation: …) and
 * (prefers-color-scheme: …)"> against the device. We generate one PNG per
 * modern iPhone portrait size + iPad portrait AND landscape sizes (iPhone
 * launch is locked to portrait by the manifest's orientation:
 * portrait-primary; iPads can rotate). Rendered at physical pixels (CSS
 * size × dpr) so viewportFit=cover full-screen sizes are exact.
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

// ── Launch-image palettes (each mirrors one side of the in-app splash) ──
// DARK = the classic design (neutral dark tokens: bg #0a0a0a = oklch(.145 0 0),
// wordmark #fafafa = oklch(.985 0 0), tag #a1a1a1 = oklch(.708 0 0)).
// LIGHT = neutral light tokens (bg #fff, wordmark #0a0a0a = oklch(.145 0 0),
// tag #737373 = oklch(.556 0 0)) with softer orb alphas — matches the
// html.nw-splash-light palette in layout.tsx.
const PALETTES = [
  {
    scheme: 'dark',
    dir: '', // public/apple-launch/ (unchanged paths — dark stays put)
    bg: '#0a0a0a',
    word: '#fafafa',
    tag: '#a1a1a1',
    track: 'rgba(127,127,127,0.16)',
    orbB: 'rgba(59,130,246,0.38)',
    orbB0: 'rgba(59,130,246,0)',
    orbR: 'rgba(239,68,68,0.34)',
    orbR0: 'rgba(239,68,68,0)',
  },
  {
    scheme: 'light',
    dir: 'light/', // public/apple-launch/light/
    bg: '#ffffff',
    word: '#0a0a0a',
    tag: '#737373',
    track: 'rgba(127,127,127,0.24)',
    orbB: 'rgba(59,130,246,0.26)',
    orbB0: 'rgba(59,130,246,0)',
    orbR: 'rgba(239,68,68,0.22)',
    orbR0: 'rgba(239,68,68,0)',
  },
]
const SEG_BLUE = '#3b82f6'
const SEG_GREY = '#a1a1a1' // the bias bar's centre segment (both modes)
const SEG_RED = '#ef4444'

/**
 * Build the splash-frame SVG at PHYSICAL pixel size for a palette.
 * All CSS-pixel values from the animated splash are multiplied by dpr so the
 * static frame lines up 1:1 with what the CSS splash then animates.
 */
function buildSvg(cssW, cssH, dpr, P) {
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
      <stop offset="0" stop-color="${P.orbB}"/>
      <stop offset="1" stop-color="${P.orbB0}"/>
    </radialGradient>
    <radialGradient id="or" gradientUnits="userSpaceOnUse" cx="${rx}" cy="${ry}" r="${orbR}">
      <stop offset="0" stop-color="${P.orbR}"/>
      <stop offset="1" stop-color="${P.orbR0}"/>
    </radialGradient>
    <clipPath id="barclip">
      <rect x="${barX}" y="${railY}" width="${barW}" height="${railH}" rx="${railH / 2}"/>
    </clipPath>
  </defs>

  <rect width="${W}" height="${H}" fill="${P.bg}"/>
  <rect width="${W}" height="${H}" fill="url(#ob)"/>
  <rect width="${W}" height="${H}" fill="url(#or)"/>

  <text x="${cx}" y="${wordY}" font-family="Arial, Helvetica, sans-serif" font-size="${wordSize}" font-weight="bold" fill="${P.word}" text-anchor="middle">NeutralWire</text>

  <rect x="${barX}" y="${railY}" width="${barW}" height="${railH}" rx="${railH / 2}" fill="${P.track}"/>
  <g clip-path="url(#barclip)">
    <rect x="${barX}" y="${railY}" width="${segB + 2}" height="${railH}" fill="${SEG_BLUE}"/>
    <rect x="${barX + segB}" y="${railY}" width="${segG}" height="${railH}" fill="${SEG_GREY}"/>
    <rect x="${barX + segB + segG - 2}" y="${railY}" width="${barW - segB - segG + 2}" height="${railH}" fill="${SEG_RED}"/>
  </g>

  <text x="${cx}" y="${tagY}" font-family="Arial, Helvetica, sans-serif" font-size="${tagSize}" font-weight="bold" fill="${P.tag}" text-anchor="middle" letter-spacing="${tagTrack}">LEFT · CENTER · RIGHT</text>
</svg>`
}

async function generate() {
  const outRoot = path.join(__dirname, '..', 'public', 'apple-launch')
  fs.mkdirSync(outRoot, { recursive: true })

  const entries = [] // { palette, file, cssW, cssH, dpr, orientation }
  let count = 0

  for (const P of PALETTES) {
    const outDir = path.join(outRoot, P.dir)
    fs.mkdirSync(outDir, { recursive: true })

    const devices = []
    for (const [w, h, dpr] of IPHONES) devices.push([w, h, dpr, 'portrait'])
    for (const [w, h, dpr] of IPADS) {
      devices.push([w, h, dpr, 'portrait'])
      devices.push([h, w, dpr, 'landscape']) // swapped
    }

    for (const [w, h, dpr, orientation] of devices) {
      const file = `startup-${w * dpr}x${h * dpr}.png`
      const svg = buildSvg(w, h, dpr, P)
      await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(path.join(outDir, file))
      entries.push({ palette: P, file, cssW: w, cssH: h, dpr, orientation })
      count++
    }
  }

  // Emit the ready-to-paste <link> block for layout.tsx <head> — each
  // device gets TWO links (dark + light), both qualified with
  // prefers-color-scheme so exactly one matches per device scheme.
  const links = entries
    .map(
      (e) =>
        `        <link rel="apple-touch-startup-image" href="/apple-launch/${e.palette.dir}${e.file}" media="(device-width: ${e.cssW}px) and (device-height: ${e.cssH}px) and (-webkit-device-pixel-ratio: ${e.dpr}) and (orientation: ${e.orientation}) and (prefers-color-scheme: ${e.palette.scheme})" />`,
    )
    .join('\n')

  fs.writeFileSync(path.join(outRoot, '_links.txt'), links + '\n')
  console.log(`Generated ${count} startup images (dark + light sets) → public/apple-launch/`)
  console.log('Link tags written to public/apple-launch/_links.txt')
}

generate().catch((err) => {
  console.error(err)
  process.exit(1)
})
