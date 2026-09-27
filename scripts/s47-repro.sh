#!/bin/bash
# s47-repro.sh — reproduce the /debug API board crash in ONE invocation
# (the sandbox reaps background processes between tool calls).
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

echo "── 2 · open /debug, bypass gate, mock the board response ──"
agent-browser set viewport 1440 900 2>&1 | tail -1
agent-browser open http://localhost:3000/debug --timeout 30000 2>&1 | tail -1
agent-browser eval "sessionStorage.setItem('neutralwire:analytics-pw','mockpw'); 'set'" 2>&1 | tail -1

# Mock the board route with the realistic fixture BEFORE the reload triggers the fetch.
FIXTURE=$(cat scripts/s47-board-fixture.json | tr '\n' ' ')
agent-browser network route "**/api/debug/apis" --body "$FIXTURE" --header "Content-Type: application/json" 2>&1 | tail -1

agent-browser reload --timeout 30000 2>&1 | tail -1
agent-browser wait 4000 2>&1 | tail -1

echo "── 3 · state after mock-data render ──"
agent-browser eval "document.querySelector('#api-board') ? 'board card present' : 'NO board card'" 2>&1 | tail -1
agent-browser eval "(() => { const c = document.querySelector('#api-board'); if (!c) return 'no card'; const rows = c.querySelectorAll('.rounded-xl.border'); const chips = c.querySelectorAll('span.rounded-full.border'); return 'rows=' + rows.length + ' summaryChips~' + chips.length; })()" 2>&1 | tail -1
agent-browser screenshot download/verify/s47-repro-mocked.png --full 2>&1 | tail -1

echo "── 4 · page errors / console after 10+ seconds ──"
agent-browser wait 8000 2>&1 | tail -1
echo "PAGE ERRORS:"; agent-browser errors 2>&1 | head -20
echo "CONSOLE (errors):"; agent-browser console 2>&1 | rg -i "error|unhandled|crash|exception" | head -10
agent-browser screenshot download/verify/s47-repro-after10s.png --full 2>&1 | tail -1
agent-browser eval "document.body.innerText.slice(0, 200).replace(/\n/g, ' | ')" 2>&1 | tail -1

echo "── 5 · the hang case: kill the mock, let the real route run (GDELT 9s probe) ──"
agent-browser network unroute "**/api/debug/apis" 2>&1 | tail -1
echo "clicking Re-check with the REAL (unmocked) route, wrong password → 401 path:"
agent-browser find text "Re-check" click 2>&1 | tail -1
agent-browser wait 12000 2>&1 | tail -1
echo "PAGE ERRORS AFTER REAL ROUTE:"; agent-browser errors 2>&1 | head -20
agent-browser eval "document.body.innerText.slice(0, 200).replace(/\n/g, ' | ')" 2>&1 | tail -1
agent-browser screenshot download/verify/s47-repro-realroute.png --full 2>&1 | tail -1

echo "── 6 · REAL route with REAL timing: time the full authed fetch via curl (wrong pw = 401 fast; instead time the route directly) ──"
# Can't auth, but we CAN time how long the route takes to even REJECT: compiles included.
T0=$(date +%s%N)
curl -s -o /dev/null -X POST http://localhost:3000/api/debug/apis -H "Content-Type: application/json" -d '{"password":"nope"}' --max-time 60
T1=$(date +%s%N)
echo "401 path took $(( (T1-T0)/1000000 ))ms (includes route compile)"

agent-browser close 2>/dev/null
pkill -f "next dev" 2>/dev/null
echo "── done ──"
exit 0
