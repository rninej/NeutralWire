import { NextRequest, NextResponse } from 'next/server'

/**
 * Middleware to block spam/bot requests that waste serverless function
 * invocations and Firebase reads.
 *
 * Blocks: /wp-admin, /wp-login, /xmlrpc.php, /.env, /.git, /admin, etc.
 * These are common bot scanning paths that generate 404s but still
 * consume Vercel serverless function invocations.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // Block common bot scanning paths
  const blockedPaths = [
    '/wp-admin',
    '/wp-login',
    '/wp-content',
    '/wp-includes',
    '/xmlrpc.php',
    '/.env',
    '/.git',
    '/admin',
    '/phpmyadmin',
    '/phpinfo',
    '/.well-known/security.txt',
    '/vendor/',
    '/config.php',
    '/database.sql',
    '/a5058499b47dac60', // specific spam path from Vercel stats
  ]

  for (const blocked of blockedPaths) {
    if (pathname.toLowerCase().startsWith(blocked) || pathname.toLowerCase() === blocked) {
      return new NextResponse('Not Found', { status: 404 })
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     * - public assets (png, jpg, svg, etc.)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|css|js|json|xml|txt)$).*)',
  ],
}
