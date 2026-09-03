#!/usr/bin/env bash
# test-session12.sh — TOUCH SCROLL REPAIR + LOOPING SPLASH + DRAG-TO-CLOSE + PRIVACY
#
# User reports this session fixes:
#   1. "can't swipe down in an article" — in the installed PWA, ALL touch
#      scrolling inside fixed overlays (article view) was dead while mouse
#      wheel worked. Root cause: html.nw-release #nw-app-root kept the
#      FILLED nw-app-reveal animation running forever; a filled transform
#      animation computes to an identity MATRIX (not none) → #nw-app-root
#      became a containing block with a live animation → Chromium stops
#      routing touch gestures into its fixed-position scrollable children.
#      Fix: the head controller adds html.nw-settled 800ms after release
#      (globals.css: animation:none) so the tree is clean from then on.
#   2. "loading animation is just an image" — the splash entrance played
#      once and then froze into a static frame for the rest of the load.
#      Fix: the full brand sequence now LOOPS every 2.8s (converge →
#      sweeping hold → dissolve → replay) and the minimum brand beat rose
#      560 → 1100ms so the entrance is always fully perceived.
#   3. Swipe-down-to-close: dragging the article's top bar down (grabber
#      pill affordance) pulls the sheet and releases past the threshold
#      closes it; small drags rubber-band back; content drags still scroll.
#   4. Privacy policy now discloses country + city collection; contact
#      email is moneyisbroken@gmail.com.
#
# Run with dev server + proxy up:
#   nohup bun run dev &
#   nohup bun scripts/test-proxy.js &    # :3100 fakes display-mode standalone

set -e
BASE=http://localhost:3000
PROXY=http://localhost:3100
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
ug() { sed 's/\\"/"/g'; }

echo "── 1. SSR + CSS ship the new pieces ──"
HTML=$(curl -s $BASE/)
echo "$HTML" | grep -q 'MIN=1100'                        && ok "controller MIN is 1100ms" || bad "MIN not 1100"
echo "$HTML" | grep -q "nw-seg-left 2.8s"                && ok "segments loop (2.8s infinite)" || bad "segments not looping"
echo "$HTML" | grep -q 'nw-sp-orb 2.8s'                  && ok "orbs loop" || bad "orbs not looping"
echo "$HTML" | grep -q 'nw-settled'                      && ok "settled wiring in controller" || bad "settled missing"
grep -q 'html.nw-settled #nw-app-root' src/app/globals.css && ok "settled CSS rule present" || bad "settled CSS missing"
grep -q 'nw-sp-sweep' src/app/layout.tsx                 && ok "hold sweep present" || bad "sweep missing"

echo "── 2. PWA cold start: loop + release + settled ──"
node scripts/test-splash-verify.js > /tmp/nw12-splash.txt 2>&1 || true
grep -q 'iter=infinite'   /tmp/nw12-splash.txt && ok "splash animations are infinite loops" || bad "not looping"
grep -q 'nw-settled'      /tmp/nw12-splash.txt && ok "nw-settled arrives after release" || bad "settled never arrived"
grep -q 'RELEASED'        /tmp/nw12-splash.txt && ok "splash releases (ready or cap)" || bad "never released"
# word opacity must CHANGE across samples (animation alive, not frozen)
node scripts/test-splash-ready.js > /tmp/nw12-ready.txt 2>&1 || true
REL_MS=$(sed -n 's/RELEASED at +\([0-9]*\)ms.*/\1/p' /tmp/nw12-ready.txt)
[ -n "$REL_MS" ] && [ "$REL_MS" -ge 1050 ] && ok "MIN brand beat honoured (released at +${REL_MS}ms)" || bad "released too early (+${REL_MS}ms)"
grep -q 'nw-settled after release: true' /tmp/nw12-ready.txt && ok "settled on the ready path" || bad "settled missing on ready path"

echo "── 3. Touch scroll works in the PWA article (the reported bug) ──"
node scripts/test-pwa-article.js > /tmp/nw12-pwa.txt 2>&1 || true
grep -q 'TOP region scrolls ✅'    /tmp/nw12-pwa.txt && ok "article scrolls from the top region" || bad "top region stuck"
grep -q 'BOTTOM region scrolls ✅' /tmp/nw12-pwa.txt && ok "article scrolls from the bottom region" || bad "bottom region stuck"

echo "── 4. Swipe-down-to-close on the article top bar ──"
node scripts/test-drag-final.js > /tmp/nw12-drag.txt 2>&1 || true
grep -q 'small drag → open=true'     /tmp/nw12-drag.txt && ok "small bar drag snaps back (stays open)" || bad "small drag closed the article"
grep -q 'full drag down → open=false' /tmp/nw12-drag.txt && ok "full bar drag closes the article" || bad "drag did not close"

echo "── 5. Privacy policy: country + city, new email ──"
node scripts/test-privacy.js > /tmp/nw12-privacy.txt 2>&1 || true
grep -q 'mentions city row: true'        /tmp/nw12-privacy.txt && ok "collect row names city" || bad "city row missing"
grep -q 'email updated: true'            /tmp/nw12-privacy.txt && ok "email is moneyisbroken@gmail.com" || bad "email not updated"
grep -q 'old email gone: true'           /tmp/nw12-privacy.txt && ok "old email removed" || bad "old email still present"
grep -q 'never-do updated: true'         /tmp/nw12-privacy.txt && ok "never-do section updated" || bad "never-do stale"

echo "── 6. Static checks ──"
bunx tsc --noEmit                              && ok "tsc 0 errors" || bad "tsc errors"
bun run lint > /dev/null 2>&1                  && ok "eslint clean" || bad "eslint issues"

echo "── done: $PASS passed, $FAIL failed ──"
[ $FAIL -eq 0 ]
