/**
 * PWA-standalone session: open an article mid-read and enumerate every
 * active overlay + try touch swipes from 3 screen regions.
 */
import { chromium, devices } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const iPhone = devices['iPhone 14'];
  const context = await browser.newContext({ ...iPhone, hasTouch: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message.slice(0, 160)));

  await page.goto('http://localhost:3100', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.evaluate(() => {
    localStorage.setItem('neutralwire:cookies-choice', JSON.stringify({ v: 'accepted' }));
    localStorage.setItem('neutralwire:pwa-installed-flag', 'true');
    localStorage.setItem('neutralwire:onboarded', 'true');
    localStorage.setItem('neutralwire:language-selected', 'true');
    localStorage.setItem('neutralwire:articles-opened', '3'); // low, no milestone
  });
  await page.goto('http://localhost:3100', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const h3 = page.locator('h3').first();
  await h3.click({ timeout: 10000 });
  await page.waitForTimeout(2000);

  const dlg = page.locator('.fixed.inset-0.z-50.overflow-y-auto').first();
  if (!(await dlg.count())) { console.log('no article dialog'); await browser.close(); return; }

  // enumerate active overlays (fixed, visible, pe != none, outside the dialog)
  const overlays = await page.evaluate(() => {
    const dialog = document.querySelector('.fixed.inset-0.z-50.overflow-y-auto');
    const out = [];
    document.querySelectorAll('body *').forEach(el => {
      if (dialog && dialog.contains(el)) return;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed') return;
      if (cs.pointerEvents === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) return;
      out.push(`${el.tagName}.${(typeof el.className === 'string' ? el.className : '').slice(0, 60)} | y:${Math.round(r.top)}-${Math.round(r.bottom)} x:${Math.round(r.left)}-${Math.round(r.right)} | z:${cs.zIndex} | "${(el.innerText || '').slice(0, 40).replace(/\n/g, ' ')}"`);
    });
    return out;
  });
  console.log('ACTIVE fixed overlays in PWA article view:', overlays.length);
  overlays.forEach(o => console.log('  ', o));

  const cdp = await context.newCDPSession(page);
  async function swipe(x, y1, y2, steps = 10) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y1, id: 1 }] });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y1 + (y2 - y1) * (i / steps), id: 1 }] });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  const before = await dlg.evaluate(el => el.scrollTop);
  await swipe(195, 300, 200); // top region
  await page.waitForTimeout(600);
  const mid = await dlg.evaluate(el => el.scrollTop);
  await swipe(195, 600, 500); // bottom region (where the thumb naturally is)
  await page.waitForTimeout(600);
  const after = await dlg.evaluate(el => el.scrollTop);
  console.log(`scroll: start=${before} afterTopSwipe=${mid} afterBottomSwipe=${after}`);
  console.log(mid > before + 10 ? 'TOP region scrolls ✅' : 'TOP region STUCK ❌');
  console.log(after > mid + 10 ? 'BOTTOM region scrolls ✅' : 'BOTTOM region STUCK ❌');

  await page.screenshot({ path: 'agent-ctx/pwa-article.png' });
  await browser.close();
})();
