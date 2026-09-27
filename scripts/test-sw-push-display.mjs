#!/usr/bin/env node
/**
 * test-sw-push-display.mjs — functional test of the v28 push-display URL
 * ABSOLUTIZATION in public/sw.js, run in Node with mocked SW globals.
 *
 * Scenarios:
 *  1. Payload with RELATIVE icon/badge/image (old briefing payloads,
 *     scheduled pushes) → showNotification must receive ABSOLUTE URLs.
 *  2. Payload with ABSOLUTE URLs already → unchanged (no double-prefix).
 *  3. Payload with NO image (image: null) → options.image stays null/absent,
 *     icon/badge still absolutized.
 *  4. Action button icons also absolutized ([Like | Not Interested] pair).
 *  5. likeButton:false → single Not Interested action, icon absolutized.
 *  6. Push with NO data (event.data null) → SW defaults, icon/badge
 *     absolutized from the default relative paths.
 *  7. Non-JSON payload (text) → defaults used, body = the text.
 *  8. Malformed URL string → passed through unchanged (no throw).
 *  9. notifId/tag/likeButton/data plumbing unchanged (regression).
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SW_SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const ORIGIN = 'https://neutralwire.org'

/** Build a mock SW world and evaluate sw.js inside it. */
function makeWorld() {
  const listeners = {}
  const shown = []
  const selfObj = {
    location: { origin: ORIGIN },
    skipWaiting: () => {},
    registration: {
      showNotification: async (title, options) => {
        shown.push({ title, options })
      },
    },
    addEventListener: (type, fn) => {
      listeners[type] = fn
    },
    clients: {
      matchAll: async () => [],
      openWindow: async () => null,
    },
  }
  const sandbox = {
    self: selfObj,
    caches: { open: async () => ({ match: async () => undefined, put: async () => {} }) },
    clients: selfObj.clients,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    Response: class {
      constructor(text) { this._text = text }
      text() { return Promise.resolve(this._text) }
      json() { return Promise.resolve(JSON.parse(this._text)) }
    },
    Request: class {},
    URL,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener: () => {},
    importScripts: () => {},
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(SW_SOURCE, sandbox)
  return { listeners, shown, sandbox }
}

/** Drive a push event with the given payload object (or null for no data). */
async function firePush(world, payload) {
  const ev = {
    data: payload === null ? null : { json: () => payload, text: () => JSON.stringify(payload) },
    waitUntil: () => {},
  }
  world.listeners['push'](ev)
  // showNotification is async — let the microtask queue drain
  await new Promise((r) => setTimeout(r, 10))
  return world.shown[world.shown.length - 1]
}

// ── 1. Relative payload URLs → absolutized ──
{
  const w = makeWorld()
  const n = await firePush(w, {
    title: 'Morning Briefing',
    body: 'OpenAI hacked Australians phones',
    url: '/?topic=a11ebt4j',
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    image: '/api/og-image?topicId=a11ebt4j&imageUrl=x',
    tag: 'briefing-morning',
    notifId: 'tz_1',
    likeButton: true,
  })
  check('1a. relative icon → absolute', n.options.icon === `${ORIGIN}/icon-192.png`, String(n.options.icon))
  check('1b. relative badge → absolute', n.options.badge === `${ORIGIN}/badge-96.png`, String(n.options.badge))
  check('1c. relative image → absolute', n.options.image === `${ORIGIN}/api/og-image?topicId=a11ebt4j&imageUrl=x`, String(n.options.image))
  check('1d. title/body/tag unchanged', n.title === 'Morning Briefing' && n.options.body === 'OpenAI hacked Australians phones' && n.options.tag === 'briefing-morning')
}

// ── 2. Absolute URLs pass through untouched ──
{
  const w = makeWorld()
  const n = await firePush(w, {
    title: 'Evening Briefing',
    body: 'Story',
    url: '/?topic=x',
    icon: 'https://neutralwire.org/icon-192.png',
    badge: 'https://neutralwire.org/badge-96.png',
    image: 'https://neutralwire.org/api/og-image?topicId=x',
    tag: 'briefing-evening',
  })
  check('2a. absolute icon unchanged', n.options.icon === 'https://neutralwire.org/icon-192.png')
  check('2b. absolute badge unchanged', n.options.badge === 'https://neutralwire.org/badge-96.png')
  check('2c. absolute image unchanged', n.options.image === 'https://neutralwire.org/api/og-image?topicId=x')
}

// ── 3. No image → null, icons still absolutized ──
{
  const w = makeWorld()
  const n = await firePush(w, {
    title: 'Lunch Briefing', body: 'Story', url: '/',
    icon: '/icon-192.png', badge: '/badge-96.png', image: null, tag: 'briefing-lunch',
  })
  check('3a. null image stays null (no bogus URL)', n.options.image === null || n.options.image === undefined)
  check('3b. icon still absolutized without image', n.options.icon === `${ORIGIN}/icon-192.png`)
}

// ── 4. Action icons absolutized (likeButton true) ──
{
  const w = makeWorld()
  const n = await firePush(w, {
    title: 'T', body: 'B', url: '/', icon: '/icon-192.png', badge: '/badge-96.png',
    image: null, tag: 't', likeButton: true,
  })
  check('4a. two actions rendered', n.options.actions.length === 2, JSON.stringify(n.options.actions))
  check('4b. like action icon absolute', n.options.actions[0].icon === `${ORIGIN}/badge-96.png`)
  check('4c. dislike action icon absolute', n.options.actions[1].icon === `${ORIGIN}/icon-192.png`)
  check('4d. action titles unchanged', n.options.actions[0].title === 'Like' && n.options.actions[1].title === 'Not Interested')
}

// ── 5. likeButton false → single action, absolutized ──
{
  const w = makeWorld()
  const n = await firePush(w, {
    title: 'T', body: 'B', url: '/', icon: '/icon-192.png', badge: '/badge-96.png',
    image: null, tag: 't', likeButton: false,
  })
  check('5a. single Not Interested action', n.options.actions.length === 1 && n.options.actions[0].title === 'Not Interested')
  check('5b. its icon absolute', n.options.actions[0].icon === `${ORIGIN}/icon-192.png`)
  check('5c. click-time likeButton flag false', n.options.data.likeButton === false)
}

// ── 6. No data at all → SW defaults, absolutized ──
{
  const w = makeWorld()
  const n = await firePush(w, null)
  check('6a. default title used', n.title === 'NeutralWire')
  check('6b. default icon absolutized', n.options.icon === `${ORIGIN}/icon-192.png`)
  check('6c. default badge absolutized', n.options.badge === `${ORIGIN}/badge-96.png`)
  check('6d. default image null', n.options.image === null || n.options.image === undefined)
}

// ── 7. Non-JSON (text) payload → defaults + text body ──
{
  const w = makeWorld()
  const ev = { data: { json: () => { throw new Error('not json') }, text: () => 'plain text body' }, waitUntil: () => {} }
  w.listeners['push'](ev)
  await new Promise((r) => setTimeout(r, 10))
  const n = w.shown[w.shown.length - 1]
  check('7a. text body shown', n.options.body === 'plain text body')
  check('7b. icons absolutized on text path', n.options.icon === `${ORIGIN}/icon-192.png`)
}

// ── 8. Malformed URL string passes through without throwing ──
{
  const w = makeWorld()
  const n = await firePush(w, {
    title: 'T', body: 'B', url: '/', icon: 'http://[invalid', badge: '', image: 'http://[',
    tag: 't',
  })
  check('8a. malformed icon passed through', n.options.icon === 'http://[invalid', String(n.options.icon))
  check('8b. empty badge passed through (falsy)', n.options.badge === '' || n.options.badge === undefined)
  check('8c. malformed image passed through (no throw)', n.options.image === 'http://[' || n.options.image === undefined, String(n.options.image))
}

// ── 9. Data plumbing regression (url/notifId/topicTitle) ──
{
  const w = makeWorld()
  const n = await firePush(w, {
    title: 'Morning Briefing', body: 'The headline', url: '/?topic=abc123',
    icon: '/icon-192.png', badge: '/badge-96.png', image: null,
    tag: 'briefing-morning', notifId: 'tz_2026-09-26_morning_xy1234', likeButton: true,
  })
  check('9a. data.url preserved for click routing', n.options.data.url === '/?topic=abc123')
  check('9b. notifId preserved for click dedup', n.options.data.notifId === 'tz_2026-09-26_morning_xy1234')
  check('9c. topicTitle mirrors body for click tracking', n.options.data.topicTitle === 'The headline')
  check('9d. likeButton true preserved in data', n.options.data.likeButton === true)
}

console.log(`\n${pass} passed, ${fail} failed (sw push-display absolutization)`)
process.exit(fail > 0 ? 1 : 0)
