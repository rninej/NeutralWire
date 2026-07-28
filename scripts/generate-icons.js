import sharp from 'sharp'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function generateIcons() {
  // Maskable PWA icon for NeutralWire.
  //
  // CRITICAL: For "purpose": "any maskable" icons, Android applies a
  // circular (or squircle) mask. The icon MUST follow these rules:
  //   1. Background fills the ENTIRE 512x512 canvas (no rounded corners —
  //      the OS applies the mask). The old icon had rx="96" which left
  //      transparent corners that got cut off.
  //   2. Content (the "NW" text) must be within the center 80% SAFE ZONE
  //      (a circle of radius ~205px centered at 256,256). The old icon
  //      used font-size 280 which was too big — the corners of the letters
  //      got clipped by the circular mask.
  //
  // This version: full-bleed black background + smaller "NW" text
  // (font-size 200, centered) that fits comfortably within the safe zone.
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0a0a0a"/>
  <text x="256" y="320" font-family="Arial, sans-serif" font-size="200" font-weight="bold" fill="white" text-anchor="middle">NW</text>
</svg>`

  const publicDir = path.join(__dirname, '..', 'public')
  const svgPath = path.join(publicDir, 'icon-source.svg')
  fs.writeFileSync(svgPath, svg)

  // Generate 192x192 and 512x512 PNG icons (maskable — full bleed)
  await sharp(svgPath).resize(192, 192).png().toFile(path.join(publicDir, 'icon-192.png'))
  await sharp(svgPath).resize(512, 512).png().toFile(path.join(publicDir, 'icon-512.png'))

  // Apple touch icon (180x180) — iOS applies its own rounded mask, so the
  // full-bleed background works here too.
  await sharp(svgPath).resize(180, 180).png().toFile(path.join(publicDir, 'apple-touch-icon.png'))

  // Favicon (32x32)
  await sharp(svgPath).resize(32, 32).png().toFile(path.join(publicDir, 'favicon-32.png'))

  console.log('Icons generated successfully (maskable-safe: full-bleed bg, NW in 80% safe zone)')
}

generateIcons().catch(console.error)
