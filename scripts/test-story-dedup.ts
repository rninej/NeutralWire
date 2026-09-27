/**
 * test-story-dedup.ts — unit tests for the near-duplicate news detector
 * (src/lib/push/story-dedup.ts). Run: bun scripts/test-story-dedup.ts
 *
 * The scenarios are built from the REAL failure the user reported
 * (Sep 2026): "i got a news about the openai hacking of australia 2 times
 * in a day the news was in slightly different words" — plus the
 * distinct-events and number-update cases that MUST keep working.
 */
import {
  titleSignature,
  titleKeywordSet,
  isNearDuplicateTitle,
  isNearDuplicateSignature,
  dropNearDuplicateTopics,
} from '../src/lib/push/story-dedup'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

console.log('story-dedup unit tests')

// ── 0. Stemmer basics ──
{
  const stem = (w: string) => titleKeywordSet(`x ${w} y`).size === 1 ? Array.from(titleKeywordSet(`x ${w} y`))[0] : `?${w}`
  // 'x'/'y' are <3 chars and dropped, so the set is just the target stem
  check('0a. australia → austra (6-char cap)', stem('australia') === 'austra', stem('australia'))
  check('0b. australian → austra (matches australia)', stem('australian') === 'austra', stem('australian'))
  check('0c. russia/russian both → russia', stem('russia') === stem('russian') && stem('russia') === 'russia')
  check('0d. hacked/hacking/hackers/hack all → hack', stem('hacked') === 'hack' && stem('hacking') === 'hack' && stem('hackers') === 'hack' && stem('hack') === 'hack')
  check('0e. kills/killed/kill same, dead→kill (synonym)', stem('kills') === stem('killed') && stem('dead') === 'kill')
  check('0f. earthquake/earthquakes same stem', stem('earthquake') === stem('earthquakes'))
}

// ── 1. THE REPORTED BUG: OpenAI/Australia re-headlined twin ──
{
  const a = 'OpenAI hacked Australians\u2019 phones, Dutton claims'
  const b = 'Australia calls out OpenAI over hacking claims'
  check('1a. OpenAI/Australia twin = near-duplicate (the reported bug)', isNearDuplicateTitle(a, b))

  // Signature mode (what trigger-tz uses against sent-history)
  const sigA = titleSignature(a)
  check('1b. re-headlined twin blocked via stored signature', isNearDuplicateSignature(b, sigA))
  check('1c. original blocked against own signature (sanity)', isNearDuplicateSignature(a, sigA))
}

// ── 2. Number-update twins still caught (the old fingerprint's job) ──
{
  const a = 'At least 139 killed in Colombia\u2019s largest earthquake in years'
  const b = 'At least 169 killed in Colombia\u2019s largest earthquake in years'
  check('2a. 139→169 killed Colombia quake = near-duplicate', isNearDuplicateTitle(a, b))
  check('2b. number-update blocked via stored signature', isNearDuplicateSignature(b, titleSignature(a)))
}

// ── 3. DISTINCT events must survive ──
{
  const a = 'Russia strikes Kyiv in overnight drone attack'
  const b = 'Russia strikes Lviv overnight in drone attack'
  // share russia/strike/overnight/drone/attack but only ONE entity (russia)
  check('3a. Kyiv vs Lviv strikes = DIFFERENT stories (entity guard)', !isNearDuplicateTitle(a, b))
  check('3a2. Kyiv vs Lviv also separate in signature mode (history)', !isNearDuplicateSignature(a, titleSignature(b)) && !isNearDuplicateSignature(b, titleSignature(a)))

  const c = 'OpenAI launches new search engine'
  const d = 'OpenAI hacked Australia'
  check('3b. two different OpenAI stories stay separate', !isNearDuplicateTitle(c, d))

  const e = 'Premier League: Arsenal beat Chelsea 2-0'
  const f = 'Transfer news: Arsenal sign striker from Chelsea'
  check('3c. Arsenal match vs Arsenal transfer stay separate', !isNearDuplicateTitle(e, f))

  const g = 'NHS waiting lists fall for third month'
  const h = 'NHS staff pay deal agreed by government'
  check('3d. two different NHS stories stay separate', !isNearDuplicateTitle(g, h))
}

// ── 4. dropNearDuplicateTopics: pool-level greedy drop ──
{
  const pool = [
    { title: 'OpenAI hacked Australians\u2019 phones, Dutton claims', topicId: 'a1' },
    { title: 'Australia calls out OpenAI over hacking claims', topicId: 'a2' },
    { title: 'Russia strikes Kyiv in overnight drone attack', topicId: 'a3' },
    { title: 'Russia strikes Lviv overnight in drone attack', topicId: 'a3b' },
    { title: 'At least 139 killed in Colombia\u2019s largest earthquake in years', topicId: 'a4' },
    { title: 'At least 169 killed in Colombia\u2019s largest earthquake in years', topicId: 'a5' },
    { title: 'Premier League: Arsenal beat Chelsea 2-0', topicId: 'a6' },
  ]
  const out = dropNearDuplicateTopics(pool)
  const ids = out.map((t) => t.topicId)
  check('4a. re-headlined twin dropped from pool (a2 or a1 gone)', !(ids.includes('a1') && ids.includes('a2')), ids.join(','))
  check('4b. 139/169 quake twins collapsed to one', !(ids.includes('a4') && ids.includes('a5')), ids.join(','))
  check('4c. Kyiv strike kept', ids.includes('a3'))
  check('4c2. Lviv strike ALSO kept (entity guard in pool drop)', ids.includes('a3b'), ids.join(','))
  check('4d. Arsenal match kept', ids.includes('a6'))
  check('4e. rank order preserved', ids.indexOf('a3') < ids.indexOf('a4') || !ids.includes('a4'))
}

// ── 5. Short/generic titles never block (conservatism kept) ──
{
  check('5a. <3 significant tokens → empty signature', titleSignature('Breaking news today') === '')
  check('5b. empty signature never near-dups', !isNearDuplicateSignature('Breaking news today', titleSignature('Breaking news today')))
  const a = 'Fire at factory'
  const b = 'Fire at warehouse'
  check('5c. short generic pair not blocked', !isNearDuplicateTitle(a, b))
}

// ── 6. Cross-format robustness: punctuation & casing ──
{
  const a = 'OpenAI hacked Australians\u2019 phones, Dutton claims'
  const b = 'openai hacked australians phones dutton claims'
  check('6a. casing/punctuation-insensitive match', isNearDuplicateTitle(a, b))

  const c = 'US: 5 dead in bridge collapse'
  const d = 'Bridge collapse in US kills five'
  check('6b. 5/five dead↔kills collapse US = same event', isNearDuplicateTitle(c, d))
}

// ── 7. Signature round-trip stability ──
{
  const t = 'OpenAI hacked Australians\u2019 phones'
  const sig = titleSignature(t)
  check('7a. signature is sorted, space-joined, >=3 tokens', sig.split(' ').length >= 3 && sig === sig.split(' ').sort().join(' '))
  check('7b. signature deterministic', titleSignature(t) === sig)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
