import { NextRequest, NextResponse } from 'next/server'

/**
 * Middleware to block spam/bot/AI-crawler requests that waste Vercel
 * Fluid Compute CPU.
 *
 * Two layers:
 *   1. Block common bot scanning paths (/wp-admin, /.env, etc.)
 *   2. Block AI crawlers (GPTBot, ClaudeBot, CCBot, etc.) that hammer
 *      the site and burn CPU on uncached SSR + middleware runs.
 *      These bots account for ~8% of CPU usage (middleware tax) per
 *      Vercel analytics.
 *
 * Blocking AI crawlers is safe — they don't contribute to real user
 * traffic and each request costs ~1-2ms of middleware CPU + the full
 * function CPU if the page isn't cached.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  const ua = req.headers.get('user-agent') || ''

  // ── 1. Block common bot scanning paths ──
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
    '/a5058499b47dac60',
  ]

  for (const blocked of blockedPaths) {
    if (pathname.toLowerCase().startsWith(blocked) || pathname.toLowerCase() === blocked) {
      return new NextResponse('Not Found', { status: 404 })
    }
  }

  // ── 2. Block AI crawlers / scrapers ──
  // These bots generate thousands of requests/month, each running the
  // middleware + SSR function. Blocking them saves significant CPU.
  // Note: Googlebot, Bingbot, and other search engine bots are ALLOWED
  // (they help with SEO). Only AI training/scraping bots are blocked.
  const aiCrawlerPatterns = [
    'gptbot',        // OpenAI
    'chatgpt-user',  // OpenAI ChatGPT
    'ccbot',         // Common Crawl (used by many AI companies)
    'claudebot',     // Anthropic
    'claude-web',    // Anthropic
    'anthropic',
    'perplexitybot', // Perplexity
    'bytespider',    // ByteDance (TikTok)
    'diffbot',
    'imagesiftbot',
    'omgili',
    'omgilibot',
    'facebookbot',   // Meta AI
    'meta-externalagent',
    'amazonbot',
    'applebot-extended',
    'cohere-ai',
    'ai2bot',
    'timpibot',
    'img2dataset',
    'webzio',
    'webzio-extended',
    'researchscan',
    'crawler',
  ]

  const uaLower = ua.toLowerCase()
  for (const pattern of aiCrawlerPatterns) {
    if (uaLower.includes(pattern)) {
      // Return 403 with minimal headers — no body, no caching, ~0 CPU
      return new NextResponse('Forbidden', {
        status: 403,
        headers: { 'X-Robots-Tag': 'noindex' },
      })
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
