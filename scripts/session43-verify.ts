/**
 * session43-verify.ts — live verification of the premium-subtopic pipeline
 * upgrades (junk filter + ranking + images) on the USER'S actual topics:
 *   artificial-intelligence, stock-markets, ipos-and-markets (+ chess).
 * Reports: topic count, image ratio, junk survivors (must be ZERO),
 * compound titles, and the top-of-feed ranking order.
 */
import { refreshCustomTopic } from '../src/lib/custom-topics'
import { firebaseRead } from '../src/lib/firebase-server'
import { isJunkTitle } from '../src/lib/junk-filter'

const TOPICS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['artificial-intelligence', 'stock-markets', 'chess']

async function main() {
  for (const id of TOPICS) {
    const t0 = Date.now()
    console.log(`\n════════ ${id} ════════`)
    const payload = await refreshCustomTopic(id, {
      aiFilter: true,
      mode: 'background',
      budgetMs: 30000,
    })
    console.log(`fill: ${payload ? 'OK' : 'FAILED'} in ${Date.now() - t0}ms`)

    const feed = await firebaseRead<{
      topics?: Array<{
        title: string
        summary?: string
        imageUrl?: string | null
        coverage: number
        firstSeen?: number
        latestSeen?: number
        articles?: Array<{ title: string; link: string }>
      }>
      articleCount?: number
      sourceCount?: number
    }>(`customFeeds/${id}`)

    const topics = feed?.topics || []
    const imgs = topics.filter((t) => t.imageUrl)
    console.log(
      `topics: ${topics.length} | images: ${imgs.length}/${topics.length} (${Math.round(
        (100 * imgs.length) / Math.max(1, topics.length),
      )}%) | articles: ${feed?.articleCount} | sources: ${feed?.sourceCount}`,
    )

    // Junk survivors — the new gate should leave ZERO
    const junk = topics.filter((t) => isJunkTitle(t.title))
    console.log(`junk survivors: ${junk.length}`)
    for (const t of junk) console.log(`  JUNK: ${t.title.slice(0, 110)}`)

    // Short/vague titles (< 4 words) that made it through
    const short = topics.filter((t) => t.title.split(/\s+/).length < 4)
    console.log(`<4-word titles: ${short.length}`)
    for (const t of short) console.log(`  SHORT: ${t.title}`)

    const compound = topics.filter((t) => /; | \| /.test(t.title))
    console.log(`compound titles: ${compound.length}`)

    // Ranking order + freshness of the top 12 (the new combined rank)
    const now = Date.now()
    console.log('top 12 (rank order | coverage | age | img | title):')
    for (const t of topics.slice(0, 12)) {
      const ageH = t.latestSeen ? Math.round((now - t.latestSeen) / 3600000) : '?'
      console.log(
        `  [${t.coverage}src ${String(ageH).padStart(3)}h ${t.imageUrl ? 'IMG' : '---'}] ${t.title.slice(0, 95)}`,
      )
    }
  }
}

main().catch((e) => {
  console.error('verify failed:', e)
  process.exit(1)
})
