#!/bin/bash
# test-session6.sh — verify per-user Feature Flags + PWA splash (≤0.5s)
# Session 6 continuation. Run from anywhere; cds into the repo.
set -u
cd /home/z/my-project/neutralwire

NAVINFO='(() => {
  const tl = document.querySelector("[role=tablist][aria-label=\"News categories\"]");
  if (!tl) {
    const sheetBtn = document.querySelector("button.h-11.w-full");
    if (sheetBtn) return JSON.stringify({variant: "sheet"});
    const wrap = document.querySelector(".flex.flex-wrap.items-center.gap-1");
    return wrap ? JSON.stringify({variant: "classic"}) : JSON.stringify({variant: "none"});
  }
  const cls = tl.className || "";
  const firstBtn = tl.querySelector("button");
  const h = firstBtn ? Math.round(firstBtn.getBoundingClientRect().height) : 0;
  const hasIcon = !!(firstBtn && firstBtn.querySelector("svg"));
  const n = tl.querySelectorAll("button").length;
  let v = "cards";
  if (cls.includes("flex-wrap")) v = h >= 40 ? "tiles" : "wrap-pills";
  else if (cls.includes("items-stretch")) v = "tabs";
  return JSON.stringify({variant: v, h, hasIcon, n, cls: cls.slice(0, 50)});
})()'

step() { echo ""; echo "════════ $1 ════════"; }

step "1. Start dev server"
pkill -f "next dev" 2>/dev/null; sleep 1
nohup bun run dev > dev.log 2>&1 &
for i in $(seq 1 90); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3000 2>/dev/null)
  if [ "$code" = "200" ]; then echo "READY (after ~$((i*2))s)"; break; fi
  sleep 2
done

step "2. SSR HTML contains the splash markup"
curl -s http://localhost:3000 | grep -c 'id="nw-splash"' | sed 's/^/nw-splash count: /'
curl -s http://localhost:3000 | grep -o 'nw-sp-word\|nw-sp-bar\|nw-sp-icon' | sort -u

step "3. Open page — splash retired by pure CSS, no hydration errors"
agent-browser open http://localhost:3000
agent-browser wait 1500
agent-browser eval "(() => { const el = document.getElementById('nw-splash'); if (!el) return 'MISSING'; const cs = getComputedStyle(el); return JSON.stringify({opacity: cs.opacity, visibility: cs.visibility, animationName: cs.animationName, inlineStyle: el.getAttribute('style') || '(none)'}); })()"
agent-browser errors

step "4. Default render (site-wide flag = cards via /api/flags fallback)"
agent-browser wait 1500
agent-browser eval "$NAVINFO"

step "5. Fresh default first (no cookie) → cards, then set nw_nav=tabs → SSR renders tabs on reload"
agent-browser cookies clear
agent-browser open "http://localhost:3000/?v=clean"
agent-browser wait 2000
agent-browser eval "$NAVINFO"
agent-browser cookies set nw_nav tabs
agent-browser open "http://localhost:3000/?v=ssr-tabs"
agent-browser wait 2500
agent-browser eval "$NAVINFO"
agent-browser eval "document.cookie"

step "6. Open Account → Feature Flags card"
agent-browser find role button click --name "Open account" || { agent-browser snapshot -i | head -20; }
agent-browser wait 1200
agent-browser eval "(() => { const t = document.body.innerText; return JSON.stringify({
  hasYourHeader: t.includes('Your header style'),
  hasFollowDefault: t.includes('Follow site default'),
  hasSiteWide: t.includes('Site-wide default (admin)'),
  hasPwGate: !!document.querySelector('input[type=password]'),
  hasTiles: t.includes('Icon tiles'),
  hasMaxiPills: t.includes('Maxi pills')
}); })()"

step "7. Pick 'Icon tiles' personally → instant apply + cookie"
agent-browser find text "Icon tiles" click
agent-browser wait 800
agent-browser eval "document.cookie"
agent-browser eval "(() => { const t = document.body.innerText; return t.includes('Saved for you: Icon tiles') ? 'FEEDBACK-OK' : 'FEEDBACK-MISSING: ' + (t.match(/Saved for you[^\n]{0,40}/) || ['none'])[0]; })()"

step "8. Close Account (Escape) → homepage now shows tiles INSTANTLY (no reload)"
agent-browser press Escape
agent-browser wait 800
agent-browser eval "$NAVINFO"
agent-browser screenshot /home/z/my-project/download/session6-tiles-instant.png

step "9. Reopen → 'Follow site default' → back to cards"
agent-browser find role button click --name "Open account"
agent-browser wait 1000
agent-browser find text "Follow site default" click
agent-browser wait 600
agent-browser eval "document.cookie"
agent-browser press Escape
agent-browser wait 800
agent-browser eval "$NAVINFO"

step "10. Console + page errors (FULL output)"
agent-browser errors
agent-browser console | tail -12

step "11. Screenshot for visual check"
agent-browser screenshot /home/z/my-project/download/session6-verify.png

echo ""
echo "════════ TEST CYCLE COMPLETE ════════"
