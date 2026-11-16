#!/bin/bash
# session66: poll neutralwire.org until the session65 diet fingerprints go live.
# Fingerprints (all new in session65 build, verified locally before the push):
#   - POST /api/session  with Googlebot UA  -> 204 (old build: 200, wrote Firebase device records)
#   - POST /api/engagement with Googlebot UA -> 204 (old: 200)
#   - plain GET '/' (no query, no cookies)    -> served by ISR /home shell (x-vercel-cache HIT on repeat)
UA_BOT='Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
BASE='https://neutralwire.org'

bot_post() { # path -> status code
  curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE$1" -H "User-Agent: $UA_BOT" --max-time 20
}

LIVE=0
for i in $(seq 1 14); do
  s=$(bot_post /api/session)
  e=$(bot_post /api/engagement)
  ts=$(date -u +%H:%M:%S)
  echo "[$ts] try $i: bot POST session=$s engagement=$e"
  if [ "$s" = "204" ] && [ "$e" = "204" ]; then
    echo ">>> SESSION65 DIET IS LIVE (bot gates round 2 answering 204)"
    LIVE=1
    break
  fi
  sleep 30
done

if [ "$LIVE" = "0" ]; then
  echo ">>> fingerprints not seen yet after $i tries (build may still be running)"
fi

# Home ISR shell check: plain GET '/' twice; the ISR rewrite should let the
# Vercel edge serve the second one (x-vercel-cache: HIT) instead of a full
# dynamic SSR every time.
c1=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/" --max-time 20)
sleep 3
h2=$(curl -s -D - -o /dev/null "$BASE/" --max-time 20 | tr -d '\r' | grep -i '^x-vercel-cache:' | head -1)
echo "home '/' : first GET=$c1 ; second GET cache-header: ${h2:-<none>}"

# Basic health after deploy
f=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/flags" --max-time 20)
echo "health /api/flags -> $f"
