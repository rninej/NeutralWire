/**
 * test-aspect.ts — verify jpegDimensions + fetchYouTubeAspectRatio
 * (oar2.jpg original-aspect measurement) for a landscape and a portrait video.
 */
import { fetchYouTubeAspectRatio, jpegDimensions } from '../src/lib/video-quality'

async function main() {
  // 1. jpegDimensions unit check with a synthetic minimal JPEG header
  //    (SOI + fake DQT + SOF0 720x1280)
  const jpeg = new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xdb, 0x00, 0x05, 0x00, 0x00, 0x00, 0x00, // fake DQT len=5
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x05, 0x00, 0x02, 0xd0, 0x03, 0x20, // SOF0 h=1280 w=800
  ])
  const dims = jpegDimensions(jpeg)
  console.log('synthetic jpeg dims:', dims, dims && dims.width === 720 && dims.height === 1280 ? 'OK' : 'FAIL')

  // 2. Real landscape video (Rick Astley 4K, 16:9)
  const landscape = await fetchYouTubeAspectRatio('dQw4w9WgXcQ')
  console.log('landscape oar2 aspect:', landscape, landscape && landscape > 1.5 ? 'OK (~1.78)' : 'FAIL')

  // 3. Real vertical Short (9:16)
  const portrait = await fetchYouTubeAspectRatio('Hxb1LRIkKU0')
  console.log('portrait oar2 aspect:', portrait, portrait && portrait < 0.7 ? 'OK (~0.56)' : 'FAIL')

  // 4. Bogus id → null (no crash)
  const bogus = await fetchYouTubeAspectRatio('zzzzzzzzzzz')
  console.log('bogus id →', bogus, bogus === null ? 'OK' : 'FAIL')
}

main().catch((e) => {
  console.error('ERROR', e)
  process.exit(1)
})
