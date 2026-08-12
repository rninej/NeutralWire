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
}

generateIcons().catch(console.error)
