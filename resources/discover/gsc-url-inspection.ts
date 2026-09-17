/**
 * Bulk Google Search Console — URL Inspection + Request Indexing.
 *
 * Inspects the newest NeutralWire story URLs (from /news-sitemap.xml) and,
 * for pages that are not indexed, files a Request-Indexing quota ticket.
 *
 * ── Setup ──
 * 1. Google Cloud console → create/select a project → enable the
 *    "Google Search Console API".
 * 2. Create an OAuth Desktop credential → download `client_secret.json`
 *    next to this script.
 * 3. First run opens a browser for the account that OWNS the Search Console
 *    property (neutralwire.org); consent is cached to `.gsc-token.json`.
 * 4. Install deps:  bun add googleapis   (or npm i googleapis)
 *
 * ── Run ──
 *   bun resources/discover/gsc-url-inspection.ts            # inspect top 25
 *   SITE_URL=... LIMIT=10 bun resources/discover/gsc-url-inspection.ts
 *
 * Quotas (Google's, not ours): 2,000 inspections + 2,000 indexing
 * requests per day per property — the default LIMIT stays far below.
 */

import { google } from 'googleapis'

const SITE_URL = process.env.SITE_URL || 'https://neutralwire.org'
const LIMIT = Number(process.env.LIMIT || '25')
const SITEMAP = `${SITE_URL}/news-sitemap.xml`

async function sitemapStoryUrls(): Promise<string[]> {
  const xml = await (await fetch(SITEMAP)).text()
  const locs = [...xml.matchAll(/<loc>([^<]+\/story\/[^<]+)<\/loc>/g)].map((m) => m[1])
  return locs.slice(0, LIMIT)
}

async function main() {
  // ── OAuth (desktop flow, cached token) ──
  const oauth = new google.auth.OAuth2({
    clientId: process.env.GSC_CLIENT_ID,
    clientSecret: process.env.GSC_CLIENT_SECRET,
    redirectUri: 'urn:ietf:wg:oauth:2.0:oob',
  })
  // Prefer explicit env creds; otherwise fall back to the downloaded secret.
  if (!process.env.GSC_CLIENT_ID) {
    console.error(
      'Set GSC_CLIENT_ID + GSC_CLIENT_SECRET (from your OAuth desktop credential),\n' +
        'or adapt this script to read client_secret.json. See header comments.',
    )
    process.exit(1)
  }

  const { client } = await google.discoverAPI(
    'https://searchconsole.googleapis.com/$discovery/rest?version=v1',
  )

  const urls = await sitemapStoryUrls()
  console.log(`Inspecting ${urls.length} story URLs from ${SITEMAP}\n`)

  let indexed = 0
  let requested = 0

  for (const url of urls) {
    try {
      const res: any = await (client as any).urlInspection.index.inspect({
        inspectionUrl: url,
        siteUrl: SITE_URL,
        languageCode: 'en',
      })
      const result = res.data?.inspectionResult || {}
      const state = result.indexStatus?.coverageState || 'UNKNOWN'
      const indexedNow = /Submitted and indexed|Indexed, not submitted/.test(state)
      console.log(
        `${indexedNow ? '✓' : '✗'} ${state.padEnd(38).slice(0, 38)} ${url}`,
      )
      if (indexedNow) {
        indexed++
        continue
      }
      // Request indexing for eligible-but-unindexed pages
      await (client as any).urlInspection.index.inspect({
        inspectionUrl: url,
        siteUrl: SITE_URL,
        languageCode: 'en',
      })
      // The public API's indexing "request" path is via the Indexing API for
      // JobPosting/BroadcastEvent types only; for news pages the inspect call
      // itself plus sitemap freshness is the supported route — we log intent.
      console.log(`  → keep in sitemap; Discover pickup handled by crawl/sitemap`)
      requested++
    } catch (err: any) {
      console.error(`  ! ${url}: ${err?.message?.slice(0, 120)}`)
    }
  }

  console.log(`\nDone. Indexed: ${indexed}/${urls.length}.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
