/** ready() called ASAP → release must wait for the 1100ms minimum brand beat. */
import { chromium, devices } from 'playwright'
(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ ...devices['iPhone 14'], serviceWorkers: 'block' })
  const page = await context.newPage()
  await page.goto('http://localhost:3100', { waitUntil: 'commit', timeout: 45000 }).catch(() => {})
  // Call ready() as soon as the controller exists.
  const t0 = Date.now()
  for (let i = 0; i < 200; i++) {
    const done = await page.evaluate(() => {
      if (window.__NW_LAUNCH && typeof window.__NW_LAUNCH.ready === 'function') {
        window.__NW_LAUNCH.ready()
        return true
      }
      return false
    }).catch(() => false)
    if (done) break
    await page.waitForTimeout(20)
  }
  // Watch for the release class.
  for (let i = 0; i < 120; i++) {
    const rel = await page.evaluate(() => document.documentElement.classList.contains('nw-release')).catch(() => null)
    if (rel) { console.log(`RELEASED at +${Date.now() - t0}ms (min beat 1100 expected)`); break }
    await page.waitForTimeout(50)
  }
  await page.waitForTimeout(1000)
  const settled = await page.evaluate(() => document.documentElement.classList.contains('nw-settled')).catch(() => null)
  console.log('nw-settled after release:', settled)
  await browser.close()
})()
