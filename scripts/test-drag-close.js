/** Verify swipe-down-to-close: drag from the article top bar closes it; content drags scroll. */
import { chromium, devices } from 'playwright'
(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ ...devices['iPhone 14'], hasTouch: true, serviceWorkers: 'block' })
  const page = await context.newPage()
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {})
  await page.waitForTimeout(2500)
  for (const label of ['Accept all']) {
    const btn = page.getByRole('button', { name: label })
    if (await btn.count()) await btn.first().click().catch(() => {})
  }
  await page.waitForTimeout(600)
  await page.locator('h3').first().click();
  await page.waitForTimeout(1500)
  const dlgSel = '.fixed.inset-0.z-50.overflow-y-auto'
  if (!(await page.locator(dlgSel).count())) { console.log('no dialog'); await browser.close(); return }

  const cdp = await context.newCDPSession(page)
  async function touchDrag(x, y1, y2, steps = 10) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y1, id: 1 }] })
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y1 + (y2 - y1) * (i / steps), id: 1 }] })
      await page.waitForTimeout(24)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }

  // 1) Small bar drag → snaps back, article stays open
  await touchDrag(195, 30, 70)
  await page.waitForTimeout(700)
  const stillOpen = (await page.locator(dlgSel).count()) > 0
  const yBack = await page.locator(dlgSel).evaluate(el => getComputedStyle(el).transform)
  console.log(`small bar drag: still open=${stillOpen} transform=${yBack}`)

  // 2) Content drag (from y=500) → scrolls, does NOT close
  const scrollBefore = await page.locator(dlgSel).evaluate(el => el.scrollTop)
  await touchDrag(195, 500, 300)
  await page.waitForTimeout(700)
  const scrollAfter = await page.locator(dlgSel).evaluate(el => el.scrollTop)
  const openAfterContent = (await page.locator(dlgSel).count()) > 0
  console.log(`content drag: scroll ${scrollBefore}→${scrollAfter} open=${openAfterContent}`)

  // 3) Full bar drag down → CLOSES the article
  await touchDrag(195, 30, 420, 14)
  await page.waitForTimeout(900)
  const openAfterDrag = (await page.locator(dlgSel).count()) > 0
  console.log(`full bar drag down: article closed=${!openAfterDrag}`)
  if (!openAfterDrag) {
    const feedBack = await page.evaluate(() => !!document.querySelector('h2') && document.body.innerText.includes('Headlines'))
    console.log('feed visible behind:', feedBack)
  }
  await page.screenshot({ path: 'agent-ctx/drag-close-result.png' })
  await browser.close()
})()
