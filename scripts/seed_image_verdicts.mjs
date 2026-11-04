/**
 * Pre-seed the image-verdicts Firebase node for the known Tesco glitch:
 *   - iStock-458531819 (Tesco storefront) + Netanyahu headline → 0 (bad)
 *   - The Hindu's Reuters photo + Netanyahu headline → 1 (ok)
 *
 * This way even the FIRST post-deploy refresh skips the bad image with
 * zero AI calls, and The Hindu photo is chosen instantly.
 *
 * Seeds both the &amp;-escaped and raw-& URL variants (the RSS parser
 * sometimes leaves XML entities in image URLs).
 */
const DB = 'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'

// Replicates hashId() from src/lib/news-aggregator.ts
function hashId(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return 'a' + (h >>> 0).toString(36)
}

const TITLE = 'Netanyahu says Iran tried to kill one of his sons'

const TESCO_RAW =
  'https://static.independent.co.uk/2026/08/13/9/13/iStock-458531819.jpg?width=1200&auto=webp&trim=0%2C2%2C0%2C2'
const TESCO_ESCAPED = TESCO_RAW.replace(/&/g, '&amp;')
const HINDU =
  'https://th-i.thgim.com/public/incoming/d5g8ul/article71392129.ece/alternates/LANDSCAPE_1200/2026-08-24T184219Z_1225272422_RC2C0NAFZUJR_RTRMADP_3_IRAN-CRISIS-ISRAEL-NETANYAHU.JPG'

const patch = {}
for (const url of [TESCO_RAW, TESCO_ESCAPED]) {
  patch[hashId(url + '|' + TITLE)] = 0 // bad — never show with this headline
}
patch[hashId(HINDU + '|' + TITLE)] = 1 // ok — verified Reuters photo

const res = await fetch(`${DB}/image-verdicts.json`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(patch),
})
if (!res.ok) throw new Error(`PATCH failed: HTTP ${res.status}`)
const out = await res.json()
console.log('Seeded verdicts:')
for (const [k, v] of Object.entries(out)) {
  console.log(`  ${k} = ${v}`)
}
