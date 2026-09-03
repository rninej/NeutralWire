#!/usr/bin/env bash
# test-session11.sh — ADAPTIVE PWA LAUNCH SPLASH
#
# The splash used to retire itself at a FIXED ~480ms (pure CSS timer),
# so a cold-started PWA went:  NW splash → skeleton loader (~1s) → feed.
# Now the splash HOLDS (soft light sweeping the bias bar) until the first
# feed content is rendered, then cross-fades into the fully loaded page.
#
# System under test (src/app/layout.tsx + src/app/page-client.tsx +
# src/app/globals.css):
#   gate script   html.nw-launch   — standalone + fresh navigate only
#   controller    __NW_LAUNCH.ready() — MIN 1100ms brand beat (full looping
#                 entrance always visible), MAX 2600ms cap; adds nw-settled
#                 800ms after release (clears the filled reveal animation
#                 that otherwise breaks touch scroll in fixed overlays)
#   handoff       page-client calls ready() when !loading || error
#   release       html.nw-release  — splash fades out, app fades in
#                 (globals.css: html.nw-release #nw-app-root → nw-app-reveal)
#   safety net    page-client force-adds nw-release after 5s (+ settled)
#
# Verified here:
#   1. SSR HTML ships the gate (with `playing`), the controller, the
#      nw-release CSS rule and the bar sweep keyframes; #nw-app-root exists
#   2. Cold start via the standalone-emulating proxy (:3100): splash holds
#      while the feed loads, then releases with reason 'ready' — and at
#      release time the skeleton is ALREADY gone (content behind the splash)
#   3. After release: splash visibility:hidden / opacity:0 (retired
#      forever), #nw-app-root animation is nw-app-reveal, real feed text
#   4. Cap path (app JS never loads): replaying the exact controller source
#      without calling ready() holds at 1.3s and releases at ~2.6s with
#      reason 'timeout'
#   5. Reload does NOT replay the splash (navType 'reload' → playing:false)
#   6. A normal browser tab (:3000) never sees the splash
#   7. tsc --noEmit = 0 errors; eslint clean
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
# agent-browser eval returns JSON with backslash-escaped quotes — unescape
# before grepping (R=$(...) already wrapped in echo, so strip \" here).
ug() { sed 's/\\"/"/g'; }

echo "── 1. SSR HTML ships the adaptive-splash pieces ──"
HTML=$(curl -s $BASE/)
echo "$HTML" | grep -q 'playing=standalone'            && ok "gate exposes playing" || bad "gate playing missing"
echo "$HTML" | grep -q 'L.ready'                       && ok "controller script present" || bad "controller missing"
echo "$HTML" | grep -q 'html.nw-release #nw-splash'    && ok "release fade rule present" || bad "release rule missing"
echo "$HTML" | grep -q 'nw-sp-sweep'                   && ok "hold sweep keyframes present" || bad "sweep missing"
echo "$HTML" | grep -q 'id="nw-app-root"'              && ok "#nw-app-root present" || bad "#nw-app-root missing"
grep -q 'html.nw-release #nw-app-root' src/app/globals.css && ok "reveal rule in globals.css" || bad "reveal rule missing"

echo "── 2. Cold start (standalone emulation, fresh navigate) ──"
agent-browser set device "iPhone 14"
agent-browser open $PROXY/
agent-browser wait --fn "window.__NW_LAUNCH && window.__NW_LAUNCH.released === true" --timeout 20000
R=$(agent-browser eval "JSON.stringify({
  reason: window.__NW_LAUNCH.reason,
  releaseClass: document.documentElement.classList.contains('nw-release'),
  skeletonGone: !document.querySelector('[role=status]'),
  revealAnim: getComputedStyle(document.getElementById('nw-app-root')).animationName,
  feedText: (document.querySelector('#nw-app-root main') || document.querySelector('#nw-app-root')).innerText.slice(0, 80)
})")
echo "  $R"
echo "$R" | ug | grep -q '"reason":"ready"'          && ok "released on app ready signal" || bad "reason != ready"
echo "$R" | ug | grep -q '"skeletonGone":true'       && ok "skeleton never visible at handoff" || bad "skeleton leaked"
echo "$R" | ug | grep -q 'nw-app-reveal'             && ok "app reveal animation running" || bad "reveal not running"

echo "── 3. Splash retired + real content behind it ──"
R2=$(agent-browser eval "JSON.stringify({
  vis: getComputedStyle(document.getElementById('nw-splash')).visibility,
  op:  getComputedStyle(document.getElementById('nw-splash')).opacity,
  text: (document.querySelector('#nw-app-root main') || document.querySelector('#nw-app-root')).innerText.slice(0, 60)
})")
echo "  $R2"
echo "$R2" | ug | grep -q '"vis":"hidden"'           && ok "splash retired (visibility hidden)" || bad "splash not retired"
echo "$R2" | ug | grep -q '"op":"0"'                 && ok "splash fully faded" || bad "splash not faded"
echo "$R2" | ug | grep -qv '"text":""'               && ok "feed has real content" || bad "feed empty"

echo "── 4. Cap path: controller replays verbatim, ready() never called ──"
agent-browser eval "document.documentElement.classList.remove('nw-release','nw-settled'); window.__NW_LAUNCH={playing:true,standalone:true,navType:'navigate'}; (function(){try{var L=window.__NW_LAUNCH;if(!L||!L.playing)return;var MIN=1100,MAX=2600,t0=performance.now(),released=false,ready=false;function release(){if(released)return;released=true;try{L.released=true;L.reason=ready?'ready':'timeout';document.documentElement.classList.add('nw-release');setTimeout(function(){try{document.documentElement.classList.add('nw-settled')}catch(e){}},800)}catch(e){}}function afterPaint(fn){try{requestAnimationFrame(function(){requestAnimationFrame(fn)})}catch(e){fn()}}function schedule(){if(released)return;var w=MIN-(performance.now()-t0);if(w>0)setTimeout(function(){afterPaint(release)},w);else afterPaint(release)}L.ready=function(){if(ready||released)return;ready=true;schedule()};setTimeout(function(){if(!released)release()},MAX)}catch(e){}})(); 'armed'"
sleep 1.3
H=$(agent-browser eval "JSON.stringify({r: !!window.__NW_LAUNCH.released, c: document.documentElement.classList.contains('nw-release')})")
echo "  $H"
echo "$H" | ug | grep -q '"r":false'                 && ok "holds past 1.3s (no fixed 480ms retire)" || bad "retired too early"
sleep 2.2
C=$(agent-browser eval "JSON.stringify({r: window.__NW_LAUNCH.released, reason: window.__NW_LAUNCH.reason, c: document.documentElement.classList.contains('nw-release')})")
echo "  $C"
echo "$C" | ug | grep -q '"reason":"timeout"'        && ok "2.6s hard cap fires (timeout)" || bad "cap did not fire"

echo "── 5. Reload never replays the splash ──"
agent-browser reload && sleep 3
RL=$(agent-browser eval "JSON.stringify({navType: window.__NW_LAUNCH.navType, playing: window.__NW_LAUNCH.playing, splash: getComputedStyle(document.getElementById('nw-splash')).display})")
echo "  $RL"
echo "$RL" | ug | grep -q '"playing":false'          && ok "reload → no splash replay" || bad "splash replayed on reload"

echo "── 6. Browser tab (no proxy) never sees the splash ──"
agent-browser open $BASE/ && sleep 3
TB=$(agent-browser eval "JSON.stringify({playing: window.__NW_LAUNCH.playing, launch: document.documentElement.classList.contains('nw-launch'), splash: getComputedStyle(document.getElementById('nw-splash')).display})")
echo "  $TB"
echo "$TB" | ug | grep -q '"playing":false'          && ok "tab → gate inactive" || bad "gate active in tab"

echo "── 7. Static checks ──"
bunx tsc --noEmit                              && ok "tsc 0 errors" || bad "tsc errors"
bun run lint > /dev/null 2>&1                  && ok "eslint clean" || bad "eslint issues"

agent-browser close
echo "── done: $PASS passed, $FAIL failed ──"
[ $FAIL -eq 0 ]
