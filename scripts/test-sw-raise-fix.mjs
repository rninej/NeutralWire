#!/usr/bin/env node
/**
 * test-sw-raise-fix.mjs — functional test of the v27 notificationclick
 * RAISE VERIFICATION in public/sw.js, run in Node with mocked SW globals.
 *
 * Scenarios:
 *  1. Warm app HIDDEN + focus() resolves but never raises (the Android
 *     bug) + flag ON  → openWindow(url) must be called (the fix).
 *  2. Warm app HIDDEN + focus() resolves + recheck shows visible →
 *     postMessage('open-topic') to the SAME client, no openWindow.
 *  3. Warm app VISIBLE → focus + postMessage, no delay-path issues.
 *  4. Flag OFF (mirrored via NW_SW_FLAGS) → exact legacy behaviour:
 *     focus() resolving means postMessage + return, no openWindow.
 *  5. Like tap + hidden + not raised → openWindow url carries like=1.
 *  6. No existing window → openWindow (cold start, unchanged).
 *  7. openWindow refused + existing hidden client → last-resort
 *     postMessage to the hidden client.
 *  8. Flag persistence: NW_SW_FLAGS message → Cache Storage → a NEW SW
 *     instance (restart) reads the OFF flag and takes the legacy path.
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SW_SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

/** Build a mock SW world and evaluate sw.js inside it. */
function makeWorld({ clients = [], focusBehaviour = {}, openWindowBehaviour = {}, storedFlags = null } = {}) {
  const listeners = {}
  const calls = { openWindow: [], postMessages: [], focus: [], fetched: [] }

  // --- Cache Storage mock (the SW flag store) ---
  const flagStore = new Map()
  if (storedFlags) flagStore.set('/nw-sw-flags', JSON.stringify(storedFlags))
  const cacheMock = {
    match: async (key) => (flagStore.has(key) ? { json: async () => JSON.parse(flagStore.get(key)) } : undefined),
    put: async (key, res) => {
      flagStore.set(key, await res.text())
    },
  }
  const cachesMock = { open: async () => cacheMock }

  class FakeResponse {
    constructor(text) {
      this._text = text
    }
    text() {
      return Promise.resolve(this._text)
    }
    json() {
      return Promise.resolve(JSON.parse(this._text))
    }
  }

  // --- window clients ---
  let idSeq = 0
  const mkClient = (over = {}) => {
    const c = {
      id: `c${++idSeq}`,
      url: over.url ?? 'https://neutralwire.app/',
      visibilityState: over.visibilityState ?? 'visible',
      focus: async () => {
        calls.focus.push(c.id)
        if (over.focusThrows) throw new Error('NotAllowedError')
        if (over.focusRaises) c.visibilityState = 'visible'
        return c
      },
      postMessage: (msg) => {
        calls.postMessages.push({ clientId: c.id, msg })
      },
    }
    return c
  }
  const clientList = clients.map(mkClient)

  const clientsApi = {
    matchAll: async () => clientList.slice(),
    openWindow: async (url) => {
      calls.openWindow.push(url)
      if (openWindowBehaviour.throws) throw new Error('openWindow refused')
      if (openWindowBehaviour.returnsNull) return null
      const opened = mkClient({ url, visibilityState: 'visible' })
      clientList.push(opened)
      return opened
    },
  }

  const selfObj = {
    location: { origin: 'https://neutralwire.app' },
    skipWaiting: () => {},
    registration: { showNotification: async () => {} },
    addEventListener: (type, fn) => {
      listeners[type] = fn
    },
    clients: clientsApi,
  }

  const sandbox = {
    self: selfObj,
    caches: cachesMock,
    clients: clientsApi,
    fetch: async (url) => {
      calls.fetched.push(url)
      return { ok: true, json: async () => ({}) }
    },
    Response: FakeResponse,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    console,
    Promise,
    JSON,
    Date,
    URL,
    Error,
    Object,
    Array,
    Math,
    undefined,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(SW_SOURCE, sandbox, { filename: 'sw.js' })

  /** Fire a notificationclick and let its waitUntil settle. */
  async function click({ action = '', url = '/?topic=abc123', notifId = 'n1', likeButton = true } = {}) {
    const event = {
      action,
      notification: {
        close() {},
        data: { url, notifId, topicTitle: 'Story', likeButton },
      },
      waitUntil: (p) => {
        event._p = Promise.resolve(p).catch(() => {})
      },
    }
    listeners.notificationclick(event)
    await event._p
    // flush any trailing setTimeout(...) postMessage retries
    await sleep(1700)
    return event
  }

  async function pageMessage(data) {
    const event = { data, waitUntil: (p) => { event._p = Promise.resolve(p).catch(() => {}) } }
    listeners.message(event)
    await event._p
  }

  return { calls, click, pageMessage, flagStore, clientList }
}

async function main() {
  // ── 1. The Android bug: hidden window, focus() resolves, never raises ──
  {
    console.log('\n[1] hidden app + focus() resolves without raising + flag ON (default)')
    const w = makeWorld({ clients: [{ visibilityState: 'hidden' }] })
    await w.click({})
    check('openWindow called (app re-raised)', w.calls.openWindow.length === 1, JSON.stringify(w.calls.openWindow))
    check('openWindow got the topic url', w.calls.openWindow[0] === '/?topic=abc123')
    check('no open-topic to the stuck hidden client', !w.calls.postMessages.some((p) => p.msg.type === 'open-topic' && p.clientId === 'c1'))
  }

  // ── 2. Hidden app, focus works and recheck sees it visible ──
  {
    console.log('\n[2] hidden app + focus() actually raises it')
    const w = makeWorld({ clients: [{ visibilityState: 'hidden', focusRaises: true }] })
    await w.click({})
    check('no openWindow (app was raised by focus)', w.calls.openWindow.length === 0)
    check('open-topic posted to the raised client', w.calls.postMessages.some((p) => p.msg.type === 'open-topic' && p.clientId === 'c1'))
    check('autoLike false for a plain tap', w.calls.postMessages.find((p) => p.msg.type === 'open-topic')?.msg.autoLike === false)
  }

  // ── 3. App already visible (notification shade over it) ──
  {
    console.log('\n[3] app already visible')
    const w = makeWorld({ clients: [{ visibilityState: 'visible' }] })
    await w.click({})
    check('no openWindow', w.calls.openWindow.length === 0)
    check('open-topic posted', w.calls.postMessages.some((p) => p.msg.type === 'open-topic'))
  }

  // ── 4. Flag OFF → exact legacy v25 behaviour ──
  {
    console.log('\n[4] flag OFF (via NW_SW_FLAGS message) — legacy behaviour')
    const w = makeWorld({ clients: [{ visibilityState: 'hidden' }] }) // focus resolves, no raise
    await w.pageMessage({ type: 'NW_SW_FLAGS', notifRaiseFix: false })
    check('flag persisted to the flag cache', w.flagStore.get('/nw-sw-flags') === '{"notifRaiseFix":false}')
    await w.click({})
    check('legacy: open-topic posted (focus trusted)', w.calls.postMessages.some((p) => p.msg.type === 'open-topic' && p.clientId === 'c1'))
    check('legacy: NO openWindow', w.calls.openWindow.length === 0)
  }

  // ── 5. Like tap + hidden + not raised → openWindow carries like=1 ──
  {
    console.log('\n[5] Like tap + hidden app + focus does not raise')
    const w = makeWorld({ clients: [{ visibilityState: 'hidden' }] })
    await w.click({ action: 'like' })
    check('openWindow called', w.calls.openWindow.length >= 1)
    check('openWindow url has like=1', w.calls.openWindow[0]?.includes('like=1'), w.calls.openWindow[0])
    check('openWindow url still has topic', w.calls.openWindow[0]?.includes('topic=abc123'))
    check('like feedback fired (fire-and-forget)', w.calls.fetched.some((u) => u.includes('/api/notification/feedback')))
  }

  // ── 6. Cold start — no existing window ──
  {
    console.log('\n[6] no existing window (cold start)')
    const w = makeWorld({ clients: [] })
    await w.click({})
    check('openWindow called with topic url', w.calls.openWindow[0] === '/?topic=abc123')
    check('open-topic retry message sent to opened client', w.calls.postMessages.some((p) => p.msg.type === 'open-topic'))
  }

  // ── 7. openWindow refused + existing hidden client → last resort ──
  {
    console.log('\n[7] openWindow refused + hidden client (last resort)')
    const w = makeWorld({ clients: [{ visibilityState: 'hidden' }], openWindowBehaviour: { throws: true } })
    await w.click({})
    check('openWindow attempted', w.calls.openWindow.length === 2, JSON.stringify(w.calls.openWindow)) // url + '/' retry
    check('last resort: open-topic posted to hidden client', w.calls.postMessages.some((p) => p.msg.type === 'open-topic' && p.clientId === 'c1'))
  }

  // ── 8. Flag persists across an SW restart ──
  {
    console.log('\n[8] SW restart — OFF flag read back from Cache Storage')
    const first = makeWorld({ clients: [] })
    await first.pageMessage({ type: 'NW_SW_FLAGS', notifRaiseFix: false })
    const stored = JSON.parse(first.flagStore.get('/nw-sw-flags'))
    const second = makeWorld({ clients: [{ visibilityState: 'hidden' }], storedFlags: stored })
    await second.click({})
    check('legacy path taken after restart (open-topic, no openWindow)',
      second.calls.postMessages.some((p) => p.msg.type === 'open-topic' && p.clientId === 'c1') && second.calls.openWindow.length === 0)
  }

  // ── 9. Not-Interested never opens a window (unchanged) ──
  {
    console.log('\n[9] Not Interested tap — no window raised')
    const w = makeWorld({ clients: [{ visibilityState: 'hidden' }] })
    await w.click({ action: 'dislike' })
    check('no openWindow', w.calls.openWindow.length === 0)
    check('no open-topic', !w.calls.postMessages.some((p) => p.msg.type === 'open-topic'))
    check('dislike feedback fired', w.calls.fetched.some((u) => u.includes('/api/notification/feedback')))
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('harness crashed:', e)
  process.exit(1)
})
