# NeutralWire — Multi-Agent Worklog

(Project continued from a previous environment; repo cloned from GitHub on this session's start. All work happens in /home/z/my-project/neutralwire.)

---
Task ID: session18
Agent: main (Super Z)
Task: 3 user-reported fixes — (1) fresh load sometimes says "offline, waiting for connection" while online; (2) ONLY while a preview video is playing, show a pressable sound button (autoplay policy needs a press); (3) video chrome (progress bar / pause-play / volume) overlays a freshly loaded video for ~2s — must only appear on a user tap.

Work Log:
- Environment was reset (local repo gone): re-cloned NeutralWire from GitHub, bun install, confirmed previous 6-item batch already committed (c4e3b40).
- Offline false positive (sw.js): root-caused to the v23 2.5s navigation race — fresh load with no cached HTML that lost the race fell straight to the "Waiting for connection…" offline page even while online (just slow). Fix: the 2.5s race is only the FAST path; when NO cache exists we keep awaiting the original in-flight fetch up to a 20s hard timeout before declaring offline (truly-offline fetches still reject in ms). Offline page poll 4s → 2.5s. Cache names v25 → v26.
- Preview sound button (video-preview-store.ts + video-preview.tsx): passive "Preview" chip replaced with a pressable Sound button, rendered only while the preview plays. PreviewControls.setAudible(on) + store setPreviewAudible/forcePreviewAudio (press outranks auto lease grants; previous audible preview muted via its controls). Both YT and native players implement setAudible. Button press never opens the article (pointer-events-auto + stopPropagation + card's button guard).
- Gesture-race guard: pressedMutedRef captures the displayed mute state at pointerdown (the press's document-capture gesture-recovery can flip `muted` between pointerdown and click — click would otherwise toggle back off).
- Chrome never auto-reveals (video-player.tsx): removed the `!playing → show()` effect (mount-paused auto-show → ~2s bar over a fresh video). Bar appears ONLY from user tap/mousemove; tap that pauses keeps it up, tap that plays auto-hides 3s (show(!playing)); mute/fullscreen/mousemove → show(playing).
- Verified: bunx tsc --noEmit 0 errors, eslint clean, node --check sw.js, dev server 200 on / and /sw.js serving v26.
- Committed 6d76c3e (+ worklog b1fcdff), pushed to main.

Stage Summary:
- Slow fresh loads never misreport offline; press-to-unmute preview sound button live; article videos load chrome-free until tapped.
- Deploy note: Vercel picks up on push; installed PWAs update SW to v26 on next launch.
- Known backlog: bias bar image version, Active CPU audit, privacy policy country/city, email swap to moneyisbroken@gmail.com.

---
Task ID: session19
Agent: main (Super Z)
Task: 3 user-reported fixes — (1) another centered pause/play overlay in the middle of the video; (2) the preview sound button doesn't work well on mobile; (3) the stories-read milestone popup must say "If you love NeutralWire's free mission, Please Donate" with a donate button, switchable to the original version from /debug.

Work Log:
- Read worklog (session18 done, 6d76c3e pushed), then re-read video-player.tsx, video-preview.tsx, video-preview-store.ts, milestone-celebration.tsx, page.tsx, page-client.tsx, /api/flags route, debug/page.tsx.
- Center overlay (video-player.tsx): removed VideoChrome's centered play affordance ({!playing && big circle Play}) — the big button that sat in the absolute middle of the video when paused. The bottom bar's play/pause (tap-only, per session18) is now the only affordance; video surface stays clean.
- Mobile sound button (video-preview.tsx): root causes addressed — (a) the toggle used onClick, which touch browsers can cancel when the tap drifts into a scroll (pointercancel, no click ever fires → button "dead"); now the toggle runs at POINTERUP with tap-vs-swipe detection (>12px drift or pointercancel = no toggle), always inside the user gesture; onClick is suppression-only. (b) Hit target ~24px → ~36px (py-2.5, h-4 icon, touch-action: manipulation, select-none). (c) iOS parks the audio pipeline after an autoplay block — unMuteNow() now re-asserts playVideo() after unMute so audio actually flows. pressedMutedRef → soundPressRef {x, y, displayedMuted} (displayed-at-press wins over the gesture-recovery flip, same race guard as before).
- Milestone popup (milestone-celebration.tsx): new donateMode prop (default true). Donate body: count-up "N stories read" hero + confetti stays; body = "If you love NeutralWire's free mission, Please Donate." + supporting line + full-width Donate on Ko-fi button (https://ko-fi.com/neutralwire, new tab). Original body (progress bar + community love + share) kept verbatim behind donateMode=false. Header comment now documents WHY the original had no donate button (peak–end rule: no ask at the peak of a happy session; Ko-fi stayed in Account → Support).
- Flag wiring: /api/flags GET/POST milestoneDonate (Firebase featureFlags/milestoneDonate, default true, 10s memo); page.tsx SSR read (5s memo) → PageClient milestoneDonate prop → MilestoneCelebration donateMode; debug/page.tsx Feature Toggles: new "Milestone popup: donate version" switch (Use donate / Use original).
- Verified: bunx tsc --noEmit 0 errors, eslint clean on all 7 changed files, dev server: / 200, /debug 200, GET /api/flags returns milestoneDonate:true.
- Committed 8dcacf4, pushed to main.

Stage Summary:
- Article video: no center button ever — chrome is the tap-raised bottom bar only.
- Preview sound button: pointerup tap detection (scroll-proof), 36px target, iOS un-mute nudge.
- Milestone popup defaults to the donate ask + Ko-fi button; /debug "Milestone popup: donate version" switch restores the original celebration-only body. Vercel deploys on push; flag applies to all users on next page load (SSR, no flash).
- Known backlog: bias bar image version, Active CPU audit, privacy policy country/city, email swap to moneyisbroken@gmail.com.
