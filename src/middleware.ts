import { NextRequest, NextResponse } from 'next/server'
import { trackPageHit, flushPages } from '@/lib/usage-meter-edge'

/**
 * Middleware to block spam/bot/AI-crawler requests that waste Vercel
 * Fluid Compute CPU.
 *
 * Three layers:
 *   1. Block common bot scanning paths (/wp-admin, /.env, etc.)
 *   2. Block AI crawlers (GPTBot, ClaudeBot, CCBot, etc.) that hammer
 *      the site and burn CPU on uncached SSR + middleware runs.
 *      These bots account for ~8% of CPU usage (middleware tax) per
 *      Vercel analytics.
 *   3. usage-meter (Nov 16, 2026 emergency): count every non-API page
 *      navigation by path class + UA class, flushed to the Firebase
 *      usageMeter/<day> node. Page RENDER CPU is billed by Vercel but
 *      invisible to in-route meters — the counts let tomorrow's audit
 *      price SSR/ISR renders (bot share vs user share vs home vs story).
 *
 * Blocking AI crawlers is safe — they don't contribute to real user
 * traffic and each request costs ~1-2ms of middleware CPU + the full
 * function CPU if the page isn't cached.
 */
export async function middleware(req: NextRequest) {
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

  const lower = pathname.toLowerCase()
  for (const blocked of blockedPaths) {
    if (lower.startsWith(blocked) || lower === blocked) {
      return new NextResponse('Not Found', { status: 404 })
    }
  }

  // ── 2. Block AI crawlers / scrapers ──
  // These bots generate thousands of requests/month, each running the
  // middleware + SSR function. Blocking them saves significant CPU.
  // Note: Googlebot, Bingbot, and other search engine bots are ALLOWED
  // (they help with SEO). Only AI training/scraping bots are blocked.
  const aiCrawlerPatterns = [
    'gptbot', // OpenAI
    'chatgpt-user', // OpenAI ChatGPT
    'ccbot', // Common Crawl (used by many AI companies)
    'claudebot', // Anthropic
    'claude-web', // Anthropic
    'anthropic',
    'perplexitybot', // Perplexity
    'bytespider', // ByteDance (TikTok)
    'diffbot',
    'imagesiftbot',
    'omgili',
    'omgilibot',
    'facebookbot', // Meta AI
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

  // ─ 3. usage-meter: page navigation accounting (API routes meter
  // themselves via trackRequest; skip here to avoid double counting). ──
  if (!pathname.startsWith('/api/')) {
    trackPageHit(pathname, ua)
    // Rate-limited inside (one tiny PATCH per ~15s); when the window is
    // closed this is a pure no-op.
    try {
      await flushPages()
    } catch {
      // never let metering break a navigation
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
