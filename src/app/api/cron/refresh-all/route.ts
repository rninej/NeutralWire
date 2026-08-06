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
// Reduced from 60 to 30 — the background work is lighter now so 30s is
// plenty. Lower maxDuration = less CPU time billed per invocation.
export const maxDuration = 30

/**
 * Cron-triggered endpoint that refreshes the MOST IMPORTANT news
 * categories every 60 minutes — WITHOUT requiring a visitor to hit the site.
 *
 * ── CPU BUDGET (Vercel Hobby: 4hr/month Fluid Compute CPU) ──
 * This endpoint was previously refreshing ALL 8 RSS categories + 3 GDELT
 * countries + 23 AI summaries per hour = ~40s CPU/invocation. Over a
 * month that's ~20 hours of CPU — WAY over the 4hr limit.
 *
 * NOW it only refreshes the categories users actually see on landing:
 *   - relevant (the default tab — needs to be fresh)
 *   - world + politics (always shown in the Relevant feed sections)
 *   - mycountry-GB (UK is the most common visitor country)
 *
 * Other categories (business, tech, science, health, sports, US, IN)
 * refresh ON-DEMAND when a user visits them — the /api/news route handles
 * that automatically with its stale-while-revalidate cache.
 *
 * Summary pre-generation: only the top 5 relevant topics (was 15+8=23).
 * This is enough to keep the landing page fast without burning CPU.
 *
 * Security: hardcoded secret (URL acts as the secret).
 *
 * Trigger: cron-job.org every 60 minutes
 *   URL: https://neutralwire.org/api/cron/refresh-all?secret=965977e5d9adca4f90aa6f23b6f95371964ed8793bc735cd
 */

const CRON_SECRET = '965977e5d9adca4f90aa6f23b6f95371964ed8793bc735cd'

export async function GET(req: NextRequest) {
  const t0 = Date.now()

  const secret = req.nextUrl.searchParams.get('secret') || ''
  if (secret !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Only refresh the categories users see on landing. Other categories
  // refresh on-demand via /api/news when a user visits them.
  const rssCategories: Category[] = ['world', 'politics']
  const myCountryCodes = ['GB']

  const origin = process.env.NEXT_PUBLIC_SITE_URL || req.nextUrl.origin

  after(async () => {
    console.log(`[cron/refresh-all] Starting light refresh at ${new Date().toISOString()}`)

    // ── MINIMAL REFRESH: only refresh the landing page (relevant/GB) ──
    //
    // CPU BUDGET: Vercel Hobby gives 4hr/month Fluid Compute CPU.
    // Previously this cron refreshed 2 RSS categories + 1 GDELT country
    // + relevant + 5 AI summary pre-generations = ~15s CPU/hour.
    // Over a month = ~6 hours (over the limit).
    //
    // NOW: only refresh relevant/GB (the default landing page). This is
    // ~5s CPU/hour = ~2.5 hours/month (within budget).
    //
    // Other categories (world, politics, business, tech, science, health,
    // sports, mycountry) refresh ON-DEMAND when a user visits them — the
    // /api/news route handles that automatically with its SWR cache
    // (30-min TTL). No cron needed for those.
    //
    // Summary pre-generation is REMOVED entirely — summaries generate
    // on-demand when a user opens a topic (cached forever in Firebase).

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
    } catch (err) {
      console.warn(`[cron/refresh-all] relevant/GB failed:`, err)
    }

    console.log(`[cron/refresh-all] Complete in ${Date.now() - t0}ms`)
  })

  return NextResponse.json({
    ok: true,
    message: 'Light refresh dispatched',
    categories: rssCategories.length + myCountryCodes.length + 1,
    ts: Date.now(),
  })
}

/**
 * Pre-generate summaries for a SMALL list of topics.
 * Skips topics that already have a cached summary.
 * Runs in batches of 3 (was 4) to stay gentle on CPU.
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

    const batchSize = 3
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
            // silent
          }
        }),
      )
    }

    console.log(`[cron/refresh-all] Summary pre-generation complete`)
  } catch (err) {
    console.warn(`[cron/refresh-all] Summary pre-generation failed:`, err)
  }
}
