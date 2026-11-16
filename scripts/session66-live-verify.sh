#!/bin/bash
# session66: airtight live fingerprints for the session65 deploy on neutralwire.org
UA_BOT='Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
UA_USER='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
BASE='https://neutralwire.org'

echo "== 1. bot POST /api/session — expect 204 + x-nw-bot-gate header =="
curl -si -X POST "$BASE/api/session" -H "User-Agent: $UA_BOT" --max-time 20 | tr -d '\r' | grep -iE '^(HTTP/|x-nw-bot-gate)' | head -4

echo "== 2. bot POST /api/summary — expect 422 + 'bot requests never generate' =="
curl -si -X POST "$BASE/api/summary" -H "User-Agent: $UA_BOT" -H 'Content-Type: application/json' -d '{"topicId":"probe"}' --max-time 20 | tr -d '\r' | grep -iE '^(HTTP/|x-nw-bot-gate)' | head -4
curl -s -X POST "$BASE/api/summary" -H "User-Agent: $UA_BOT" -H 'Content-Type: application/json' -d '{"topicId":"probe"}' --max-time 20 | head -c 300; echo

echo "== 3. control: real-user (iPhone) POST /api/session — expect 200 =="
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/session" -H "User-Agent: $UA_USER" --max-time 20

echo "== 4. bot GET /api/refresh — session64 gate still in place (204) =="
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/refresh" -H "User-Agent: $UA_BOT" --max-time 20

echo "== 5. meter day report (post-deploy) =="
curl -s "$BASE/api/debug/usage?days=1" --max-time 30 | python3 -c "
import json,sys
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception:
    print('meter response not JSON:', raw[:200]); sys.exit(0)
t = d.get('totals', {})
print('generatedAt:', d.get('generatedAt'))
print('totals: requests=%s cpuMs=%s cpuHours=%s bySource=%s' % (t.get('requests'), t.get('cpuMs'), t.get('cpuHours'), json.dumps(t.get('bySource',{}))))
routes = d.get('days', {}).get(d.get('generatedAt','')[:10], {})
# fall back to whatever day keys exist
for day, blob in d.get('days', {}).items():
    print('day', day)
    for r in sorted(blob.get('routes', []), key=lambda r: -r.get('cpuMs',0))[:8]:
        print('  %-28s n=%-5s cpuMs=%-8s botHits=%s' % (r['route'], r['count'], r.get('cpuMs','-'), r.get('bySource',{}).get('bot',{}).get('count','-')))
    for p in blob.get('pages', {}).get('counts', [])[:0] if isinstance(blob.get('pages'), dict) else []:
        pass
"
