/**
 * Session 62 quick check — the search-match typo-tolerance + the client
 * matcher. Run: bun scripts/test-s62-search.ts
 */
import { queryTokens, scoreCandidate } from '../src/lib/search-match'
import { tokenizeQuery, localSearchHit } from '../src/lib/search-client'

let pass = 0
let fail = 0
function check(name: string, cond: boolean) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}`)
  }
}

console.log('── server matcher (search-match.ts) ──')
const tokens = queryTokens('elecion results')
check('typo query tokenized (elecion survives)', tokens.includes('elecion'))

const hit = scoreCandidate(tokens, 'elecion results', {
  title: 'Election results confirm the coalition',
  summary: '',
  articleTitles: [],
})
check('typo token matches via fuzzy (hit)', hit !== null)
check('fuzzy match recorded as election', !!hit?.fuzzyMatches?.some((f) => f.word === 'election'))
check('both tokens matched in title (fuzzy + strict)', hit?.titleMatched === 2)

const strict = scoreCandidate(queryTokens('election results'), 'election results', {
  title: 'Election results confirm the coalition',
  summary: '',
  articleTitles: [],
})
check('strict hit still works', strict !== null && strict.exact === true)
check('strict has no fuzzyMatches', strict?.fuzzyMatches === undefined)

const none = scoreCandidate(queryTokens('zzzqqq xyzzy'), 'zzzqqq xyzzy', {
  title: 'Completely unrelated story about fishing',
  summary: 'nothing matches here',
  articleTitles: [],
})
check('unrelated query is still a miss', none === null)

const cross = scoreCandidate(queryTokens('BBC Verify examines Russian-linked operations'), 'BBC Verify examines Russian-linked operations', {
  title: 'Russia-linked network spreads coordinated posts',
  summary: 'A network of accounts coordinated postings, researchers said.',
  articleTitles: ['BBC Verify examines Russian-linked operations'],
})
check('cross-source headline matching still hits', cross !== null && (cross?.articleMatched ?? 0) >= 3)

// Single-token queries keep the ORIGINAL substring behaviour by design
// ("chess" finds every mention, incl. inside longer words — recall first).
const shortSubstr = scoreCandidate(queryTokens('war'), 'war', {
  title: 'Warden of the north keeps the peace',
  summary: '',
  articleTitles: [],
})
check('short single-token keeps substring behaviour (documented)', shortSubstr !== null)
// But the FUZZY pass must never fire for short tokens: "wars" ≠ "war"
// via edit-distance only — a 5+ char typo does:
const typo5 = scoreCandidate(queryTokens('harasment'), 'harasment', {
  title: 'Report details harassment in the sector',
  summary: '',
  articleTitles: [],
})
check('≥5-char typo matches via fuzzy (harasment → harassment)',
  typo5 !== null && !!typo5.fuzzyMatches?.some((f) => f.word === 'harassment'))

console.log('── client matcher (search-client.ts) ──')
const ct = tokenizeQuery('macron tariff')
check('client tokenizer drops stopwords', !ct.includes('the') && ct.includes('macron'))
check(
  'client hit: word-order independent',
  localSearchHit(
    { title: 'Tariff dispute escalates as Macron speaks', summary: '' },
    ct,
  ),
)
check(
  'client hit: matches outlet article title',
  localSearchHit(
    { title: 'Unrelated headline', summary: '', articleTitles: ['Macron defends new tariff regime'] },
    ct,
  ),
)
check(
  'client miss: unrelated content',
  !localSearchHit(
    { title: 'Local sports team wins championship', summary: 'A great game was had by all.' },
    ct,
  ),
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
