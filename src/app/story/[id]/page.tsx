import type { Metadata } from 'next'
import { cache } from 'react'
import { notFound } from 'next/navigation'
import { findTopicAnywhere } from '@/lib/topic-lookup'
import type { TopicArticle } from '@/lib/news-aggregator'
import { firebaseRead } from '@/lib/firebase-server'
import { plainSummaryText, isTemplateSummary } from '@/lib/summary-sections'
import { generateStorySummaryBounded } from '@/lib/summary-generate'
import { BiasBar } from '@/components/bias-bar'
import { StorySummaryLive } from '@/components/story-summary-live'
import {
  SITE_URL,
  SITE_NAME,
  SITE_LOGO_URL,
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
    const topic = await findTopicAnywhere(id)
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
  // Prefer the real neutral summary (markup stripped) for snippets.
  const description =
    plainSummaryText(storedSummary || topic.summary || '').slice(0, 200) ||
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
  { label: string; dot: string; text: string }
> = {
  left: { label: 'Left-leaning outlets', dot: 'bg-blue-500', text: 'text-blue-600 dark:text-blue-400' },
  center: { label: 'Centre outlets', dot: 'bg-zinc-500', text: 'text-zinc-600 dark:text-zinc-400' },
  right: { label: 'Right-leaning outlets', dot: 'bg-red-500', text: 'text-red-600 dark:text-red-400' },
}

// ---------- page ----------

export default async function StoryPage({ params }: StoryProps) {
  const { id } = await params
  const story = await getStoryData(id)
  if (!story || !story.topic.title) notFound()
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

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Minimal top bar — a quiet way back into the live app */}
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-2.5">
          <a href="/" className="flex items-center gap-2" aria-label="NeutralWire home">
            <span className="flex h-5 w-5 items-center justify-center rounded-sm bg-gradient-to-b from-blue-500 via-zinc-400 to-red-500" />
            <span className="text-sm font-bold tracking-tight">{SITE_NAME}</span>
          </a>
          <a
            href={`/?topic=${encodeURIComponent(id)}`}
            className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Compare live in the app →
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-16">
        {/* Hero — the notification image: the story photo composited
            with the NEUTRALWIRE banner + the L/C/R bias bar (1200×630,
            rendered by /api/og-image and CDN-cached 7 days). */}
        <img
          src={composite}
          alt={topic.title}
          className="mt-4 aspect-[1200/630] w-full rounded-xl border border-border bg-muted object-cover"
          loading="eager"
          fetchPriority="high"
        />

        {/* Headline block */}
        <h1 className={`text-2xl font-bold leading-tight tracking-tight mt-6 md:text-3xl`}>
          {topic.title}
        </h1>

        {/* THE Neutral Summary — the exact card the app renders. The
            summary is generated DURING the render when missing (see
            getStoryData), so the raw HTML normally ships the complete
            LLM summary — what Googlebot indexes. The client-side
            upgrade below remains only as the rare fallback for when the
            render-time generation failed (e.g. a provider outage). */}
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

        {/* Visible dates + coverage + lean distribution (E-E-A-T: dates
            must be human-visible, not just in JSON-LD) */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {firstSeen && (
            <time dateTime={iso(firstSeen)}>
              Published {utcDate(firstSeen)}, {utcTime(firstSeen)} UTC
            </time>
          )}
          {latestSeen && latestSeen !== firstSeen && (
            <time dateTime={iso(latestSeen)}>· updated {utcDate(latestSeen)}</time>
          )}
          <span>· {topic.articles?.length || 0} outlets</span>
        </div>

        <div className="mt-5">
          <BiasBar
            left={topic.leanLeft}
            center={topic.leanCenter}
            right={topic.leanRight}
            showLabels
          />
        </div>

        {/* Coverage panel — the NeutralWire core value: same story,
            three framings, real links to every outlet. */}
        <section className="mt-10 space-y-8">
          {(['left', 'center', 'right'] as const).map((lean) => {
            const arts = byLean[lean]
            if (!arts.length) return null
            const meta = LEAN_META[lean]
            return (
              <div key={lean}>
                <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
                  <span className={`h-2 w-2 rounded-full ${meta.dot}`} aria-hidden />
                  <span className={meta.text}>{meta.label}</span>
                  <span className="font-normal text-muted-foreground">({arts.length})</span>
                </h2>
                <ul className="space-y-3">
                  {arts.map((a) => (
                    <li key={a.id || a.link} className="rounded-lg border border-border p-3">
                      <a
                        href={a.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-sm font-medium leading-snug hover:underline"
                      >
                        {a.title}
                      </a>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        <span className="font-medium">{a.sourceName}</span>
                        {a.iso ? <span>· {utcDate(a.iso)}</span> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </section>

        {/* CTA into the interactive app (deep link opens this exact story) */}
        <section className="mt-12 rounded-xl border border-border bg-muted/40 p-6 text-center">
          <p className="text-sm font-medium">
            See how these outlets frame every story — side by side, updated live.
          </p>
          <a
            href={`/?topic=${encodeURIComponent(id)}`}
            className="mt-4 inline-flex items-center justify-center rounded-full bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground transition-transform hover:scale-[1.02]"
          >
            Open in {SITE_NAME}
          </a>
          <p className="mt-3 text-xs text-muted-foreground">
            Free · no paywalls · left, centre &amp; right on every story
          </p>
        </section>

        {/* NewsArticle structured data */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: newsArticleJsonLd(id, topic, storedSummary),
          }}
        />
      </main>

      <footer className="border-t border-border py-6 text-center text-xs text-muted-foreground">
        <a href="/" className="hover:underline">{SITE_NAME}</a>
        {' · '}
        <a href="/privacy" className="hover:underline">Privacy policy</a>
        {' · '}
        <span>
          Aggregated from {(topic.articles?.length || 0)}{' '}
          {(topic.articles?.length || 0) === 1 ? 'outlet' : 'outlets'} across the political spectrum
        </span>
      </footer>
    </div>
  )
}
