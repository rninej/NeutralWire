import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

// In-process cache for image blobs (keyed by URL hash).
// Images don't change, so cache for 1 hour.
const IMG_CACHE = new Map<string, { ts: number; blob: Buffer; contentType: string }>()
const IMG_TTL_MS = 60 * 60 * 1000

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
    return new NextResponse(cached.blob, {
      headers: {
        'Content-Type': cached.contentType,
        'Cache-Control': 'public, max-age=3600',
      },
    })
  }

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible: NeutralWireBot/1.0)',
        Accept: 'image/*,*/*',
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

    return new NextResponse(blob, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      },
    })
  } catch {
    return new NextResponse('Image fetch failed', { status: 502 })
  }
}
