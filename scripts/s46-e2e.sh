#!/bin/bash
# s46-e2e.sh — the full session46 verification battery in ONE bash
# invocation (the sandbox reaps the dev server between tool calls, so
# everything that needs a live server runs here).
set -u
cd /home/z/my-project
DB="https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app"

echo "── 1 · start dev server ──"
pkill -f "next dev" 2>/dev/null; sleep 1
setsid nohup npx next dev -p 3000 > scripts/dev46.log 2>&1 < /dev/null &
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ --max-time 5 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "server: HTTP $code after ~$((i*2))s"

echo "── 2 · subtopic creation E2E (no AI keys → fallback chain) ──"
curl -s -X PUT -H "Content-Type: application/json" -d '"premium"' "$DB/devices/d_s46e2e/tier.json" > /dev/null
# warm the route (first hit compiles)
curl -s -o /dev/null -X POST "http://localhost:3000/api/subtopics/create" \
  -H "Content-Type: application/json" -d '{}' --max-time 60
RESULT=$(curl -s -X POST "http://localhost:3000/api/subtopics/create?deviceId=d_s46e2e" \
  -H "Content-Type: application/json" -d '{"name":"Heathrow Airport expansion"}' --max-time 90)
echo "$RESULT" | head -c 500; echo
TOPICS=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('topics', 0))" 2>/dev/null)
echo "creation topics: $TOPICS"
for p in customSubtopics/heathrow-airport-expansion customFeeds/heathrow-airport-expansion customSubscriptions/heathrow-airport-expansion devices/d_s46e2e; do
  curl -s -X DELETE "$DB/$p.json" > /dev/null
done
echo "test nodes cleaned"

echo "── 3 · /debug page renders (login gate) ──"
DBG=$(curl -s http://localhost:3000/debug --max-time 30)
echo "$DBG" | rg -o "Dashboard|password" | sort -u | head -4
curl -s -o /dev/null -w "/debug HTTP %{http_code}\n" http://localhost:3000/debug --max-time 15

echo "── 4 · mycountry GB client fetch (cached hybrid) ──"
curl -s "http://localhost:3000/api/news?category=mycountry&country=GB&limit=12&slim=1" --max-time 60 | python3 -c "
import json,sys
d = json.load(sys.stdin)
ts = d.get('topics') or []
print(f\"mycountry GB: {len(ts)} topics, sourceCount={d.get('sourceCount')}, cached={d.get('cached')}\")
for t in ts[:8]: print(f\"  [{t.get('coverage')}] {t.get('title','')[:75]}\")
" 2>&1 | head -12

echo "── 5 · /api/debug/apis auth gate ──"
curl -s -X POST http://localhost:3000/api/debug/apis -H "Content-Type: application/json" \
  -d '{"password":"nope"}' --max-time 15 | head -c 60; echo

echo "── 6 · browser screenshots ──"
agent-browser set viewport 412 900 2>/dev/null
agent-browser open "http://localhost:3000/debug" --timeout 30000 2>&1 | tail -1
agent-browser screenshot /home/z/my-project/download/verify/s46-debug-login.png --full 2>&1 | tail -1
agent-browser open "http://localhost:3000/?category=mycountry" --timeout 30000 2>&1 | tail -1
sleep 6
agent-browser screenshot /home/z/my-project/download/verify/s46-uk-feed.png --full 2>&1 | tail -1
agent-browser close 2>/dev/null

echo "── 7 · [Test] grid digest send (the new layout, real inbox) ──"
npx tsx scripts/s46-send-grid-test.ts 2>&1 | rg -v "^\[ai" | head -8

echo "── done ──"
pkill -f "next dev" 2>/dev/null
exit 0
