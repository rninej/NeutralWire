/**
 * The NeutralWire Google Discover programme — the 10-step plan rendered
 * by the /debug Discover Kit (src/components/debug/discover-kit.tsx).
 *
 * Statuses reflect the REAL state of this codebase (not a generic guide):
 *
 *   'live' — shipped by the Discover-kit push: infrastructure exists and
 *            serves in production; the remaining tasks are verification.
 *   'done' — was already true before the push (e.g. Search Console).
 *   'todo' — requires the OWNER's manual action in Google's own consoles
 *            (Publisher Center, URL inspection…) — the Kit provides the
 *            exact steps, checklists and scripts.
 *
 * Task progress is persisted client-side (localStorage key below) so the
 * checklist survives reloads per device.
 */

export type DiscoverStepStatus = 'live' | 'done' | 'todo'

export interface DiscoverTask {
  id: string
  label: string
  /** 'auto' — satisfied by shipped code, ticked and locked in the UI. */
  auto?: boolean
}

export interface DiscoverStep {
  id: string
  n: number
  title: string
  status: DiscoverStepStatus
  /** One-paragraph justification — why this matters FOR DISCOVER specifically. */
  why: string
  /** Concrete how-to instructions. */
  how: string[]
  tasks: DiscoverTask[]
  /** Optional drop-in code / config shown in the Kit. */
  code?: { label: string; lang: string; body: string }
  /** External tools / consoles for this step. */
  tools?: { label: string; href: string }[]
}

export interface DiscoverPhase {
  id: string
  title: string
  subtitle: string
  steps: DiscoverStep[]
}

/** localStorage key for per-device task progress. */
export const DISCOVER_PROGRESS_KEY = 'neutralwire:discover-progress'

export const DISCOVER_PLAN: DiscoverPhase[] = [
  {
    id: 'gates',
    title: 'Phase 1 — Technical gates',
    subtitle: 'The hard requirements. Without these, Discover will not even consider a card.',
    steps: [
      {
        id: 'image-preview',
        n: 1,
        title: 'Unblock large image previews (max-image-preview:large)',
        status: 'live',
        why: 'Google Discover only shows cards with LARGE images. A robots meta without max-image-preview:large caps Google\'s image use at "standard" (~tiny thumbnail) — the single most common silent killer for Discover eligibility. NeutralWire now declares the gate on every page.',
        how: [
          'Shipped: the root layout metadata now emits the canonical robots meta with max-image-preview:large + max-snippet:-1 (and the googlebot-specific form).',
          'Verify after deploy: view-source on any page → search "max-image-preview" — must appear in BOTH the robots and googlebot meta tags.',
          'Later, in Search Console → URL Inspection → "View crawled page" → confirm the tag in the rendered HTML.',
        ],
        tasks: [
          { id: 'image-preview-shipped', label: 'Robots meta gate on every page (shipped in this push)', auto: true },
          { id: 'image-preview-verify', label: 'View-source check on production after deploy' },
          { id: 'image-preview-gsc', label: 'URL Inspection rendered-HTML check on the homepage' },
        ],
        code: {
          label: 'src/app/layout.tsx (metadata.robots) — as shipped',
          lang: 'ts',
          body: [
            'export const metadata: Metadata = {',
            '  // …',
            '  robots: {',
            '    index: true,',
            '    follow: true,',
            '    googleBot: {',
            '      index: true,',
            '      follow: true,',
            "      'max-image-preview': 'large',",
            '      \'max-snippet\': -1,',
            '      \'max-video-preview\': -1,',
            '    },',
            '  },',
            '}',
          ].join('\n'),
        },
      },
      {
        id: 'story-pages',
        n: 2,
        title: 'Crawlable story pages with NewsArticle structured data',
        status: 'live',
        why: 'Discover cards link to INDIVIDUAL article pages, not app shells. NeutralWire stories lived only in a client-side feed — invisible to Googlebot. Every story now has a permanent, server-rendered /story/<id> page (archived on first view, so links never rot) with full NewsArticle JSON-LD, a large hero image and the left/centre/right perspective panel.',
        how: [
          'Shipped: /story/[id] — ISR-cached (15 min), Firebase reads go through the ETag layer (zero bytes when unchanged), topics are auto-archived so shared/crawled URLs work forever.',
          'Shipped: NewsArticle JSON-LD (headline, datePublished/Modified, image array, NewsMediaOrganization publisher, isBasedOn provenance to every outlet).',
          'The live app\'s ?topic=<id> deep links keep working — story pages link back to the interactive version.',
          'Verify after deploy: open a story from the feed → note its /story/<id> URL → paste into Search Console URL Inspection → "Test Live URL" → check "Page indexing" and the structured data detected.',
        ],
        tasks: [
          { id: 'story-shipped', label: '/story/[id] SSR pages + JSON-LD (shipped in this push)', auto: true },
          { id: 'story-verify', label: 'URL-Inspect one live story page after deploy' },
          { id: 'story-share', label: 'Share a /story/<id> link to WhatsApp/X — preview card must render' },
        ],
        tools: [
          { label: 'Search Console URL Inspection', href: 'https://search.google.com/search-console' },
          { label: 'Rich Results Test', href: 'https://search.google.com/test/rich-results' },
        ],
      },
      {
        id: 'feeds',
        n: 3,
        title: 'Sitemap, News sitemap & RSS — bandwidth-safe',
        status: 'live',
        why: 'Google discovers fresh story URLs via sitemaps and feeds. The sitemap link in robots.txt had been disabled during the 6.2 GB Firebase incident; it is now re-enabled — safe because /sitemap.xml is static, and the NEW /news-sitemap.xml (last-48h stories) and /feed.xml (RSS 2.0) are ETag-cached at Firebase AND s-maxage-cached at the CDN.',
        how: [
          'Shipped: robots.txt points to both sitemaps; /news-sitemap.xml lists fresh stories with image:image entries; /feed.xml is a full RSS 2.0 feed with stable GUIDs.',
          'Bandwidth math: each feed regeneration = one ETag-cached room read (304 → 0 bytes when unchanged) and the CDN serves repeats for 15 min.',
          'Verify after deploy: open /robots.txt, /sitemap.xml, /news-sitemap.xml, /feed.xml — all must return 200 XML.',
          'In Search Console → Sitemaps → submit https://neutralwire.org/sitemap.xml and https://neutralwire.org/news-sitemap.xml.',
        ],
        tasks: [
          { id: 'feeds-shipped', label: 'robots.txt + news sitemap + RSS routes (shipped in this push)', auto: true },
          { id: 'feeds-verify', label: 'All four feed URLs return 200 on production' },
          { id: 'feeds-submit', label: 'Submit BOTH sitemaps in Search Console → Sitemaps' },
        ],
        code: {
          label: 'public/robots.txt (footer) — as shipped',
          lang: 'txt',
          body: [
            '# Sitemaps — static sitemap + ETag/CDN-cached news sitemap',
            '# (safe to list since the 6.2GB Firebase fix: zero dynamic reads',
            '#  on /sitemap.xml, one ETag-cached read per feed regeneration).',
            'Sitemap: https://neutralwire.org/sitemap.xml',
            'Sitemap: https://neutralwire.org/news-sitemap.xml',
          ].join('\n'),
        },
      },
      {
        id: 'speed',
        n: 4,
        title: 'Mobile experience & Core Web Vitals',
        status: 'done',
        why: 'Discover traffic is ~100% mobile; Google demotes slow, janky, intrusive pages. NeutralWire\'s mobile feed is already excellent (user-tested PWA, theme-aware, offline-tolerant) and the ETag fix removed the no-store header that defeated the CDN — bothCWV and TTFB benefit directly.',
        how: [
          'Baseline the field data: PageSpeed Insights on the homepage and one /story page (field data needs real traffic — expect "no data" until Discover/Audit traffic arrives).',
          'Keep an eye on LCP: story pages preload nothing but the hero image, which is CDN-cached for 7 days via /api/img.',
          'Avoid CLS traps: never inject banners above the hero after first paint (the popup system already reserves its space).',
        ],
        tasks: [
          { id: 'speed-lab', label: 'PageSpeed Insights lab run: homepage + one /story page (≥90 mobile target)' },
          { id: 'speed-cwv', label: 'Re-check field data in GSC → Core Web Vitals once real traffic flows' },
        ],
        tools: [
          { label: 'PageSpeed Insights', href: 'https://pagespeed.web.dev/' },
        ],
      },
    ],
  },
  {
    id: 'surfaces',
    title: 'Phase 2 — Google surfaces',
    subtitle: 'Get the site registered everywhere Google looks for news.',
    steps: [
      {
        id: 'gsc',
        n: 5,
        title: 'Search Console: verified, sitemaps submitted, stories inspected',
        status: 'done',
        why: 'GSC is the control room: index status, sitemap health, structured-data errors and — later — the ONLY place Discover performance is visible. Verification token is already in the root layout (szdK3f…QJA).',
        how: [
          'Sitemaps → submit /sitemap.xml and /news-sitemap.xml (step 3 task).',
          'URL Inspection → inspect 3–5 fresh /story URLs → "Request Indexing" (queue is slow but it seeds discovery).',
          'Run the bulk script resources/discover/gsc-url-inspection.ts from a machine with an API key to inspect+request the top N story URLs (quota: 2,000 inspections/day).',
          'Fix anything the "Page indexing" report flags within a week of it appearing.',
        ],
        tasks: [
          { id: 'gsc-sitemaps', label: 'Both sitemaps submitted & "Success" status' },
          { id: 'gsc-inspect', label: '3–5 story pages inspected → eligible for indexing' },
          { id: 'gsc-bulk', label: 'Bulk URL-inspection script run once (optional)' },
        ],
        tools: [
          { label: 'Search Console', href: 'https://search.google.com/search-console' },
          { label: 'URL Inspection API docs', href: 'https://developers.google.com/webmaster-tools/v1/url-inspection' },
        ],
      },
      {
        id: 'publisher-center',
        n: 6,
        title: 'Google Publisher Center — publication + RSS review',
        status: 'todo',
        why: 'Publisher Center is how Google learns your publication identity (name, logo, language, country) for Google News & Discover surfaces. With the new full-content RSS feed, the review has everything it needs.',
        how: [
          'Go to Publisher Center → Add publication → name "NeutralWire", label neutralwire.org.',
          'Add the RSS feed https://neutralwire.org/feed.xml (it already carries full titles, summaries, dates and stable GUIDs).',
          'Set language English + primary country; add the publication logo (512×512, transparent).',
          'Submit for review — Google checks the feed, site quality and basic E-E-A-T signals. Typical turnaround: days-to-weeks. Approval is NOT required for Discover, but it materially helps News surface eligibility.',
          'Follow the full checklist in resources/discover/publisher-center-checklist.md (also in the Kit\'s Resources tab).',
        ],
        tasks: [
          { id: 'pc-create', label: 'Publication created in Publisher Center' },
          { id: 'pc-feed', label: '/feed.xml added and validated in the publication' },
          { id: 'pc-logo', label: 'Publication logo uploaded (512×512)' },
          { id: 'pc-submit', label: 'Submitted for review' },
        ],
        tools: [
          { label: 'Google Publisher Center', href: 'https://publishercenter.google.com/' },
        ],
      },
      {
        id: 'monitor',
        n: 7,
        title: 'Discover monitoring loop',
        status: 'todo',
        why: 'You cannot manage what you cannot see. GSC\'s Discover report (Search results → "Discover" filter / Performance) shows impressions, clicks and CTR per story — it appears once Google starts surfacing cards.',
        how: [
          'GSC → Performance → Search results → tick the "Discover" tab (appears with data only after first impressions).',
          'Weekly ritual (2 min): top stories by CTR → study their titles/images → feed those patterns back into the title cleaner and image picker.',
          'The Kit\'s Resources tab includes a monitoring recipe (Search Analytics API, Discover filter) for scripted tracking.',
        ],
        tasks: [
          { id: 'monitor-weekly', label: 'Weekly Discover report review scheduled' },
        ],
        tools: [
          { label: 'GSC Performance', href: 'https://search.google.com/search-console/performance/search-analytics' },
        ],
      },
    ],
  },
  {
    id: 'content',
    title: 'Phase 3 — Content quality (E-E-A-T)',
    subtitle: 'What actually earns the card: the image, the headline, the trust.',
    steps: [
      {
        id: 'images',
        n: 8,
        title: 'Discover-grade images on every story',
        status: 'live',
        why: 'The card IS the image. Google wants ≥1200px-wide, editorial, real photos — no composites-for-the-sake-of-it, no black bars, no stretched logos. NeutralWire scrapes og:images (usually 1200px+), vision-verifies them against the headline (the "Tesco fix", cache v6), and notifications already skip images entirely when none exists — the same no-black-placeholder policy now applies to story pages.',
        how: [
          'Shipped: story pages render the verified photo as a full-width hero via the /api/img proxy (7-day CDN cache) and fall back to the branded og-image composite only in social previews.',
          'Shipped: /news-sitemap.xml carries image:image entries for every story with a photo — the explicit "please use this picture" signal.',
          'Ongoing: when the image picker rejects a photo (mismatch/broken), the refresh pipeline re-picks; stories that end up photo-less simply get no image entry (never a placeholder).',
          'Spot-check weekly: open 5 fresh /story pages — each hero should be a real, relevant, large photo.',
        ],
        tasks: [
          { id: 'images-shipped', label: 'Hero + sitemap image pipeline (shipped in this push)', auto: true },
          { id: 'images-audit', label: 'Weekly 5-story image spot-check' },
        ],
      },
      {
        id: 'headlines',
        n: 9,
        title: 'Headlines without clickbait',
        status: 'done',
        why: 'Discover penalises clickbait and rewards titles that match page content. NeutralWire titles are aggregated from real outlet headlines, already cleaned (WATCH:/trailing "- WATCH" stripped — cache v7) and the story page shows exactly what the title promises, so title↔content parity is structural.',
        how: [
          'Keep the title cleaner in sync with new quirks as they appear in the feed (one place: news-aggregator.ts).',
          'Editorial rule of thumb for AI-fixed titles: say what happened, to whom, where — no teasers ("You won\'t believe…"), no ALL-CAPS words, no trailing "…".',
          'When a story\'s outlets frame it very differently, pick the neutral factual core — that IS the NeutralWire brand and it happens to be Google\'s preferred style.',
        ],
        tasks: [
          { id: 'headlines-rules', label: 'Title-cleaner rules reviewed against Discover title guidelines' },
        ],
        tools: [
          { label: 'Google Discover content policies', href: 'https://developers.google.com/search/docs/case-studies/discover' },
        ],
      },
      {
        id: 'freshness',
        n: 10,
        title: 'Freshness, cadence & consistency',
        status: 'live',
        why: 'Discover heavily favours fresh content; the news-sitemap only lists stories ≤48h old, and the cron refresh keeps feeds ≤30 min stale. The remaining lever is CONSISTENCY: a steady trickle of new stories every day trains Google\'s recrawl rhythm.',
        how: [
          'Shipped: /news-sitemap.xml auto-filters to the last 48 hours — the freshness contract with Google.',
          'The distributed user-cron + cron-job.org backstop already run refresh + notify on schedule; no new cron work needed (optional feed warm-up documented in resources/discover/cron-wiring.md).',
          'Watch: GSC → Sitemaps → news-sitemap "Discovered URLs" should trend up week-over-week; if it flatlines, check the cron/refresh health in /debug → Firebase Bandwidth + Mesh Relay Monitor.',
        ],
        tasks: [
          { id: 'freshness-shipped', label: '48h news-sitemap freshness filter (shipped in this push)', auto: true },
          { id: 'freshness-cron', label: 'Confirm refresh cron health in /debug (bandwidth panel steady)' },
        ],
      },
    ],
  },
]

/** Flat helpers used by the Kit UI. */
export const DISCOVER_STEPS: DiscoverStep[] = DISCOVER_PLAN.flatMap((p) => p.steps)

export const DISCOVER_TASKS: DiscoverTask[] = DISCOVER_STEPS.flatMap((s) => s.tasks)

export const DISCOVER_AUTO_DONE = DISCOVER_TASKS.filter((t) => t.auto).length

export const DISCOVER_TOTAL_TASKS = DISCOVER_TASKS.length
