/**
 * session43-mainfeed-check.ts — sanity-check the main categories after the
 * parseFeed junk gate: topic volume stays healthy (no over-filtering) and
 * zero junk/social titles survive into the cached feeds.
 */
import { aggregateCategory } from '../src/lib/news-aggregator'
import { isJunkTitle } from '../src/lib/junk-filter'

async function main() {
  for (const cat of ['world', 'sports'] as const) {
    const t0 = Date.now()
    const { topics, articleCount } = await aggregateCategory(cat, { limit: 24 })
    console.log(`\n═══ ${cat} ═══ (${Date.now() - t0}ms)`)
    console.log(`topics: ${topics.length} | articles: ${articleCount}`)
    const junk = topics.filter((t) => isJunkTitle(t.title))
    console.log(`junk titles: ${junk.length}`)
    for (const t of junk) console.log(`  JUNK: ${t.title.slice(0, 100)}`)
    const imgs = topics.filter((t) => t.imageUrl).length
    console.log(`images: ${imgs}/${topics.length}`)
    console.log('top 8:')
    for (const t of topics.slice(0, 8)) {
      console.log(`  [${t.coverage}src ${t.imageUrl ? 'IMG' : '---'}] ${t.title.slice(0, 95)}`)
    }
  }
}

main().catch((e) => {
  console.error('mainfeed check failed:', e)
  process.exit(1)
})
