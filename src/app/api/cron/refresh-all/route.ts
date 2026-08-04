import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import type { Category } from '@/lib/news-sources'
import { aggregateCategory, shortenLongTitles, type TopicArticle } from '@/lib/news-aggregator'
import { aggregateMyCountryViaGdelt } from '@/lib/gdelt-aggregator'
import {
  refreshCategory,
} from '@/lib/news-cache'
import { sourcesForCountry } from '@/lib/country-detect'
import { firebaseRead } from '@/lib/firebase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 60

/**
 * Cron-triggered endpoint that refreshes ALL NeutralWire news categories
 * every 60 minutes — WITHOUT requiring a visitor to hit the site.
 *
 * This prevents topics from going stale when there's no traffic (e.g.
 * overnight, or when the first user of the day would otherwise have to
 * wait for RSS feeds to load).
 *
 * Categories refreshed:
 *   - RSS: top, world, politics, business, technology, science, health, sports
 *   - GDELT (My Country): GB (UK), US, IN (India) — the most common
 *     visitor countries. Other countries refresh on-demand when a visitor
 *     from that country arrives.
 *   - relevant: uses the RSS aggregator with a country-aware source mix
 *
 * Summary pre-generation:
 *   For the `relevant` category (the default tab), the top 15 topics get
 *   their neutral AI summaries pre-generated and cached in Firebase. This
 *   means when a user opens the app from cache (offline PWA) and taps a
 *   topic, the summary is already there — no waiting for the AI.
 *
 * Security: requires a CRON_SECRET query param to prevent public abuse.
 *
 * Trigger:
 *   - Vercel Cron (vercel.json) every 60 minutes in production
 *   - System crontab in the dev sandbox for testing
 */
export async function GET(req: NextRequest) {
  const t0 = Date.now()

  // ── Auth: require CRON_SECRET ──
  const secret = req.nextUrl.searchParams.get('secret') || ''
  const expectedSecret = process.env.CRON_SECRET || 'neutralwire-cron-dev'
  if (secret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── Categories to refresh ──
  const rssCategories: Category[] = [
    'top', 'world', 'politics', 'business', 'technology', 'science', 'health', 'sports',
  ]
  const myCountryCodes = ['GB', 'US', 'IN']

  // Use `after()` so we return 200 immediately and let the refreshes run
  // in the background.
  after(async () => {
    console.log(`[cron/refresh-all] Starting full refresh at ${new Date().toISOString()}`)

    // ── 1. Refresh all RSS categories in parallel ──
    const rssResults = await Promise.allSettled(
      rssCategories.map(async (cat) => {
        try {
          const fresh = await refreshCategory(cat, '', async () => {
            return aggregateCategory(cat, { limit: 40, minCoverage: 1 })
          })
          console.log(`[cron/refresh-all] RSS ${cat}: ${fresh?.topics?.length || 0} topics`)
          return { cat, topics: fresh?.topics || [] }
        } catch (err) {
          console.warn(`[cron/refresh-all] RSS ${cat} failed:`, err)
          return { cat, topics: [] }
        }
      }),
    )

    // ── 2. Refresh My Country for common countries (sequential — GDELT
    //    rate-limits to 1 req/5s) ──
    for (const cc of myCountryCodes) {
      try {
        const fresh = await refreshCategory('mycountry', cc, async () => {
          const gdeltResult = await aggregateMyCountryViaGdelt(cc, 40)
          await shortenLongTitles(gdeltResult.topics)
          return gdeltResult
        })
        console.log(`[cron/refresh-all] MyCountry ${cc}: ${fresh?.topics?.length || 0} topics`)
      } catch (err) {
        console.warn(`[cron/refresh-all] MyCountry ${cc} failed:`, err)
      }
    }

    // ── 3. Refresh "relevant" for the UK (default country) ──
    try {
      const countrySourceIds = sourcesForCountry('GB')
      const fresh = await refreshCategory('relevant', 'GB', async () => {
        return aggregateCategory('relevant', {
          limit: 60,
          minCoverage: 1,
          countrySourceIds,
          countryCode: 'GB',
        })
      })
      console.log(`[cron/refresh-all] relevant/GB: ${fresh?.topics?.length || 0} topics`)

      // ── 4. Pre-generate summaries for the top relevant topics ──
      // The relevant tab is the default landing page. Pre-generating
      // summaries ensures that when a user opens the app (even from
      // cache/offline) and taps a topic, the neutral summary is already
      // cached in Firebase and loads instantly.
      if (fresh && fresh.topics.length > 0) {
        await preGenerateSummaries(fresh.topics.slice(0, 15), req.nextUrl.origin)
      }
    } catch (err) {
      console.warn(`[cron/refresh-all] relevant/GB failed:`, err)
    }

    // ── 5. Pre-generate summaries for top world topics (high-traffic) ──
    const worldResult = rssResults.find(
      (r) => r.status === 'fulfilled' && r.value.cat === 'world',
    )
    if (worldResult && worldResult.status === 'fulfilled' && worldResult.value.topics.length > 0) {
      await preGenerateSummaries(worldResult.value.topics.slice(0, 8), req.nextUrl.origin)
    }

    console.log(`[cron/refresh-all] Complete in ${Date.now() - t0}ms`)
  })

  return NextResponse.json({
    ok: true,
    message: 'Refresh dispatched in background',
    categories: rssCategories.length + myCountryCodes.length + 1,
    ts: Date.now(),
  })
}

/**
 * Pre-generate neutral AI summaries for a list of topics.
 * Skips topics that already have a cached summary (checks Firebase first).
 * Runs in batches of 4 to avoid hammering the AI providers.
 */
async function preGenerateSummaries(topics: TopicArticle[], origin: string): Promise<void> {
  try {
    const toGenerate: TopicArticle[] = []
    for (const topic of topics) {
      const existing = await firebaseRead<unknown>(`summaries/${topic.topicId}`)
      if (!existing) toGenerate.push(topic)
    }

    if (toGenerate.length === 0) {
      console.log(`[cron/refresh-all] All ${topics.length} topics already have summaries`)
      return
    }

    console.log(`[cron/refresh-all] Pre-generating ${toGenerate.length} summaries...`)

    const batchSize = 4
    for (let i = 0; i < toGenerate.length; i += batchSize) {
      const batch = toGenerate.slice(i, i + batchSize)
      await Promise.allSettled(
        batch.map(async (topic) => {
          try {
            await fetch(`${origin}/api/summary`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                topicId: topic.topicId,
                title: topic.title,
                articles: (topic.articles || []).map((a) => ({
                  title: a.title,
                  description: a.description,
                  sourceName: a.sourceName,
                  leaning: a.leaning,
                })),
              }),
            })
          } catch {
            // silent — best-effort
          }
        }),
      )
    }

    console.log(`[cron/refresh-all] Summary pre-generation complete`)
  } catch (err) {
    console.warn(`[cron/refresh-all] Summary pre-generation failed:`, err)
  }
}
