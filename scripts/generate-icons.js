import sharp from 'sharp'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function generateIcons() {
  // NeutralWire PWA icon — NW monogram drawn as SVG PATHS (not text).
  //
  // WHY PATHS, NOT TEXT:
  //   <text> elements depend on the system font (Arial) which may not be
  //   available on all systems (Linux servers, some Android devices). When
  //   the font is missing, the text renders as a fallback or doesn't render
  //   at all. SVG <path> elements render identically everywhere because
  //   they're vector shapes, not font glyphs.
  //
  // MASKABLE ICON RULES:
  //   1. Background fills the ENTIRE 512x512 canvas (no rounded corners —
  //      the OS applies the mask). No transparency.
  //   2. Content must be within the center 80% SAFE ZONE (a circle of
  //      radius ~205px centered at 256,256). Our NW monogram spans
  //      x: 120-415, y: 140-372 — well within the safe zone.
  //
  // DESIGN:
  //   - Full-bleed #0a0a0a (near-black) background
  //   - "N" drawn as a single path: left vertical → diagonal → right vertical
  //   - "W" drawn as a single path: shares N's right vertical, then 4 strokes
  //   - Blue accent dot at the W's middle peak (news "source point" feel)
  //   - Strokes are 32px wide with round caps/joins for a modern look

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0a0a0a"/>
  <path d="M 120 372 L 120 140 L 220 372 L 220 140" fill="none" stroke="#ffffff" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M 220 140 L 285 372 L 350 200 L 415 372 L 415 140" fill="none" stroke="#ffffff" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="350" cy="180" r="14" fill="#3b82f6"/>
</svg>`

  const publicDir = path.join(__dirname, '..', 'public')
  const svgPath = path.join(publicDir, 'icon-source.svg')
  fs.writeFileSync(svgPath, svg)

  // Generate all PNG sizes from the SAME SVG (sharp renders the paths
  // consistently at any size — no font dependency).
  await sharp(svgPath).resize(192, 192).png().toFile(path.join(publicDir, 'icon-192.png'))
  await sharp(svgPath).resize(512, 512).png().toFile(path.join(publicDir, 'icon-512.png'))
  await sharp(svgPath).resize(180, 180).png().toFile(path.join(publicDir, 'apple-touch-icon.png'))
  await sharp(svgPath).resize(32, 32).png().toFile(path.join(publicDir, 'favicon-32.png'))

  console.log('Icons generated: NW monogram as SVG paths (no font dependency, maskable-safe)')
}

generateIcons().catch(console.error)
