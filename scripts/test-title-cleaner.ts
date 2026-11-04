/**
 * Title-cleaner tests for the WATCH/VIDEO strip (session 14).
 * Mirrors makeConciseTitle's leading-tag + trailing-fragment logic.
 */
const LEADING_TAGS =
  /^(BREAKING|LIVE|UPDATE|UPDATED|EXCLUSIVE|DEVELOPING|ANALYSIS|JUST IN|REPORT|WATCH|VIDEO)[\s:|-]+/i

function cleanLeading(title: string): string {
  let t = title.trim()
  for (let i = 0; i < 3; i++) {
    const next = t.replace(LEADING_TAGS, '')
    if (next === t) break
    t = next
  }
  t = t.replace(/\s*[|\-–]\s*(WATCH|Video|VIDEO)\s*$/i, '')
  return t
}

const cases: Array<[string, string, string]> = [
  ['WATCH: Moment police storm the building', 'Moment police storm the building', 'leading WATCH:'],
  ['WATCH LIVE: Cameron gives statement on economy', 'Cameron gives statement on economy', 'stacked WATCH LIVE:'],
  ['WATCH Moment earthquake hits Turkey', 'Moment earthquake hits Turkey', 'WATCH no colon'],
  ['Video: Workers rescued from hydro tunnel', 'Workers rescued from hydro tunnel', 'leading Video:'],
  ['VIDEO -Police rescue workers in Nepal', 'Police rescue workers in Nepal', 'VIDEO dash prefix'],
  ['Cameron speech - WATCH', 'Cameron speech', 'trailing - WATCH'],
  ['Cameron speech | Video', 'Cameron speech', 'trailing | Video'],
  ['Apple Watch launches with new features', 'Apple Watch launches with new features', 'KEEP genuine Apple Watch'],
  ['Parliament votes on the video game bill today', 'Parliament votes on the video game bill today', 'KEEP mid-title video word'],
  ['Live coverage: election night in America', 'coverage: election night in America', 'LIVE prefix (existing behavior)'],
  ['BREAKING: WATCH: Blast at refinery', 'Blast at refinery', 'double prefix'],
]

let pass = 0
for (const [input, expected, label] of cases) {
  const got = cleanLeading(input)
  const ok = got === expected
  if (ok) pass++
  console.log(`${ok ? 'PASS' : 'FAIL'} [${label}] "${input}" -> "${got}"${ok ? '' : ` (expected "${expected}")`}`)
}
console.log(`\n${pass}/${cases.length} passed`)
process.exit(pass === cases.length ? 0 : 1)
