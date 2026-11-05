#!/bin/bash
# Simulate a visitor opening articles: POST /api/summary for missing topics
# every ~8s and record whether the LLM ever succeeds.
TOPICS=("axlcykp" "a1fr5qam" "a11vlbcw" "a1km0zct" "a121ojni" "adbw1qh" "a5lf239" "at7qvly" "a1dxhqkr" "ag0e2xp" "ap0k9tw" "a1d0hn80" "a1b7r67e" "afhhk3i" "aj2ttxp" "adco8mt" "a133raj3" "a33y3l5" "aeliukv" "a1ruysfo")
for t in "${TOPICS[@]}"; do
  out=$(curl -s --max-time 25 -X POST "https://neutralwire.org/api/summary" \
    -H 'Content-Type: application/json' \
    -d "{\"topicId\":\"$t\",\"title\":\"t\",\"articles\":[]}")
  src=$(echo "$out" | python3 -c "import json,sys
try:
    d=json.load(sys.stdin)
    s=d.get('summary','')
    print(d.get('source','?'), '|', len(s), 'chars |', (s[:70] if s else '').replace(chr(10),' '))
except Exception as e:
    print('PARSE-ERR', e)")
  echo "$(date -u +%H:%M:%S) $t -> $src"
  sleep 8
done
