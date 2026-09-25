/**
 * test-briefing-payload.ts — unit tests for the size-guarded briefing
 * payload builder. Run: bun scripts/test-briefing-payload.ts
 */
import { buildBriefingPayload } from '../src/lib/push/briefing-payload'

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

console.log('briefing-payload unit tests')

// ── 1. Normal payload: untouched, image preserved, ABSOLUTE icons ──
{
  const p = buildBriefingPayload({
    title: 'Evening Briefing',
    body: 'Trump says he can do business with Burnham but criticises terrible deal',
    url: '/?topic=a11ebt4j',
    origin: 'https://neutralwire.org',
    image: 'https://neutralwire.org/api/og-image?topicId=a11ebt4j&title=Trump%20says&imageUrl=https%3A%2F%2Fimg.example.com%2Fa.jpg',
    tag: 'briefing-evening',
    notifId: 'tz_2026-09-23_evening_abc123',
    likeButton: true,
  })
  const o = JSON.parse(p)
  check('1a. image preserved on normal payload', typeof o.image === 'string' && o.image.includes('og-image'))
  check('1b. all fields present', o.title === 'Evening Briefing' && o.tag === 'briefing-evening' && o.notifId.includes('abc123') && o.likeButton === true && o.url === '/?topic=a11ebt4j')
  check('1c. ABSOLUTE icon URL (Android/iOS display paths)', o.icon === 'https://neutralwire.org/icon-192.png', `icon=${o.icon}`)
  check('1d. ABSOLUTE badge URL (monochrome header icon)', o.badge === 'https://neutralwire.org/badge-96.png', `badge=${o.badge}`)
  check('1e. under soft limit', p.length <= 3800, `len=${p.length}`)
}

// ── 2. Monster imageUrl: image stripped, payload sendable ──
{
  // A realistic monster: a query-chain URL that URL-encodes to ~9KB
  const monsterImg = 'https://img.example.com/photo.jpg?w=1200&h=630&fit=crop&crop=faces&fm=jpg&q=75&' + 't='.repeat(300) + 'x'.repeat(3000)
  const p = buildBriefingPayload({
    title: 'Morning Briefing',
    body: 'At least 169 killed in Colombia earthquake in years',
    url: '/?topic=akjlmjx',
    origin: 'https://neutralwire.org',
    image: 'https://neutralwire.org/api/og-image?topicId=akjlmjx&imageUrl=' + encodeURIComponent(monsterImg),
    tag: 'briefing-morning',
    notifId: 'tz_2026-09-23_morning_def456',
    likeButton: false,
  })
  const o = JSON.parse(p)
  check('2a. monster image stripped', o.image === undefined, `keys=${Object.keys(o).join(',')}`)
  check('2b. payload under 4096 hard limit', p.length <= 4096, `len=${p.length}`)
  check('2c. body/title intact without image', o.body === 'At least 169 killed in Colombia earthquake in years' && o.title === 'Morning Briefing')
  check('2d. likeButton false preserved', o.likeButton === false)
}

// ── 3. No image at all: no image key, likeButton true ──
{
  const p = buildBriefingPayload({
    title: 'Lunch Briefing', body: 'A short headline', url: '/?topic=xyz',
    origin: 'https://neutralwire.org',
    image: null, tag: 'briefing-lunch', notifId: 'tz_x', likeButton: true,
  })
  const o = JSON.parse(p)
  check('3a. null image → no image key', !('image' in o))
  check('3b. payload small', p.length < 500, `len=${p.length}`)
  check('3c. icons still absolute without image', o.icon === 'https://neutralwire.org/icon-192.png')
}

// ── 4. Pathological body (worst case): truncated to 60 ──
{
  const p = buildBriefingPayload({
    title: 'Evening Briefing',
    body: 'B'.repeat(9000),
    url: '/?topic=' + 'u'.repeat(2000),
    origin: 'https://neutralwire.org',
    image: 'https://neutralwire.org/api/og-image?topicId=x&imageUrl=' + encodeURIComponent('https://img.example.com/' + 'z'.repeat(2500)),
    tag: 'briefing-evening', notifId: 'tz_y', likeButton: true,
  })
  const o = JSON.parse(p)
  check('4a. image stripped', o.image === undefined)
  check('4b. body truncated to 60', o.body.length <= 60, `len=${o.body.length}`)
  check('4c. payload under hard limit', p.length <= 4096, `len=${p.length}`)
  check('4d. still valid JSON with url', typeof o.url === 'string')
}

// ── 5. Boundary: payload exactly at the soft limit stays intact ──
{
  // Build a body so the total lands just under 3800 with image present
  const img = 'https://img.example.com/' + 'a'.repeat(600)
  const base = buildBriefingPayload({
    title: 'Morning Briefing', body: 'x'.repeat(100), url: '/?topic=t1',
    origin: 'https://neutralwire.org',
    image: img, tag: 'briefing-morning', notifId: 'tz_z', likeButton: true,
  })
  check('5a. mid-size payload keeps image', JSON.parse(base).image === img)
  check('5b. mid-size under limit', base.length <= 3800, `len=${base.length}`)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
