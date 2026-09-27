/**
 * session42-verify.ts — force a full background refill of the chess feed
 * (the exact feed where the user saw the compound title + missing images)
 * and inspect the result: topic count, image coverage, compound titles.
 */
import { refreshCustomTopic } from '../src/lib/custom-topics'
import { firebaseRead } from '../src/lib/firebase-server'

async function main() {
  const t0 = Date.now()
  const payload = await refreshCustomTopic('chess', {
    aiFilter: true,
    mode: 'background',
    budgetMs: 25000,
  })
  console.log(`fill took ${Date.now() - t0}ms`)

  // Re-read from Firebase (the source of truth for what visitors get)
  const feed = await firebaseRead<{
    topics?: Array<{
      title: string
      imageUrl?: string | null
      coverage: number
      articles?: Array<{ link: string; title: string }>
    }>
    articleCount?: number
    sourceCount?: number
  }>('customFeeds/chess')

  const topics = feed?.topics || []
  const imgs = topics.filter((t) => t.imageUrl)
  console.log(`topics: ${topics.length} | with images: ${imgs.length} (${Math.round(
    (100 * imgs.length) / Math.max(1, topics.length),
  )}%) | articles: ${feed?.articleCount} | sources: ${feed?.sourceCount}`)

  const compound = topics.filter((t) => /[;]| \| /.test(t.title))
  console.log(`\ncompound titles: ${compound.length}`)
  for (const t of compound) console.log(`  - ${t.title.slice(0, 100)}`)

  const gukesh = topics.filter(
    (t) => /gukesh|germany|uzbekistan|women/i.test(t.title),
  )
  console.log('\nGukesh/Germany/Uzbekistan/women stories:')
  for (const t of gukesh) {
    console.log(
      `  [${t.coverage}src ${t.imageUrl ? 'IMG' : '---'}] ${t.title.slice(0, 100)}`,
    )
  }

  console.log('\ntop 10 by coverage:')
  for (const t of topics.slice(0, 10)) {
    console.log(`  [${t.coverage}src ${t.imageUrl ? 'IMG' : '---'}] ${t.title.slice(0, 100)}`)
  }
}

main().catch((e) => {
  console.error('verify failed:', e)
  process.exit(1)
})
