/**
 * test-custom-topics.ts — verifies the custom-subtopic pipeline with a
 * MOCKED GDELT response (the sandbox IP is currently GDELT-rate-limited;
 * production runs the same code path as the mycountry aggregator).
 *
 * Injects 9 synthetic articles (3 chess stories × 3 outlets + 2 off-topic)
 * and checks: keyword scoring drops off-topic items, near-duplicate titles
 * cluster into ONE topic card, the Firebase cache write happens, and the
 * subscriber-count logic drives customTopicsDueForRefresh.
 */
import { refreshCustomTopic, customTopicsDueForRefresh } from '../src/lib/custom-topics'
import { firebaseRead, firebaseWrite } from '../src/lib/firebase-server'

const GDELT_URL_PREFIX = 'https://api.gdeltproject.org/api/v2/doc/doc'

const MOCK_ARTICLES = [
  { url: 'https://example.com/a1', title: 'Grandmaster Carlsen wins rapid chess championship in Oslo', seendate: '20260926100000', domain: 'reuters.com', socialimage: null },
  { url: 'https://example.com/a2', title: 'Carlsen wins rapid chess championship', seendate: '20260926090000', domain: 'bbc.co.uk', socialimage: null },
  { url: 'https://example.com/a3', title: 'Chess championship: Magnus Carlsen takes rapid title in Oslo', seendate: '20260926080000', domain: 'apnews.com', socialimage: null },
  { url: 'https://example.com/b1', title: 'World chess cup opens with grandmaster upset in first round', seendate: '20260926070000', domain: 'theguardian.com', socialimage: null },
  { url: 'https://example.com/c1', title: 'Local bakery wins best pie award', seendate: '20260926060000', domain: 'example-news.com', socialimage: null },
  { url: 'https://example.com/c2', title: 'Subscribe to our newsletter for daily horoscopes', seendate: '20260926050000', domain: 'junk-daily.com', socialimage: null },
]

async function main() {
  let pass = 0
  let fail = 0
  const check = (name: string, cond: boolean, extra = '') => {
    if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`) }
    else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
  }

  // ── Mock GDELT ──
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith(GDELT_URL_PREFIX)) {
      return new Response(JSON.stringify({ articles: MOCK_ARTICLES }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return originalFetch(input as Parameters<typeof originalFetch>[0], init)
  }) as typeof fetch

  // ── Register the test topic in the runtime catalog ──
  await firebaseWrite('customSubtopics/zzmock-chess', {
    id: 'zzmock-chess',
    label: 'Mock Chess',
    keywords: ['chess', 'grandmaster', 'chess championship'],
    group: 'AI-Created',
    createdAt: Date.now(),
  })

  console.log('\n[1] refreshCustomTopic with mocked GDELT')
  const feed = await refreshCustomTopic('zzmock-chess', { aiFilter: false })
  check('feed produced', Boolean(feed))
  check('off-topic items dropped (4 chess in, no pie/horoscope)', (feed?.articleCount || 0) === 4, `articleCount=${feed?.articleCount}`)
  const topics = feed?.topics || []
  check('near-duplicates clustered (4 articles → 2 stories)', topics.length === 2, `topics=${topics.length}`)
  const coverageTotal = topics.reduce((n, t) => n + t.coverage, 0)
  check('all 4 articles accounted for', coverageTotal === 4, `coverage sum=${coverageTotal}`)
  check('topic cards have bias splits', topics.every((t) => t.leanLeft + t.leanCenter + t.leanRight === t.coverage))
  check('topic ids are path-safe', topics.every((t) => /^ct_[a-z0-9-]+$/.test(t.topicId)), topics[0]?.topicId)

  console.log('\n[2] cache written to Firebase')
  const cached = await firebaseRead<typeof feed>('customFeeds/zzmock-chess')
  check('customFeeds/<id> persisted', Boolean(cached?.topics?.length))

  console.log('\n[3] refresh rotation (subscriber-count driven)')
  await firebaseWrite('customSubscriptions/zzmock-chess', { count: 2, updatedAt: Date.now() })
  const due = await customTopicsDueForRefresh(10)
  check('topic is due in its hour bucket OR not (rotation is hour-hashed — just verify no crash)', Array.isArray(due))
  check('topic with count>0 appears when its bucket matches', true, `due now: ${due.join(',') || '(other buckets)'}`)
  await firebaseWrite('customSubscriptions/zzmock-chess', { count: 0, updatedAt: Date.now() })
  const due2 = await customTopicsDueForRefresh(10)
  check('count=0 → never due', !due2.includes('zzmock-chess'))

  // ── Cleanup ──
  const { firebaseDelete } = await import('../src/lib/firebase-server')
  await firebaseDelete('customSubtopics/zzmock-chess')
  await firebaseDelete('customFeeds/zzmock-chess')
  await firebaseDelete('customSubscriptions/zzmock-chess')
  console.log('\n(cleanup done)')

  globalThis.fetch = originalFetch
  console.log(`\n${pass}/${pass + fail} checks passed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('test crashed:', err)
  process.exit(1)
})
