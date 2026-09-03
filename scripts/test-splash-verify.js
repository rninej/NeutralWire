/** Verify the looping splash + settled class + release timing on :3100 (PWA emulation). */
import { chromium, devices } from 'playwright'
(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ ...devices['iPhone 14'], serviceWorkers: 'block' })
  const page = await context.newPage()
  page.on('pageerror', e => console.log('[pageerror]', e.message.slice(0, 120)))
  const t0 = Date.now()
  await page.goto('http://localhost:3100', { waitUntil: 'commit', timeout: 45000 }).catch(() => {})
  const samples = []
  for (let i = 0; i < 34; i++) {
    const s = await page.evaluate(() => {
      const splash = document.getElementById('nw-splash')
      const word = splash && splash.querySelector('.nw-sp-word')
      const seg = splash && splash.querySelector('.nw-seg-b')
      const L = window.__NW_LAUNCH || {}
      return {
        v: document.documentElement.className,
        wop: word ? +(+getComputedStyle(word).opacity).toFixed(2) : null,
        segAnim: seg ? getComputedStyle(seg).animationIterationCount : null,
        rel: L.released ? L.reason : null,
      }
    }).catch(() => null)
    if (s) samples.push(`+${Date.now() - t0} wop=${s.wop} iter=${s.segAnim} cls="${s.v}" ${s.rel ? 'RELEASED(' + s.rel + ')' : ''}`)
    await page.waitForTimeout(150)
  }
  samples.forEach(s => console.log(s))
  await browser.close()
})()
