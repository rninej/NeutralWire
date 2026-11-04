#!/bin/bash
# s47-verify.sh — verify the board crash fix + the digest email logo, in ONE
# invocation (dev server + browser + tsx all in the same shell session).
set -u
cd /home/z/my-project

echo "── 1 · start dev server ──"
pkill -f "next dev" 2>/dev/null; sleep 1
setsid nohup npx next dev -p 3000 > scripts/dev47.log 2>&1 < /dev/null &
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/debug --max-time 5 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "server: HTTP $code after ~$((i*2))s"

echo "── 2 · THE CRASH CASE: board data WITH limitReached>0 (mocked) ──"
agent-browser set viewport 1440 900 2>&1 | tail -1
agent-browser open http://localhost:3000/debug --timeout 30000 2>&1 | tail -1
agent-browser eval "sessionStorage.setItem('neutralwire:analytics-pw','mockpw'); 'set'" 2>&1 | tail -1
FIXTURE=$(cat scripts/s47-board-fixture.json | tr '\n' ' ')
agent-browser network route "**/api/debug/apis" --body "$FIXTURE" --header "Content-Type: application/json" 2>&1 | tail -1
agent-browser reload --timeout 30000 2>&1 | tail -1
agent-browser wait 4000 2>&1 | tail -1
echo "board card + row count:"
agent-browser eval "(() => { const c = document.querySelector('#api-board'); if (!c) return 'NO CARD'; const rows = c.querySelectorAll('.rounded-xl.border'); const tiles = Array.from(c.querySelectorAll('span.rounded-full.border')).map(s => s.textContent.trim()).slice(0, 8); return 'rows=' + rows.length + ' | tiles: ' + tiles.join(' / '); })()" 2>&1 | tail -1
echo "page body after render (first 120 chars):"
agent-browser eval "document.body.innerText.slice(0, 120).replace(/\n/g, ' | ')" 2>&1 | tail -1
agent-browser wait 8000 2>&1 | tail -1
echo "PAGE ERRORS after 12s total (the crash window):"
agent-browser errors 2>&1 | head -10
agent-browser screenshot download/verify/s47-board-fixed.png --full 2>&1 | tail -1

echo "── 3 · the failure path: unmocked route + wrong pw → 401 → friendly error, page alive ──"
agent-browser network unroute "**/api/debug/apis" 2>&1 | tail -1
agent-browser eval "sessionStorage.clear(); 'cleared'" 2>&1 | tail -1
agent-browser reload --timeout 30000 2>&1 | tail -1
agent-browser wait 1500 2>&1 | tail -1
agent-browser eval "sessionStorage.setItem('neutralwire:analytics-pw','mockpw'); 'set'" 2>&1 | tail -1
agent-browser reload --timeout 30000 2>&1 | tail -1
agent-browser wait 3000 2>&1 | tail -1
echo "board error text:"
agent-browser eval "(() => { const c = document.querySelector('#api-board'); if (!c) return 'NO CARD'; const e = c.querySelector('p.text-red-500'); return e ? e.textContent.trim() : 'no error shown'; })()" 2>&1 | tail -1
echo "page still alive (not the Something-went-wrong screen)?"
agent-browser eval "document.body.innerText.includes('Something went wrong') ? 'CRASHED' : 'ALIVE — gate/board render fine'" 2>&1 | tail -1
agent-browser errors 2>&1 | head -6
agent-browser close 2>/dev/null

echo "── 4 · render the digest email with the new logo ──"
npx tsx scripts/s46-render-digest.ts 2>&1 | rg -v "^\[ai" | head -5
agent-browser set viewport 900 1100 2>&1 | tail -1
agent-browser open "file:///home/z/my-project/download/verify/s46-digest-grid.html" --timeout 20000 2>&1 | tail -1
agent-browser wait 2500 2>&1 | tail -1
agent-browser screenshot download/verify/s47-email-logo-desktop.png 2>&1 | tail -1
agent-browser eval "(() => { const img = document.querySelector('img'); return img ? 'logo img: ' + img.src + ' ' + img.width + 'x' + img.height : 'NO IMG'; })()" 2>&1 | tail -1
agent-browser set viewport 412 900 2>&1 | tail -1
agent-browser reload 2>&1 | tail -1
agent-browser wait 2000 2>&1 | tail -1
agent-browser screenshot download/verify/s47-email-logo-mobile.png 2>&1 | tail -1
agent-browser close 2>/dev/null

echo "── done ──"
pkill -f "next dev" 2>/dev/null
exit 0
