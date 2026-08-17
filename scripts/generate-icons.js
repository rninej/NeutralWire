import sharp from 'sharp'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function generateIcons() {
  // NeutralWire PWA icon — "NW" text on a black background.
  //
  // Maskable icon rules:
  //   1. Background fills the ENTIRE 512x512 canvas (no rounded corners —
  //      the OS applies the mask).
  //   2. Content (the "NW" text) is within the center 80% SAFE ZONE.
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0a0a0a"/>
  <text x="256" y="320" font-family="Arial, sans-serif" font-size="200" font-weight="bold" fill="white" text-anchor="middle">NW</text>
</svg>`

  const publicDir = path.join(__dirname, '..', 'public')
  const svgPath = path.join(publicDir, 'icon-source.svg')
  fs.writeFileSync(svgPath, svg)

  // Generate all PNG sizes
  await sharp(svgPath).resize(192, 192).png().toFile(path.join(publicDir, 'icon-192.png'))
  await sharp(svgPath).resize(512, 512).png().toFile(path.join(publicDir, 'icon-512.png'))
  await sharp(svgPath).resize(180, 180).png().toFile(path.join(publicDir, 'apple-touch-icon.png'))
  await sharp(svgPath).resize(32, 32).png().toFile(path.join(publicDir, 'favicon-32.png'))

  console.log('Icons generated: NW text on black background (maskable-safe)')

  // ── Generate monochrome notification badge icons ──
  // Android requires the notification badge (status bar icon) to be
  // MONOCHROME (white on transparent). If it has color, Android shows
  // a white square. If it 404s, Android shows a default bell icon.
  //
  // The badge is a simplified NW monogram drawn as SVG paths — just the
  // white strokes, NO background fill (transparent so the status bar
  // shows through). Android applies its own tint based on the theme.
  const badgeSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192">
  <path d="M 45 140 L 45 52 L 82 140 L 82 52" fill="none" stroke="#ffffff" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M 82 52 L 106 140 L 130 75 L 154 140 L 154 52" fill="none" stroke="#ffffff" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

  const badgeSvgPath = path.join(publicDir, 'badge-monochrome.svg')
  fs.writeFileSync(badgeSvgPath, badgeSvg)

  // Generate at multiple densities for different Android screen sizes
  await sharp(badgeSvgPath).resize(24, 24).png().toFile(path.join(publicDir, 'badge-24.png'))
  await sharp(badgeSvgPath).resize(48, 48).png().toFile(path.join(publicDir, 'badge-48.png'))
  await sharp(badgeSvgPath).resize(72, 72).png().toFile(path.join(publicDir, 'badge-72.png'))
  await sharp(badgeSvgPath).resize(96, 96).png().toFile(path.join(publicDir, 'badge-96.png'))
  await sharp(badgeSvgPath).resize(192, 192).png().toFile(path.join(publicDir, 'badge-192.png'))

  console.log('Badge icons generated: 24, 48, 72, 96, 192 (monochrome NW)')
}

generateIcons().catch(console.error)
