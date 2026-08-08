import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
// Images are immutable — cache at the CDN for 7 days so repeat image
// loads (same URL) don't hit the function at all. The SW also caches
// images client-side, but the CDN cache helps the FIRST load from a
// new device and shared images across users.
export const maxDuration = 10

// In-process cache for image blobs (keyed by URL hash).
// Images don't change, so cache for 1 hour.
const IMG_CACHE = new Map<string, { ts: number; blob: Buffer; contentType: string }>()
const IMG_TTL_MS = 60 * 60 * 1000

// CDN cache header for image responses. 7 days at the edge means
// repeat requests for the same image URL (across ALL users) are served
// from the Vercel CDN without running this function — huge CPU savings
// since image proxying was one of the most-invoked endpoints.
const IMG_CDN_CACHE = 'public, s-maxage=604800, stale-while-revalidate=86400'

/**
 * Image proxy: fetches an image URL server-side and returns it.
 * This bypasses referrer/CORS restrictions that prevent the browser
 * from loading images directly from news sites.
 *
 * Usage: /api/img?url=<image-url>
 *
 * CDN caching: images are immutable (same URL = same image forever),
 * so we cache at the CDN for 7 days. This is the single biggest CPU
 * saver — without it, every page load was proxying 10-30 images
 * through this function (each ~50ms CPU = 500-1500ms CPU per page).
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

  // Check in-process cache (warm instance)
  const cached = IMG_CACHE.get(url)
  if (cached && Date.now() - cached.ts < IMG_TTL_MS) {
    return new NextResponse(cached.blob, {
      headers: {
        'Content-Type': cached.contentType,
        'Cache-Control': IMG_CDN_CACHE,
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

    return new NextResponse(blob, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': IMG_CDN_CACHE,
      },
    })
  } catch {
    return new NextResponse('Image fetch failed', { status: 502 })
  }
}
