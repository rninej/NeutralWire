import type { Metadata } from 'next'
import { cache } from 'react'
import { notFound, permanentRedirect } from 'next/navigation'
import { findTopicAnywhere, topicRoomPointer } from '@/lib/topic-lookup'
import type { TopicArticle, FeedArticle } from '@/lib/news-aggregator'
import { isUsefulSummary } from '@/lib/story-quality'
import { firebaseRead } from '@/lib/firebase-server'
import { plainSummaryText, isTemplateSummary } from '@/lib/summary-sections'
import { generateStorySummaryBounded } from '@/lib/summary-generate'
import { BiasBar } from '@/components/bias-bar'
import { StorySummaryLive } from '@/components/story-summary-live'
import {
  SITE_URL,
  SITE_NAME,
  SITE_LOGO_URL,
  SITE_TAGLINE,
  ogImageForTopic,
  heroImageForUrl,
} from '@/lib/site'

/**
 * ── Crawlable story pages (the Google Discover requirement) ──
 *
 * Google Discover cards link to INDIVIDUAL article pages. NeutralWire's
 * stories previously existed only inside the client-side feed — invisible
 * to Googlebot. This route gives every story a permanent, fully
 * server-rendered page:
 *
 *   /story/<topicId>  →  NOTIFICATION IMAGE hero (the story photo
 *                        composited with the NEUTRALWIRE banner + the
 *                        L/C/R bias bar — the same image push
 *                        notifications attach), headline, NEUTRAL
 *                        SUMMARY (the same card the app shows — stored
 *                        LLM summary from summaries/<topicId>, generated
 *                        DURING the render when none exists yet so the
 *                        raw HTML always ships complete), dates,
 *                        left/centre/right coverage panel (real outlet
 *                        links), NewsArticle JSON-LD, canonical + OG.
 *
 * ── REDESIGN (Oct 2026, "the story page is disgusting") ──
 * Full visual overhaul: real NW monogram in the header (owner request),
 * branded coverage hero, bias-percentage chips, lean-coloured article
 * cards with outlet avatars, brand-gradient CTA. All metadata, JSON-LD,
 * ISR and data paths are UNCHANGED — purely presentational.
 *
 * ── Bandwidth safety (the 6.2 GB rule) ──
 * The topic lookup goes through findTopicAnywhere → archive/<id> first
 * (a few-KB read, ETag-cached → 0 bytes on warm instances when unchanged)
 * and FOUND topics are auto-ARCHIVED, so a story URL served once keeps
 * resolving forever even after the live cache rotates. ISR (revalidate
 * below) means the Vercel edge serves the HTML for 15 minutes per story
 * before re-rendering — Googlebot crawls mostly hit the CDN cache.
 *
 * ── SEO notes ──
 * - `robots` is deliberately NOT set here so the page INHERITS the root
 *   layout's Discover gate (max-image-preview:large, max-snippet:-1).
 *   Setting a page-level `robots` object would shallow-replace it.
 * - `datePublished` = firstSeen (first time outlets reported it),
 *   `dateModified` = latestSeen (newest article added to the cluster).
 * - `isBasedOn` links every outlet article — provenance / E-E-A-T signal.
 */

export const revalidate = 900 // 15 min ISR — matches the feed cache cadence
// A cold story render may wait up to ~8s for the neutral summary's LLM
// generation (see getStoryData) — 30s keeps Vercel from killing a slow
// first render of an un-summarized story (ISR regens run inside it too).
export const maxDuration = 30

// Topic lookup + the stored NEUTRAL SUMMARY in one request-scoped memo
// (React `cache`), so generateMetadata and the page render share a single
// Firebase round-trip. The summaries/<id> node is tiny (~0.5-1KB) and
// ETag-cached → 0 bytes on warm instances — the 6.2GB rule holds.
const getStoryData = cache(
  async (
    id: string,
  ): Promise<{
    topic: TopicArticle & { archivedAt?: number }
    storedSummary: string | null
  } | null> => {
    // fullScan:false — the archive + topicIndex cover every live topic, so
    // the legacy every-room scan only costs seconds + Firebase bytes for
    // ids that are already dead (the 616 GSC URLs Googlebot re-crawls as
    // 308s). See topic-lookup.ts for the safety argument.
    const topic = await findTopicAnywhere(id, { fullScan: false })
    if (!topic) return null

    // The REAL neutral summary ("The Big Picture / Why It Matters / …")
    // is generated once by /api/summary and persisted at
    // summaries/<topicId> — separate from the topic node, whose own
    // `summary` field is usually just a thin wire snippet. Read the
    // stored one; template (extractive) leftovers count as absent.
    let storedSummary: string | null = null
    try {
      const stored = await firebaseRead<{ summary?: string }>(
        `summaries/${id}`,
      )
      if (stored?.summary && !isTemplateSummary(stored.summary)) {
        storedSummary = stored.summary
      }
    } catch {
      // best-effort — the page falls back to topic.summary below
    }

    // ── THE INDEXING FIX (Sep 2026) ──
    // No stored summary → GENERATE IT DURING THIS RENDER (same shared
    // pipeline as /api/summary, bounded ~8s) instead of shipping a thin
    // wire snippet and letting the client swap the real summary in AFTER
    // load. Googlebot saw exactly that "suddenly loads" pattern (initial
    // HTML ≠ final content + layout shift) and refused to index 27 story
    // pages. Now the raw HTML ships the complete neutral summary on the
    // FIRST render; a timeout keeps the generation alive via after() so
    // it persists and the next ISR regen (≤15 min) has it in the HTML.
    // The cron refresh pre-generates summaries for new stories too, so
    // this path is the exception, not the rule.
    if (!storedSummary) {
      try {
        storedSummary = await generateStorySummaryBounded(
          id,
          topic.title,
          (topic.articles || []).slice(0, 12).map((a) => ({
            title: a.title,
            description: a.description || '',
            sourceName: a.sourceName,
            leaning: a.leaning || '',
          })),
          topic.summary || '',
          8000,
        )
      } catch {
        // never break the page render over summary generation
      }
    }

    return { topic, storedSummary }
  },
)

interface StoryProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata({
  params,
}: StoryProps): Promise<Metadata> {
  const { id } = await params
  const story = await getStoryData(id)
  if (!story) return {}
  const { topic, storedSummary } = story

  const canonical = `/story/${encodeURIComponent(id)}`
  // Prefer the real neutral summary (markup stripped) for snippets —
  // QUALITY-GATED (the share-card "U.S." bug): a junk stored summary
  // (bare section word, GDELT "Shown because…" note) falls through to
  // the branded description instead of leaking onto the share card.
  const candidateSummary = plainSummaryText(storedSummary || topic.summary || '')
  const description =
    (isUsefulSummary(candidateSummary) ? candidateSummary : '').slice(0, 200) ||
    `How ${topic.articles.length || 'multiple'} outlets across the political spectrum cover this story.`
  // THE NOTIFICATION IMAGE (user request, Sep 2026): the /api/og-image
  // composite — the story's photo with the NEUTRALWIRE banner + the
  // L/C/R bias bar — exactly what push notifications attach. It is now
  // the PRIMARY og:image (and JSON-LD image + page hero + sitemap image)
  // so Google indexes the branded bias-bar image, not a bare photo.
  const composite = new URL(ogImageForTopic(id), SITE_URL).toString()

  // Composite FIRST (the branded image Google/Discover should pick);
  // the raw photo stays as the guaranteed second candidate.
  const images: Array<{ url: string; width: number; height: number }> = [
    { url: composite, width: 1200, height: 630 },
  ]
  const hero = heroImageForUrl(topic.imageUrl)
  if (hero) images.push({ url: hero, width: 1200, height: 675 })

  return {
    title: `${topic.title} — ${SITE_NAME}`,
    description,
    alternates: { canonical },
    openGraph: {
      title: topic.title,
      description,
      type: 'article',
      url: canonical,
      publishedTime: new Date(topic.firstSeen || topic.latestSeen).toISOString(),
      modifiedTime: new Date(topic.latestSeen || topic.firstSeen).toISOString(),
      siteName: SITE_NAME,
      images,
    },
    twitter: {
      card: 'summary_large_image',
      title: topic.title,
      description,
      images: images.map((i) => i.url),
    },
  }
}

// ---------- helpers ----------

function utcDate(ts?: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function utcTime(ts?: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  })
}

function iso(ts?: number): string {
  return new Date(ts || Date.now()).toISOString()
}

function newsArticleJsonLd(
  id: string,
  topic: TopicArticle & { archivedAt?: number },
  storedSummary: string | null,
): string {
  const canonical = `${SITE_URL}/story/${encodeURIComponent(id)}`
  // Composite (photo + NW banner + bias bar) FIRST — the branded image
  // Google should index for this story (matches og:image + the hero).
  const image = [ogImageForTopic(id), heroImageForUrl(topic.imageUrl)]
    .filter((u): u is string => Boolean(u))
    .map((u) => new URL(u, SITE_URL).toString())

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: topic.title?.slice(0, 110) || 'Untitled story',
    description:
      plainSummaryText(storedSummary || topic.summary || '') || undefined,
    image,
    datePublished: iso(topic.firstSeen || topic.latestSeen),
    dateModified: iso(topic.latestSeen || topic.firstSeen),
    author: [{ '@type': 'Organization', name: SITE_NAME, url: SITE_URL }],
    publisher: {
      '@type': 'NewsMediaOrganization',
      name: SITE_NAME,
      url: SITE_URL,
      logo: { '@type': 'ImageObject', url: SITE_LOGO_URL },
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
    // Provenance: every outlet article this comparison is based on.
    isBasedOn: (topic.articles || []).slice(0, 12).map((a) => a.link),
    isAccessibleForFree: true,
  }
  // Escape "<" so the payload can never close its own <script> tag.
  return JSON.stringify(ld).replace(/</g, '\\u003c')
}

const LEAN_META: Record<
  'left' | 'center' | 'right',
  {
    label: string
    short: string
    dot: string
    text: string
    accent: string
    avatar: string
    chip: string
  }
> = {
  left: {
    label: 'Left-leaning outlets',
    short: 'LEFT',
    dot: 'bg-blue-500',
    text: 'text-blue-600 dark:text-blue-400',
    accent: 'border-l-blue-500 dark:border-l-blue-400',
    avatar: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 ring-blue-500/30',
    chip: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 ring-blue-500/30',
  },
  center: {
    label: 'Centre outlets',
    short: 'CENTRE',
    dot: 'bg-zinc-500',
    text: 'text-zinc-600 dark:text-zinc-400',
    accent: 'border-l-zinc-400 dark:border-l-zinc-500',
    avatar: 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 ring-zinc-500/30',
    chip: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300 ring-zinc-500/30',
  },
  right: {
    label: 'Right-leaning outlets',
    short: 'RIGHT',
    dot: 'bg-red-500',
    text: 'text-red-600 dark:text-red-400',
    accent: 'border-l-red-500 dark:border-l-red-400',
    avatar: 'bg-red-500/10 text-red-600 dark:text-red-400 ring-red-500/30',
    chip: 'bg-red-500/10 text-red-700 dark:text-red-300 ring-red-500/30',
  },
}

/** The first letter of an outlet's name, for the avatar bubble. */
function outletInitial(name: string): string {
  const clean = (name || '').replace(/^(the)\s+/i, '').trim()
  return (clean[0] || '?').toUpperCase()
}

function articleHref(a: FeedArticle): string {
  // Google News RSS links are redirects; they still work as hrefs —
  // keep the outlet's own link verbatim.
  return a.link || '#'
}

// ---------- page ----------

export default async function StoryPage({ params }: StoryProps) {
  const { id } = await params
  const story = await getStoryData(id)
  if (!story || !story.topic.title) {
    // ── THE GSC-404 ENDGAME (Oct 2026) ──
    // 616+ Search-Console "Not found" URLs (and ~22k more) are stories
    // that existed, were crawled/indexed from the ISR edge cache, then
    // rotated out of the live rooms BEFORE anything archived them — the
    // content is unrecoverable (checked archive/searchIndex/summaries/
    // title-rewrites; Wayback unreachable for this site). A real 404
    // kept them dead-ending forever. Instead: a topicIndex pointer proves
    // the story ONCE existed → 308 to the live feed. Google consolidates
    // the signals and de-indexes them as "moved" (the Not-found report
    // empties); humans land on today's stories. Ids that never existed
    // anywhere keep the honest branded 404 below.
    const room = await topicRoomPointer(id)
    if (room) permanentRedirect('/')
    notFound()
  }
  const { topic, storedSummary } = story

  // The VISIBLE hero image is the notification composite (photo + NW
  // banner + bias bar) — what the user asked Google to index the story
  // with. It always renders, even without a photo (dark branded card).
  const composite = ogImageForTopic(id)
  const firstSeen = topic.firstSeen || topic.latestSeen
  const latestSeen = topic.latestSeen || topic.firstSeen
  const byLean: Record<'left' | 'center' | 'right', typeof topic.articles> = {
    left: [],
    center: [],
    right: [],
  }
  for (const a of topic.articles || []) {
    if (a?.leaning && a.leaning in byLean) byLean[a.leaning].push(a)
  }
  const leanTotal =
    (topic.leanLeft || 0) + (topic.leanCenter || 0) + (topic.leanRight || 0)
  const pct = (n: number) =>
    leanTotal > 0 ? Math.round((n / leanTotal) * 100) : 0

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* ── Branded header — the real NW logo (owner request) + a quiet
          way back into the live app ── */}
      <header className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <a href="/" className="flex items-center gap-2.5" aria-label="NeutralWire home">
            {/* The NW monogram — vector-traced from icon-512.png, the same
                mark the app header, PWA icons and JSON-LD publisher logo
                use. (Was the scaffold's z.ai "Z" glyph — owner report.) */}
            <img
              src="/logo.svg"
              alt=""
              width={30}
              height={30}
              className="h-[30px] w-[30px] rounded-md ring-1 ring-black/10 dark:ring-white/20"
            />
            <span className="flex flex-col leading-none">
              <span className="text-base font-extrabold tracking-tight">{SITE_NAME}</span>
              <span className="mt-0.5 hidden text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground sm:block">
                Left · Centre · Right
              </span>
            </span>
          </a>
          <a
            href={`/?topic=${encodeURIComponent(id)}`}
            className="shrink-0 rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition-transform hover:scale-[1.03] active:scale-95"
          >
            Compare live →
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-20 pt-6">
        {/* ── Coverage eyebrow ── */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
            <span className="h-1.5 w-1.5 rounded-full bg-zinc-400" />
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
            {topic.articles?.length || 0} outlets · one story
          </span>
          {firstSeen ? (
            <time
              dateTime={iso(firstSeen)}
              className="text-xs font-medium text-muted-foreground"
            >
              {utcDate(firstSeen)}
            </time>
          ) : null}
        </div>

        {/* ── Hero — the notification image: the story photo composited
            with the NEUTRALWIRE banner + the L/C/R bias bar (1200×630,
            rendered by /api/og-image and CDN-cached 7 days). ── */}
        <div className="mt-4 overflow-hidden rounded-2xl border border-border shadow-lg shadow-black/5 dark:shadow-black/25">
          <img
            src={composite}
            alt={topic.title}
            className="aspect-[1200/630] w-full bg-muted object-cover"
            loading="eager"
            fetchPriority="high"
          />
        </div>

        {/* ── Headline block ── */}
        <h1 className="mt-6 text-[1.75rem] font-extrabold leading-[1.15] tracking-tight md:text-4xl">
          {topic.title}
        </h1>

        {/* ── Story meta: dates + outlet count ── */}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {firstSeen ? (
            <time dateTime={iso(firstSeen)}>
              Published {utcDate(firstSeen)}, {utcTime(firstSeen)} UTC
            </time>
          ) : null}
          {latestSeen && latestSeen !== firstSeen ? (
            <time dateTime={iso(latestSeen)}>· updated {utcDate(latestSeen)}</time>
          ) : null}
          <span>· {topic.articles?.length || 0} sources</span>
        </div>

        {/* ── THE Neutral Summary — the exact card the app renders. The
            summary is generated DURING the render when missing (see
            getStoryData), so the raw HTML normally ships the complete
            LLM summary — what Googlebot indexes. ── */}
        <div className="mt-6">
          <StorySummaryLive
            topicId={id}
            title={topic.title}
            articles={(topic.articles || []).slice(0, 12).map((a) => ({
              title: a.title,
              description: a.description || '',
              sourceName: a.sourceName,
              leaning: a.leaning || '',
            }))}
            initialSummary={storedSummary || topic.summary || ''}
            hasStoredSummary={Boolean(storedSummary)}
          />
        </div>

        {/* ── Bias breakdown: the bar + percentage chips (the at-a-glance
            answer to "how split is the coverage?") ── */}
        <section className="mt-8 rounded-2xl border border-border bg-muted/30 p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
              How the spectrum splits
            </h2>
            <div className="flex items-center gap-1.5">
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${LEAN_META.left.chip}`}>
                L {pct(topic.leanLeft || 0)}%
              </span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${LEAN_META.center.chip}`}>
                C {pct(topic.leanCenter || 0)}%
              </span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${LEAN_META.right.chip}`}>
                R {pct(topic.leanRight || 0)}%
              </span>
            </div>
          </div>
          <BiasBar
            left={topic.leanLeft}
            center={topic.leanCenter}
            right={topic.leanRight}
            showLabels
          />
        </section>

        {/* ── Coverage panel — the NeutralWire core value: same story,
            three framings, real links to every outlet. ── */}
        <section className="mt-10">
          <div className="mb-5 flex items-baseline justify-between">
            <h2 className="text-lg font-extrabold tracking-tight">
              How each side frames it
            </h2>
            <span className="text-xs text-muted-foreground">
              {topic.articles?.length || 0} reports
            </span>
          </div>

          <div className="space-y-8">
            {(['left', 'center', 'right'] as const).map((lean) => {
              const arts = byLean[lean]
              if (!arts.length) return null
              const meta = LEAN_META[lean]
              return (
                <div key={lean}>
                  <h3 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em]">
                    <span className={`h-2 w-2 rounded-full ${meta.dot}`} aria-hidden />
                    <span className={meta.text}>{meta.label}</span>
                    <span className="font-medium text-muted-foreground">
                      {arts.length}
                    </span>
                  </h3>
                  <ul className="space-y-2.5">
                    {arts.map((a) => (
                      <li
                        key={a.id || a.link}
                        className={`rounded-xl border border-border border-l-[3px] ${meta.accent} bg-card/60 p-4 transition-shadow hover:shadow-md hover:shadow-black/5 dark:hover:shadow-black/20`}
                      >
                        <div className="flex items-center gap-2.5">
                          <span
                            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ring-1 ${meta.avatar}`}
                            aria-hidden
                          >
                            {outletInitial(a.sourceName)}
                          </span>
                          <span className="truncate text-xs font-semibold">
                            {a.sourceName || 'Outlet'}
                          </span>
                          {a.iso ? (
                            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                              {utcDate(a.iso)}
                            </span>
                          ) : null}
                        </div>
                        <a
                          href={articleHref(a)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-2.5 block text-sm font-semibold leading-snug hover:underline"
                        >
                          {a.title}
                        </a>
                        {a.description ? (
                          <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                            {a.description}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        </section>

        {/* ── CTA into the interactive app — the brand gradient (blue →
            zinc → red, the same spectrum the whole page speaks) ── */}
        <section className="mt-12 overflow-hidden rounded-2xl border border-border">
          <div className="bg-gradient-to-r from-blue-600/90 via-zinc-500/90 to-red-600/90 px-6 py-8 text-center text-white">
            <p className="text-base font-bold leading-snug">
              See how these outlets frame every story — side by side, updated live.
            </p>
            <p className="mt-1 text-xs font-medium text-white/80">
              {SITE_TAGLINE}
            </p>
            <a
              href={`/?topic=${encodeURIComponent(id)}`}
              className="mt-5 inline-flex items-center justify-center rounded-full bg-white px-7 py-2.5 text-sm font-bold text-zinc-900 shadow-md transition-transform hover:scale-[1.03] active:scale-95"
            >
              Open in {SITE_NAME}
            </a>
            <p className="mt-3 text-[11px] font-medium text-white/75">
              Free · no paywalls · left, centre &amp; right on every story
            </p>
          </div>
        </section>

        {/* NewsArticle structured data */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: newsArticleJsonLd(id, topic, storedSummary),
          }}
        />
      </main>

      <footer className="border-t border-border bg-muted/30 py-8">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 px-4 text-center">
          {/* The NW monogram (see header). */}
          <img
            src="/logo.svg"
            alt="NeutralWire logo"
            width={34}
            height={34}
            className="h-[34px] w-[34px] rounded-md ring-1 ring-black/10 dark:ring-white/20"
          />
          <p className="text-sm font-bold tracking-tight">{SITE_NAME}</p>
          <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
            Aggregated from {topic.articles?.length || 0}{' '}
            {(topic.articles?.length || 0) === 1 ? 'outlet' : 'outlets'} across
            the political spectrum. Headlines stay the property of their
            publishers — links go straight to the source.
          </p>
          <nav className="flex items-center gap-4 text-xs text-muted-foreground">
            <a href="/" className="font-medium hover:underline">Today&apos;s top stories</a>
            <a href="/privacy" className="hover:underline">Privacy policy</a>
          </nav>
        </div>
      </footer>
    </div>
  )
}
