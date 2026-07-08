import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

// In-process cache for image blobs (keyed by URL hash).
// Images don't change, so cache for 1 hour.
const IMG_CACHE = new Map<string, { ts: number; blob: Buffer; contentType: string }>()
const IMG_TTL_MS = 60 * 60 * 1000
const IMAGE_RESPONSE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Netlify-CDN-Cache-Control': 'no-store',
  Vary: 'Accept',
}

function bufferBody(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer
}

/**
 * Image proxy: fetches an image URL server-side and returns it.
 * This bypasses referrer/CORS restrictions that prevent the browser
 * from loading images directly from news sites.
 *
 * Usage: /api/img?url=<image-url>
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url')
  if (!url) {
    return new NextResponse('Missing url param', { status: 400 })
  }

  // Validate URL is http/https
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return new NextResponse('Invalid URL', { status: 400 })
  }

  // Check cache
  const cached = IMG_CACHE.get(url)
  if (cached && Date.now() - cached.ts < IMG_TTL_MS) {
    return new NextResponse(bufferBody(cached.blob), {
      headers: {
        'Content-Type': cached.contentType,
        ...IMAGE_RESPONSE_HEADERS,
      },
    })
  }

  try {
    // Parse the URL to extract the origin for the Referer header.
    // Some CDNs (BBC, Guardian) check the Referer and block requests
    // without it.
    const parsedUrl = new URL(url)
    const referer = `${parsedUrl.protocol}//${parsedUrl.host}/`

    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        Referer: referer,
      },
      cache: 'no-store',
    })

    if (!res.ok) {
      return new NextResponse('Failed to fetch image', { status: 502 })
    }

    const contentType = res.headers.get('content-type') || 'image/jpeg'
    const blob = Buffer.from(await res.arrayBuffer())

    // Only cache successful image responses
    if (contentType.startsWith('image/')) {
      IMG_CACHE.set(url, { ts: Date.now(), blob, contentType })
    }

    return new NextResponse(bufferBody(blob), {
      headers: {
        'Content-Type': contentType,
        ...IMAGE_RESPONSE_HEADERS,
      },
    })
  } catch {
    return new NextResponse('Image fetch failed', { status: 502 })
  }
}
