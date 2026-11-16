import type { Metadata } from 'next'
import { readHomeFlags } from '@/lib/home-flags'
import { VideoWatchProvider, VideoPreviewProvider } from '@/lib/video-watch'
import PageClient from '../page-client'

/**
 * /home — the ISR home shell (Nov 17, 2026 CPU fix — the "below 6 minutes
 * per day" push).
 *
 * WHY THIS ROUTE EXISTS: the meter proved ~447 home navigations/day (95%
 * crawler bots) were each paying a FULL force-dynamic SSR on '/' (ten
 * Firebase flag reads on cold instances + the whole React shell render)
 * — the single biggest page-render burner left after session64's bot
 * gates. Middleware now REWRITES every plain, query-less, cookie-less
 * GET of '/' to this route, so:
 *
 *   - Bots (Googlebot/Bingbot never send cookies or search params) get
 *     the ISR-cached HTML at URL '/' — regenerations happen at most once
 *     per revalidate window instead of once per crawl.
 *   - First-time USERS (no nw_nav cookie, no query) get the IDENTICAL
 *     shell from the same cache — faster first paint, zero behaviour
 *     change (the feed data is fetched client-side from /api/news as
 *     always, and window.location.search is still the visitor's real
 *     query, which is empty on these navigations).
 *   - Everyone with ?topic= / ?ref= / ?category=… links or the nw_nav
 *     personal-design cookie still hits the dynamic '/' — OG previews,
 *     referral attribution and the personal header design are untouched.
 *
 * SEO: the rewrite is server-side and transparent — the URL stays '/',
 * Googlebot indexes '/' — and this page's metadata carries canonical '/'
 * so a stray direct hit on /home can never create a duplicate-URL entry.
 * NO noindex here on purpose: the rewritten '/' response IS this page's
 * HTML, and it must stay fully indexable.
 *
 * The ten SSR flags come from the SHARED src/lib/home-flags.ts (same
 * module, same 5s memos as the dynamic page) — flag flips from /debug
 * appear on the ISR shell within one revalidate window (≤15 min) and on
 * the dynamic page within 5s. Warm-instance regens pay ZERO Firebase
 * reads for the flags (all memoised).
 */
export const revalidate = 900 // 15 minutes — see above; bounded regen cost

const SITE_URL = 'https://neutralwire.org'

export const metadata: Metadata = {
  title: 'NeutralWire — See How Every Outlet Spins the Same Story',
  description:
    'Is your news feeding you the full picture? NeutralWire compares how left, right, and center outlets cover the SAME story — side by side. See the bias, spot the spin, decide for yourself. Free, no paywalls, auto-detects your country.',
  alternates: {
    canonical: SITE_URL + '/',
  },
  openGraph: {
    title: 'NeutralWire — See How Every Outlet Spins the Same Story',
    description: 'Is your news feeding you the full picture? Compare how left, right, and center outlets cover the SAME story — side by side. See the bias, spot the spin, decide for yourself.',
    type: 'website',
    url: SITE_URL + '/',
    images: [{ url: '/api/og-image', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'NeutralWire — See How Every Outlet Spins the Same Story',
    description: 'Is your news feeding you the full picture? Compare how left, right, and center outlets cover the SAME story — side by side.',
    images: ['/api/og-image'],
  },
}

export default async function HomeShell() {
  // All ten SSR flags in one call (shared module — see home-flags.ts).
  // No cookies(), no searchParams, no dynamic APIs: this stays ISR.
  const flags = await readHomeFlags()

  return (
    <VideoWatchProvider enabled={flags.videoWatch}>
      <VideoPreviewProvider enabled={flags.videoPreview}>
        <PageClient
          initialSubtopicNav={flags.initialSubtopicNav}
          popupSystem={flags.popupSystem}
          milestoneDonate={flags.milestoneDonate}
          meshRelay={flags.meshRelay}
          userCron={flags.userCron}
          notifRaiseFix={flags.notifRaiseFix}
          smartPersonalization={flags.smartPersonalization}
          monetizationModel={flags.monetizationModel}
        />
      </VideoPreviewProvider>
    </VideoWatchProvider>
  )
}
