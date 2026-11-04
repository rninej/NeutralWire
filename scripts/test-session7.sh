#!/bin/bash
# test-session7.sh — verify session 7 changes:
#   1. New full-screen tri-color splash (replaces old one, ≤0.5s, pure CSS)
#   2. Cookie consent banner (first-time, BEFORE install prompt, 2 options)
#   3. Install prompt + onboarding gated on cookie choice
#   4. Account page tab redesign (Profile/Feed/Theme/Alerts, compact)
#   5. Privacy policy page
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

step "2. SSR HTML: new tri-color splash markup + keyframes"
HTML=$(curl -s http://localhost:3000)
echo "$HTML" | grep -c 'id="nw-splash"' | sed 's/^/nw-splash count: /'
echo "$HTML" | grep -o 'nw-seg-b\|nw-seg-g\|nw-seg-r\|nw-sp-word\|nw-sp-tag\|nw-sp-orb-b\|nw-sp-orb-r\|nw-seg-left\|nw-seg-right\|nw-seg-grow\|nw-sp-icon' | sort | uniq -c
echo "--- old splash icon gone? (expect 0) ---"
echo "$HTML" | grep -c 'nw-sp-icon' || true

step "3. Splash retired by pure CSS (~480ms), no inline style, no errors"
agent-browser open http://localhost:3000
agent-browser wait 1500
agent-browser eval "(() => { const el = document.getElementById('nw-splash'); if (!el) return 'MISSING'; const cs = getComputedStyle(el); const bar = el.querySelector('.nw-sp-bar'); const segs = bar ? bar.children.length : -1; return JSON.stringify({opacity: cs.opacity, visibility: cs.visibility, animationName: cs.animationName, inlineStyle: el.getAttribute('style') || '(none)', segments: segs, segColors: Array.from(el.querySelectorAll('.nw-seg')).map(s => getComputedStyle(s).backgroundColor)}); })()"
agent-browser errors

step "4. Catch the splash mid-animation (screenshot right after reload)"
agent-browser reload
agent-browser screenshot /home/z/my-project/download/session7-splash-mid.png 2>/dev/null || true
agent-browser wait 1200

step "5. Fresh first visit: cookie banner shows (2 options only), install prompt hidden"
agent-browser eval "localStorage.clear(); sessionStorage.clear(); 'cleared'"
agent-browser cookies clear
agent-browser open "http://localhost:3000/?fresh=1"
agent-browser wait 1500
agent-browser eval "(() => { const t = document.body.innerText; const banner = t.includes('A quick word on cookies'); const accept = t.includes('Accept all'); const reject = t.includes('Reject non-necessary'); const privacy = t.includes('Privacy policy'); const install = t.includes('Install NeutralWire'); const btns = Array.from(document.querySelectorAll('button')).filter(b => /accept all|reject non-necessary/i.test(b.textContent||'')).length; return JSON.stringify({banner, accept, reject, privacyLinkInBanner: privacy, installPromptVisible: install, consentButtonCount: btns}); })()"

step "6. Click 'Reject non-necessary' → banner gone, choice stored"
agent-browser find text "Reject non-necessary" click
agent-browser wait 600
agent-browser eval "(() => { const t = document.body.innerText; return JSON.stringify({bannerGone: !t.includes('A quick word on cookies'), choice: localStorage.getItem('neutralwire:cookies-choice')}); })()"
agent-browser screenshot /home/z/my-project/download/session7-cookie-reject.png

step "7. Reload after reject → banner never returns, no errors"
agent-browser open "http://localhost:3000/?after-reject=1"
agent-browser wait 1500
agent-browser eval "(() => { const t = document.body.innerText; return JSON.stringify({bannerStaysGone: !t.includes('A quick word on cookies')}); })()"
agent-browser errors

step "8. Account page: tab bar + Profile tab (compact)"
agent-browser find role button click --name "Open account" || { agent-browser snapshot -i | head -25; }
agent-browser wait 1000
agent-browser eval "(() => { const tabs = Array.from(document.querySelectorAll('[role=tab]')).map(b => b.textContent.trim()); const t = document.body.innerText; const page = document.querySelector('.fixed.inset-0.z-50'); return JSON.stringify({tabs, profileContent: t.includes('Signed in as') && t.includes('Refer others') && t.includes('Privacy policy'), hasInterests: t.includes('Personalize your feed'), hasFeatureFlags: t.includes('Feature Flags'), hasTheme: t.includes('Color scheme'), hasNotifs: t.includes('Notifications'), scrollHeight: page ? page.scrollHeight : 0}); })()"

step "9. Feed tab: interest chips + feature flags, admin section COLLAPSED"
agent-browser find role tab click --name "Feed"
agent-browser wait 600
agent-browser eval "(() => { const t = document.body.innerText; const chips = document.querySelectorAll('[aria-pressed]').length; return JSON.stringify({interestChips: chips, hasFeatureFlags: t.includes('Feature Flags'), hasYourHeader: t.includes('Your header style'), adminCollapsed: !document.querySelector('input[type=password]'), adminSummary: (t.match(/Site-wide default \(admin\)/) || ['missing'])[0], liveBadge: (t.match(/Live: [A-Za-z +]+/) || ['none'])[0]}); })()"

step "10. Toggle an interest chip"
agent-browser find text "Technology" click
agent-browser wait 500
agent-browser eval "(() => { const chip = Array.from(document.querySelectorAll('button')).find(b => (b.textContent||'').includes('Technology') && b.querySelector('[aria-pressed]') === null && b.getAttribute('aria-pressed') !== null); return chip ? JSON.stringify({pressed: chip.getAttribute('aria-pressed'), saved: localStorage.getItem('neutralwire:interests')}) : 'chip-not-found'; })()"

step "11. Theme tab: switcher + gradients + collapsed custom maker"
agent-browser find role tab click --name "Theme"
agent-browser wait 600
agent-browser eval "(() => { const t = document.body.innerText; return JSON.stringify({hasModeControl: t.includes('Light / dark mode') || document.querySelectorAll('[role=tab]').length > 0, hasFamilies: t.includes('Color scheme'), hasGradients: t.includes('Gradient backgrounds'), customMakerCollapsed: !t.includes('Color 1'), makerToggle: t.includes('Custom gradient maker')}); })()"
agent-browser find text "Custom gradient maker" click
agent-browser wait 600
agent-browser eval "(() => ({ makerOpen: document.body.innerText.includes('Color 1') ? 'YES' : 'NO' }))"

step "12. Alerts tab: notifications + support + privacy note"
agent-browser find role tab click --name "Alerts"
agent-browser wait 600
agent-browser eval "(() => { const t = document.body.innerText; return JSON.stringify({hasNotifs: t.includes('Notifications'), hasSupport: t.includes('Support NeutralWire'), hasKoFi: t.includes('Donate on Ko-fi'), hasFooter: t.includes('saved automatically to this device')}); })()"
agent-browser screenshot /home/z/my-project/download/session7-account-alerts.png

step "13. Tab persistence: close + reopen → lands on Alerts (sessionStorage)"
agent-browser press Escape
agent-browser wait 500
agent-browser find role button click --name "Open account"
agent-browser wait 800
agent-browser eval "(() => { const active = document.querySelector('[role=tab][aria-selected=true]'); return JSON.stringify({activeTab: active ? active.textContent.trim() : 'none'}); })()"

step "14. Feed tab height check (the 'no meter of scrolling' goal)"
agent-browser find role tab click --name "Feed"
agent-browser wait 500
agent-browser eval "(() => { const page = document.querySelector('.fixed.inset-0.z-50'); const tabpanel = document.querySelector('[role=tabpanel]'); return JSON.stringify({pageScrollHeight: page ? page.scrollHeight : 0, viewport: window.innerHeight, ratio: page ? +(page.scrollHeight / window.innerHeight).toFixed(2) : 0}); })()"
agent-browser press Escape
agent-browser wait 400

step "15. Privacy policy page"
agent-browser open "http://localhost:3000/privacy"
agent-browser wait 1500
agent-browser eval "(() => { const t = document.body.innerText; return JSON.stringify({title: t.includes('Privacy Policy'), shortVersion: t.includes('The short version'), sections: ['What NeutralWire collects','Where it is stored','Cookies & your choice','AI features','Third parties','What we never do','Deleting your data'].filter(s => t.includes(s)), backLink: !!document.querySelector('a[href=\"/\"]')}); })()"
agent-browser screenshot /home/z/my-project/download/session7-privacy.png

step "16. MOBILE (iPhone): cookies BEFORE install prompt, then install after Accept"
agent-browser set device "iPhone 14"
agent-browser eval "localStorage.clear(); sessionStorage.clear(); 'cleared'"
agent-browser cookies clear
agent-browser open "http://localhost:3000/?mobile=1"
agent-browser wait 4200
agent-browser eval "(() => { const t = document.body.innerText; return JSON.stringify({cookieBanner: t.includes('A quick word on cookies'), installModal: t.includes('Add to Home Screen') || t.includes('Install NeutralWire'), orderOK: t.includes('A quick word on cookies') && !(t.includes('Add to Home Screen') || t.includes('Install NeutralWire'))}); })()"
agent-browser screenshot /home/z/my-project/download/session7-mobile-cookies-first.png
agent-browser find text "Accept all" click
agent-browser wait 3000
agent-browser eval "(() => { const t = document.body.innerText; return JSON.stringify({cookieBannerGone: !t.includes('A quick word on cookies'), installModalNow: t.includes('Install NeutralWire') || t.includes('Add to Home Screen')}); })()"
agent-browser screenshot /home/z/my-project/download/session7-mobile-install-after.png

step "17. Mobile: account tabs at 390px"
agent-browser find role button click --name "Open account"
agent-browser wait 1000
agent-browser eval "(() => { const tabs = document.querySelectorAll('[role=tab]'); const overflow = document.documentElement.scrollWidth > window.innerWidth + 2; return JSON.stringify({tabCount: tabs.length, horizontalOverflow: overflow, viewport: window.innerWidth}); })()"
agent-browser screenshot /home/z/my-project/download/session7-mobile-account.png

step "18. Console + page errors (FULL)"
agent-browser errors
agent-browser console | tail -15

step "19. Reset device emulation"
agent-browser set device "default" 2>/dev/null || agent-browser set viewport 1280 800

echo ""
echo "════════ TEST CYCLE COMPLETE ════════"
