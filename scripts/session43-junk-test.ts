/** session43 — junk filter unit checks (node, no framework). */
import { isJunkTitle, isJunkDomain } from '../src/lib/junk-filter.ts'

const JUNK = [
  // the exact user-reported case (plus hashtag variations of it)
  "#TSRMommyDuties: Aww! #Serayah reflects on her summer and shares photos with her",
  '#Breaking: Something happened',
  'Celeb news #trending #viral today',
  'RT @cnn: Big story unfolds',
  '@nasa announces new mission',
  'Aww! Puppies melt hearts',
  'OMG! Star shares photos with fans',
  'Serayah shares video of her summer',
  'Taylor Swift takes to Instagram to address rumors',
  'Twitter reacts to the debate',
  'Clips go viral on TikTok after speech',
  'Fans speculate about the trailer',
  'Fans are convinced the album drops Friday',
  'Photos',
  'Watch',
  'Live updates',
  'Day 3',
  'Read more',
  'Queen visits',
]

const NEWS = [
  // real, varied headlines that MUST survive
  'Chess Olympiad: Gukesh\u2019s brilliance helps India pip Germany',
  'Women crush Uzbekistan to stay in the lead',
  'Fed cuts interest rates by 25 basis points',
  'Markets fall as inflation data disappoints investors',
  'Watch live: Pope Francis addresses the general audience', // "Watch live:" prefix is stripped elsewhere; word content is real
  'Seven dead in flooding across central Europe',
  'NASA\u2019s Europa Clipper swings by Mars on its way to Jupiter',
  'We\u2019re #1 in the standings after the win', // single embedded #1 — tolerated
  'Apple Watch Series 10 gets a bigger screen and faster charging',
  'Ukraine war: Kyiv and Lviv hit by overnight drone attacks',
  'India pip Germany at the Chess Olympiad in a thrilling tiebreak',
  'The Fed said rates will stay higher for longer',
  'She posts letter about the border dispute', // "posts" as noun — kept (pattern needs a media object)
]

let fails = 0
console.log('── should be JUNK ──')
for (const t of JUNK) {
  const j = isJunkTitle(t)
  if (!j) {
    fails++
    console.log('  MISS:', t)
  }
}
console.log(`  ${JUNK.filter((t) => isJunkTitle(t)).length}/${JUNK.length} caught`)

console.log('── should be NEWS (kept) ──')
for (const t of NEWS) {
  const j = isJunkTitle(t)
  if (j) {
    fails++
    console.log('  FALSE-POSITIVE:', t)
  }
}
console.log(`  ${NEWS.filter((t) => !isJunkTitle(t)).length}/${NEWS.length} kept`)

console.log('── domains ──')
const domainChecks = [
  ['theshaderoom.com', true],
  ['https://www.theshaderoom.com', true],
  ['www.balleralert.com', true],
  ['reuters.com', false],
  ['https://www.bbc.co.uk', false],
  ['', false],
  [undefined, false],
]
for (const [d, expected] of domainChecks) {
  const got = isJunkDomain(d)
  if (got !== expected) {
    fails++
    console.log('  DOMAIN MISMATCH:', d, '→', got, 'expected', expected)
  }
}
console.log(`  ${domainChecks.filter(([d, e]) => isJunkDomain(d) === e).length}/${domainChecks.length} correct`)

console.log(fails === 0 ? 'ALL CHECKS PASS' : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
