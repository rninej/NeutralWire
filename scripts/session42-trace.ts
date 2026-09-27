/** session42 trace — where did the "women crush Uzbekistan" half go? */
import { firebaseRead } from '../src/lib/firebase-server'
import { CATALOG_BY_ID } from '../src/lib/subtopic-catalog'

async function main() {
  const def = CATALOG_BY_ID['chess']
  console.log('chess keywords:', def?.keywords?.join(', '))

  const feed = await firebaseRead<{
    topics: Array<{ title: string; coverage: number; articles?: Array<{ title: string }> }>
  }>('customFeeds/chess')
  const topics = feed?.topics || []
  console.log(`topics: ${topics.length}`)
  for (const t of topics) {
    if (/crush/i.test(t.title)) {
      console.log('TOPIC MATCH:', t.title.slice(0, 90), '| cov:', t.coverage)
    }
    for (const a of t.articles || []) {
      if (/crush/i.test(a.title)) console.log('  ↳ article inside topic:', a.title.slice(0, 90))
    }
  }
}

main().catch((e) => {
  console.error('trace failed:', e)
  process.exit(1)
})
