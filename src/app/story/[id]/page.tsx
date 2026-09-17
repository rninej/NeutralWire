import type { Metadata } from 'next'
import { cache } from 'react'
import { notFound } from 'next/navigation'
import { findTopicAnywhere } from '@/lib/topic-lookup'
import type { TopicArticle } from '@/lib/news-aggregator'
import { BiasBar } from '@/components/bias-bar'
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
 *   /story/<topicId>  →  hero photo, headline, summary, dates,
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

// Dedupe the Firebase lookup between generateMetadata + the page render
// (React `cache` scopes the memo to a single request).
const getTopic = cache(
  async (id: string): Promise<(TopicArticle & { archivedAt?: number }) | null> =>
    findTopicAnywhere(id),
)

interface StoryProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata({
  params,
}: StoryProps): Promise<Metadata> {
  const { id } = await params
  const topic = await getTopic(id)
  if (!topic) return {}

  const canonical = `/story/${encodeURIComponent(id)}`
  const description =
    topic.summary?.slice(0, 200) ||
    `How ${topic.articles.length || 'multiple'} outlets across the political spectrum cover this story.`
  const composite = ogImageForTopic(id)

  // Prefer the real photo for the social card; the branded composite is
  // the guaranteed-rendering fallback (and second image in the array).
  const images: Array<{ url: string; width: number; height: number }> = []
  const hero = heroImageForUrl(topic.imageUrl)
  if (hero) images.push({ url: hero, width: 1200, height: 675 })
  images.push({ url: composite, width: 1200, height: 630 })

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
): string {
  const canonical = `${SITE_URL}/story/${encodeURIComponent(id)}`
  const image = [heroImageForUrl(topic.imageUrl), ogImageForTopic(id)]
    .filter((u): u is string => Boolean(u))
    .map((u) => new URL(u, SITE_URL).toString())

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: topic.title?.slice(0, 110) || 'Untitled story',
    description: topic.summary || undefined,
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
  const topic = await getTopic(id)
  if (!topic || !topic.title) notFound()

  const hero = heroImageForUrl(topic.imageUrl)
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
        {/* Hero — the Discover card image. Real photo only; no placeholder
            when the story has none (same policy as notifications). */}
        {hero && (
          <img
            src={hero}
            alt={topic.title}
            className="mt-4 aspect-video w-full rounded-xl border border-border bg-muted object-cover"
            loading="eager"
            fetchPriority="high"
          />
        )}

        {/* Headline block */}
        <h1 className={`text-2xl font-bold leading-tight tracking-tight ${hero ? 'mt-6' : 'mt-8'} md:text-3xl`}>
          {topic.title}
        </h1>
        {topic.summary && (
          <p className="mt-3 text-base leading-relaxed text-muted-foreground md:text-lg">
            {topic.summary}
          </p>
        )}

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
          dangerouslySetInnerHTML={{ __html: newsArticleJsonLd(id, topic) }}
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
