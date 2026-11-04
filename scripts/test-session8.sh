#!/bin/bash
# test-session8.sh — verify session 8 changes:
#   1. Splash: PWA-only (not on website) + fresh-open-only (not on
#      pull-to-refresh/reload/back-forward)
#   2. Account: bold segmented 4-tab bar that stands out
#   3. Feature Flags card: admin section REMOVED (admin uses /debug)
set -u
cd /home/z/my-project/neutralwire

step() { echo ""; echo "════════ $1 ════════"; }

step "1. Start dev server"
pkill -f "next dev" 2>/dev/null; sleep 1
nohup bun run dev > dev.log 2>&1 &
for i in $(seq 1 90); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3000 2>/dev/null)
  if [ "$code" = "200" ]; then echo "READY (after ~$((i*2))s)"; break; fi
  sleep 2
done

step "2. SSR HTML: splash markup + launch-gate script + gated CSS"
HTML=$(curl -s http://localhost:3000)
echo "$HTML" | grep -c 'id="nw-splash"' | sed 's/^/nw-splash markup count: /'
echo "$HTML" | grep -c '__NW_LAUNCH' | sed 's/^/launch-gate script count: /'
echo "$HTML" | grep -o 'nw-launch' | sort | uniq -c | sed 's/^/nw-launch mentions: /'

step "3. BROWSER MODE (website): gate says NO splash"
agent-browser open http://localhost:3000
agent-browser wait 1800
agent-browser eval "(() => { const el = document.getElementById('nw-splash'); const cs = el ? getComputedStyle(el) : null; return JSON.stringify({gate: window.__NW_LAUNCH || 'MISSING', htmlClass: document.documentElement.className, standaloneMQ: window.matchMedia('(display-mode: standalone)').matches, splashDisplay: cs ? cs.display : 'MISSING'}); })()"
agent-browser errors

step "4. Set consent (keep later screenshots clean) + check no splash painted"
agent-browser eval "localStorage.setItem('neutralwire:cookies-choice','accept'); 'ok'"

step "5. RELOAD (pull-to-refresh / F5 equivalent): still NO splash"
agent-browser reload
agent-browser wait 1500
agent-browser eval "(() => { const el = document.getElementById('nw-splash'); const cs = el ? getComputedStyle(el) : null; return JSON.stringify({gate: window.__NW_LAUNCH || 'MISSING', htmlHasLaunchClass: document.documentElement.classList.contains('nw-launch'), navTypeAfterReload: (performance.getEntriesByType('navigation')[0]||{}).type, splashDisplay: cs ? cs.display : 'MISSING'}); })()"
agent-browser errors

step "6. PWA simulation: html.nw-launch class → splash DISPLAYS + plays (CSS gate works)"
agent-browser eval "document.documentElement.classList.add('nw-launch'); 'added'"
agent-browser wait 130
agent-browser eval "(() => { const el = document.getElementById('nw-splash'); const cs = getComputedStyle(el); const word = el.querySelector('.nw-sp-word'); const segs = Array.from(el.querySelectorAll('.nw-seg')).map(s => getComputedStyle(s).backgroundColor); return JSON.stringify({display: cs.display, opacity: cs.opacity, outAnim: cs.animationName, wordAnim: word ? getComputedStyle(word).animationName : 'none', segColors: segs, retiredInlineStyle: el.getAttribute('style') || '(none)'}); })()"
agent-browser screenshot /home/z/my-project/download/session8-splash-pwa-mid.png
agent-browser wait 900
agent-browser eval "(() => { const el = document.getElementById('nw-splash'); const cs = getComputedStyle(el); document.documentElement.classList.remove('nw-launch'); return JSON.stringify({afterAnimOpacity: cs.opacity, afterAnimVisibility: cs.visibility}); })()"

step "7. Account: bold segmented tab bar"
agent-browser find role button click --name "Open account" || { agent-browser snapshot -i | head -25; }
agent-browser wait 1000
agent-browser eval "(() => { const tabs = Array.from(document.querySelectorAll('[role=tab]')); const active = document.querySelector('[role=tab][aria-selected=true]'); const pill = active ? active.querySelector('span.absolute') : null; const label = active ? active.querySelector('span.text-xs') : null; const pillCS = pill ? getComputedStyle(pill) : null; const labelCS = label ? getComputedStyle(label) : null; return JSON.stringify({tabCount: tabs.length, labels: tabs.map(t => t.textContent.trim()), activeTab: active ? active.textContent.trim() : 'none', pillExists: !!pill, pillBg: pillCS ? pillCS.backgroundColor : 'none', pillShadow: pillCS ? pillCS.boxShadow.split('rgba')[0].trim() : 'none', labelColor: labelCS ? labelCS.color : 'none', tabHeight: active ? active.getBoundingClientRect().height : 0}); })()"
agent-browser screenshot /home/z/my-project/download/session8-account-tabs.png

step "8. Switch tabs: pill follows"
agent-browser find role tab click --name "Feed"
agent-browser wait 700
agent-browser eval "(() => { const active = document.querySelector('[role=tab][aria-selected=true]'); const pill = active ? active.querySelector('span.absolute') : null; return JSON.stringify({activeTab: active ? active.textContent.trim() : 'none', pillInActiveTab: !!pill, pillBg: pill ? getComputedStyle(pill).backgroundColor : 'none'}); })()"

step "9. Feed tab: Feature Flags card — NO admin section, personal picker intact"
agent-browser eval "(() => { const t = document.body.innerText; return JSON.stringify({hasCard: t.includes('Feature Flags'), hasYourHeader: t.includes('Your header style'), designs: ['Big chips','Bold tabs','Icon tiles','Browse sheet','Bottom dock','Classic pills','Maxi pills','Header dock'].filter(n => t.includes(n)).length, adminSectionGone: !t.includes('Site-wide default (admin)'), noPasswordInput: !document.querySelector('input[type=password]'), noUnlockBtn: !t.includes('Unlock'), followRow: t.includes('Follow site default')}); })()"

step "10. Pick a design → cookie + instant announce (regression check)"
agent-browser find text "Icon tiles" click
agent-browser wait 500
agent-browser eval "(() => { const m = document.cookie.match(/(?:^|; )nw_nav=([^;]*)/); return JSON.stringify({cookie: m ? decodeURIComponent(m[1]) : 'none', feedback: document.body.innerText.includes('Saved for you')}); })()"

step "11. /debug still has the admin Feature Flags picker"
agent-browser press Escape
agent-browser wait 400
agent-browser open http://localhost:3000/debug
agent-browser wait 1800
agent-browser eval "(() => { const t = document.body.innerText; return JSON.stringify({debugLoads: t.length > 100, hasFlagSection: t.includes('Feature Flags'), adminPicker: t.includes('Big chips') && (t.includes('Site-wide') || t.includes('Applies to all users'))}); })()"
agent-browser screenshot /home/z/my-project/download/session8-debug-flags.png

step "12. MOBILE (iPhone 14): bold tab bar fits 390px, no overflow"
agent-browser open http://localhost:3000
agent-browser wait 1500
agent-browser set device "iPhone 14"
agent-browser find role button click --name "Open account"
agent-browser wait 1000
agent-browser eval "(() => { const active = document.querySelector('[role=tab][aria-selected=true]'); const pill = active ? active.querySelector('span.absolute') : null; return JSON.stringify({viewport: window.innerWidth, tabCount: document.querySelectorAll('[role=tab]').length, pillExists: !!pill, pillBg: pill ? getComputedStyle(pill).backgroundColor : 'none', horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2, tabHeight: active ? active.getBoundingClientRect().height : 0}); })()"
agent-browser screenshot /home/z/my-project/download/session8-account-tabs-mobile.png

step "13. Mobile: browser-mode splash still hidden"
agent-browser eval "(() => { const el = document.getElementById('nw-splash'); return JSON.stringify({gate: window.__NW_LAUNCH, splashDisplay: el ? getComputedStyle(el).display : 'MISSING'}); })()"

step "14. Console + page errors (FULL)"
agent-browser errors
agent-browser console | tail -12

step "15. Reset device emulation"
agent-browser set device "default" 2>/dev/null || agent-browser set viewport 1280 800

echo ""
echo "════════ TEST CYCLE COMPLETE ════════"
