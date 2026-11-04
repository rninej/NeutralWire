#!/bin/bash
# test-session9.sh — verify dark OS-level launch screen:
#   1. manifest background_color + theme_color #0a0a0a (Android launch)
#   2. iOS apple-touch-startup-image set (26 links, files served)
#   3. Splash CSS now ALWAYS dark (matches OS launch in both color schemes)
#   4. status-bar-style black (both metadata + raw meta)
#   5. SW bumped to v22 (installed PWAs refresh precached manifest)
#   6. Splash gating regressions (browser/reload → still hidden)
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

step "2. Manifest: dark launch colors"
curl -s http://localhost:3000/manifest.json | grep -o '"background_color": "[^"]*"\|"theme_color": "[^"]*"'

step "3. SSR HTML: startup links, status bar, splash CSS"
HTML=$(curl -s http://localhost:3000)
echo "$HTML" | grep -c 'apple-touch-startup-image' | sed 's/^/startup-image links: /'
echo "$HTML" | grep -o 'content="black"' | head -1 | sed 's/^/status-bar-style black: /'
echo "$HTML" | grep -o 'status-bar-style" content="default"' | wc -l | sed 's/^/status-bar-style default (expect 0): /'
echo "$HTML" | grep -c 'nw-launch' | sed 's/^/launch-gate refs: /'
echo "$HTML" | grep -o '#nw-splash{[^}]*background:#[^;]*' | head -1 | sed 's/^/splash CSS bg: /'
echo "$HTML" | grep -c 'prefers-color-scheme' | sed 's/^/prefers-color-scheme in HTML (expect 0): /'

step "4. Startup images served (200 + png)"
for f in startup-640x1136 startup-1179x2556 startup-1290x2796 startup-2048x2732; do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/apple-launch/$f.png)
  type=$(curl -s -o /dev/null -w "%{content_type}" http://localhost:3000/apple-launch/$f.png)
  echo "$f.png → $code ($type)"
done

step "5. SW: cache bumped to v22"
curl -s http://localhost:3000/sw.js | grep -o "neutralwire-shell-v[0-9]*\|neutralwire-api-v[0-9]*\|neutralwire-img-v[0-9]*" | sort -u

step "6. Browser (website): splash still gated off"
agent-browser open http://localhost:3000
agent-browser wait 3000
agent-browser eval "(() => { localStorage.setItem('neutralwire:cookies-choice','accept'); const el = document.getElementById('nw-splash'); return JSON.stringify({gate: window.__NW_LAUNCH, splashDisplay: el ? getComputedStyle(el).display : 'MISSING', elExists: !!el}); })()"

step "7. PWA sim (light system): splash plays DARK"
agent-browser eval "document.documentElement.classList.add('nw-launch'); 'added'"
agent-browser wait 130
agent-browser eval "(() => { const el = document.getElementById('nw-splash'); const cs = getComputedStyle(el); const word = el.querySelector('.nw-sp-word'); const grey = el.querySelector('.nw-seg-g'); const tag = el.querySelector('.nw-sp-tag'); return JSON.stringify({mode: matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark', display: cs.display, bg: cs.backgroundColor, wordColor: getComputedStyle(word).color, greySeg: getComputedStyle(grey).backgroundColor, tagColor: getComputedStyle(tag).color}); })()"
agent-browser screenshot /home/z/my-project/download/session9-splash-light-mode-dark.png
agent-browser wait 900
agent-browser eval "document.documentElement.classList.remove('nw-launch'); 'removed'"

step "8. PWA sim (dark system): splash dark + retires"
agent-browser set media dark >/dev/null 2>&1
agent-browser reload >/dev/null 2>&1
agent-browser wait 2500 >/dev/null 2>&1
agent-browser eval "document.documentElement.classList.add('nw-launch'); 'added'"
agent-browser wait 130
agent-browser eval "(() => { const el = document.getElementById('nw-splash'); const cs = getComputedStyle(el); return JSON.stringify({mode: 'dark', display: cs.display, bg: cs.backgroundColor, outAnim: cs.animationName}); })()"
agent-browser wait 900
agent-browser eval "(() => { const el = document.getElementById('nw-splash'); const cs = getComputedStyle(el); const a = el.getAnimations({subtree:false})[0]; document.documentElement.classList.remove('nw-launch'); return JSON.stringify({retired: cs.opacity === '0' && cs.visibility === 'hidden', animState: a ? a.playState : 'none', animTime: a ? a.currentTime : -1, inlineStyle: el.getAttribute('style') || '(none)'}); })()"
agent-browser set media light >/dev/null 2>&1
agent-browser reload >/dev/null 2>&1
agent-browser wait 1500 >/dev/null 2>&1

step "9. Reload regression: no splash in browser"
agent-browser reload
agent-browser wait 1500
agent-browser eval "(() => { const el = document.getElementById('nw-splash'); return JSON.stringify({navType: (performance.getEntriesByType('navigation')[0]||{}).type, splashDisplay: el ? getComputedStyle(el).display : 'MISSING'}); })()"

step "10. Console + page errors"
agent-browser errors
agent-browser console | grep -iE "error|warn" | head -5 || echo "(no errors/warnings)"

echo ""
echo "════════ TEST CYCLE COMPLETE ════════"
