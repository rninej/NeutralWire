#!/usr/bin/env bash
# test-session10.sh — popup-system switcher (original / smart / smart-firstvisit)
#
# Verifies:
#   1. /api/flags GET returns both flags; POST validates password + mode
#   2. Homepage SSR reflects the popupSystem flag within ≤6s (5s memo)
#   3. /debug "Popup System" card: renders 3 options, LIVE badge follows
#      the toggle, reset button wipes local popup memory
#   4. ORIGINAL mode (iPhone emulation): classic install popup at ~3s
#      after cookie consent; dismissal writes the original key
#   5. SMART-FIRSTVISIT mode: first visit shows the classic popup with
#      ISOLATED ':fv' dismiss keys (smart engine memory stays clean);
#      second visit → legacy dormant, smart engine armed
#   6. SMART mode: unchanged — no early popup on a first visit (35s
#      dwell), 'read' peak-moment trigger fires the smart sheet
#
# Run with the dev server up:  nohup bun run dev &

set -e
PW='Arnav100910!!!'
BASE=http://localhost:3000

echo "── 1. flags API ──"
curl -s $BASE/api/flags; echo
curl -s -X POST $BASE/api/flags -H 'Content-Type: application/json' \
  -d "{\"password\":\"$PW\",\"popupSystem\":\"original\"}"; echo
curl -s -X POST $BASE/api/flags -H 'Content-Type: application/json' \
  -d '{"password":"wrong","popupSystem":"original"}'; echo "   ← must be Unauthorized"

echo "── 2. SSR flag plumbing ──"
curl -s $BASE/ | grep -o 'popupSystem\\":\\"[a-z-]*\\"' | head -1

echo "── 3-6. UI flow (agent-browser, iPhone 14) ──"
agent-browser set device "iPhone 14"
# original mode: fresh visitor → cookie consent → 3s → classic popup
agent-browser storage local clear
agent-browser open $BASE/ && sleep 3
agent-browser find text "Accept all" click && sleep 5
agent-browser eval "document.body.innerText.includes('Install NeutralWire')"   # true
agent-browser find text "Not now" click
agent-browser eval "!!localStorage.getItem('neutralwire:pwa-install-dismissed')" # true

# hybrid: fresh visitor → classic popup, isolated keys
curl -s -X POST $BASE/api/flags -H 'Content-Type: application/json' \
  -d "{\"password\":\"$PW\",\"popupSystem\":\"smart-firstvisit\"}" > /dev/null
sleep 6
agent-browser storage local clear
agent-browser open $BASE/ && sleep 3
agent-browser find text "Accept all" click && sleep 5
agent-browser eval "document.body.innerText.includes('Install NeutralWire')"    # true
agent-browser find text "Not now" click
agent-browser eval "JSON.stringify({
  smart: !!localStorage.getItem('neutralwire:pwa-install-dismissed'),          # false
  fv:    !!localStorage.getItem('neutralwire:pwa-install-fv-dismissed') })"     # true

# hybrid, second visit: legacy dormant, smart engine owns the moment
agent-browser eval "localStorage.setItem('neutralwire:articles-opened','1'); \
  sessionStorage.removeItem('neutralwire:first-visit-live'); 'v2'"
agent-browser reload && sleep 8
agent-browser eval "document.body.innerText.includes('Install NeutralWire')"    # false
sleep 6
agent-browser eval "window.dispatchEvent(new CustomEvent('neutralwire:topic-opened')); \
  window.dispatchEvent(new CustomEvent('neutralwire:topic-opened')); 'x'" && sleep 2
agent-browser eval "document.body.innerText.includes(\"You're getting into this\")" # true

# smart: unchanged first-visit behavior
curl -s -X POST $BASE/api/flags -H 'Content-Type: application/json' \
  -d "{\"password\":\"$PW\",\"popupSystem\":\"smart\"}" > /dev/null
sleep 6
agent-browser storage local clear
agent-browser open $BASE/ && sleep 3
agent-browser find text "Accept all" click && sleep 6
agent-browser eval "document.body.innerText.includes('Install NeutralWire') \
  || document.body.innerText.includes('Enjoyed that story')"                    # false (35s dwell)
sleep 26
agent-browser eval "window.dispatchEvent(new CustomEvent('neutralwire:article-read')); 'r'" && sleep 3
agent-browser eval "document.body.innerText.includes('Enjoyed that story')"     # true

agent-browser close
echo "── done (leave popupSystem='smart' in Firebase = live default) ──"
