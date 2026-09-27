import { chromium, devices } from 'playwright'
(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ ...devices['iPhone 14'], hasTouch: true, serviceWorkers: 'block' })
  const page = await context.newPage()
  page.on('console', m => { const t = m.text(); if (/^(NWDRAG)/.test(t)) console.log('[page]', t.slice(0, 80)) })
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {})
  await page.waitForTimeout(2500)
  for (const label of ['Accept all']) {
    const btn = page.getByRole('button', { name: label })
    if (await btn.count()) await btn.first().click().catch(() => {})
  }
  await page.waitForTimeout(600)
  const dlgSel = '.fixed.inset-0.z-50.overflow-y-auto'
  const h3 = page.locator('h3').first()
  await h3.waitFor({ timeout: 15000 })
  await h3.scrollIntoViewIfNeeded().catch(() => {})
  await page.evaluate(() => window.scrollBy(0, 140))
  await page.waitForTimeout(400)
  let opened = false
  for (let attempt = 0; attempt < 3 && !opened; attempt++) {
    await h3.click({ timeout: 8000 }).catch(async e => {
      console.log('normal click blocked, trying coordinates:', String(e).slice(0, 60))
      const box = await h3.boundingBox().catch(() => null)
      if (box) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2).catch(() => {})
    })
    await page.waitForTimeout(1500)
    opened = (await page.locator(dlgSel).count()) > 0
    if (!opened) { await page.evaluate(() => window.scrollBy(0, 200)); await page.waitForTimeout(300) }
  }
  if (!opened) { console.log('small drag → open=CLICK-FAILED'); console.log('full drag down → open=CLICK-FAILED'); await browser.close(); return }

  // where exactly is safe space on the bar?
  const boxes = await page.evaluate(() => {
    const root = document.querySelector('.fixed.inset-0.z-50.overflow-y-auto')
    const bar = root.querySelector('.glass')
    const btns = Array.from(bar.querySelectorAll('button')).map(b => { const r = b.getBoundingClientRect(); return `${(b.getAttribute('aria-label')||b.textContent||'').slice(0,18)} x:${Math.round(r.left)}-${Math.round(r.right)}` })
    return { bar: Math.round(bar.getBoundingClientRect().width), btns }
  })
  console.log('bar layout:', JSON.stringify(boxes))

  const cdp = await context.newCDPSession(page)
  async function touchDrag(x, y1, y2, steps = 12) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y1, id: 1 }] })
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y1 + (y2 - y1) * (i / steps), id: 1 }] })
      await page.waitForTimeout(28)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }

  // 1) small drag from empty bar space → snap back, stay open
  await touchDrag(120, 28, 68)
  await page.waitForTimeout(800)
  const open1 = (await page.locator(dlgSel).count()) > 0
  console.log(`small drag → open=${open1} (expect true)`)

  // 2) full drag from empty bar space → close
  await touchDrag(120, 28, 460, 16)
  await page.waitForTimeout(1000)
  const open2 = (await page.locator(dlgSel).count()) > 0
  console.log(`full drag down → open=${open2} (expect false = CLOSED)`)
  await page.screenshot({ path: 'agent-ctx/drag-touch-close.png' })
  await browser.close()
})()
