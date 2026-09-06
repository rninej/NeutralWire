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

---
Task ID: session20
Agent: main (Super Z)
Task: 4 user requests — (1) search must cover EVERY NeutralWire article ever (as old as possible), case-insensitive, and every search button should work well; (2) a story shipped with just "How" as its title — titles must always be proper; (3) hold a news card → bottom app-bar popup (share / open / like / dislike / report a bug with 7 reasons) → reports land in /debug with the article, where a "Make AI Fix" button lets the AI fix the bug with full access; (4) the Ask AI popup doesn't stick to the screen's middle when scrolling.

Work Log:
- Environment was reset again: re-cloned NeutralWire from GitHub, bun install, confirmed sessions 16-19 (all 12 prior defects) already committed (HEAD 7ad3734).
- SEARCH (every article ever): new src/lib/search-index.ts — a compact flat index over the permanent archive (searchIndex/<topicId> = title/summary/article-titles/leans/date, ~200B/entry, 10-min in-process memo so warm servers search from memory). Written at archive time (archive-topic route + topic-lookup archiveTopic) AND lazily backfilled by /api/search (shallow-lists archive keys, diffs, indexes up to 80/request — 17,933 archived topics converge over the first day of searches). /api/search rewritten: live categories + archive index, both sides lowercased (case never matters), hits flagged fromArchive. Client: API search now runs for EVERY query (not only zero-result fallback); when local results exist, archive-only hits render as a "More from the archive" section under the feed grid (SearchResults excludeTopicIds/heading/hiddenIfEmpty props); every search button uses openSearch() (opens the bar + smooth-scrolls to the header so the input is visible when tapped mid-scroll); archive hits get an amber Archive badge + year in the date; placeholder "Search every NeutralWire story ever…".
- TITLES (never "How" again): root cause — the AI shortener's validation only checked `wordCount <= 15 && shorter`, so a truncated 1-word reply ("How") was accepted AND persisted to title-rewrites, which every future refresh then applied blindly. Fixes: (a) rewrites accepted only when 4+ words / 16+ chars; (b) Firebase-cached rewrites validated before applying (bad legacy entries ignored); (c) new fixBrokenTitles() final pass inside shortenLongTitles (all 4 call sites) — any broken topic title is replaced by its best article headline (BBC → center → best length, makeConciseTitle-cleaned) or the summary's first sentence, and the repaired title is patched back to title-rewrites so refreshes keep it.
- LONG-PRESS APP BAR: new src/components/card-context-bar.tsx — portaled bottom app bar with 5 actions (Share w/ navigator.share+clipboard, Open, Like, Dislike, Report). Report stage = the 7 user-specified reasons (incorrect photo/title/summary/sources/video, summary missing, other) + optional note; POSTs the full topic snapshot to new /api/report (idempotent id = hash(topicId+type+deviceId), no spam duplicates). Like/dislike reuse the article view's exact semantics (localStorage neutralwire:vote + /api/engagement topicVote + interest bump). TopicCard: 450ms pointer-based long-press (move>10px cancels → scroll/swipe safe; framer drag cancels; trailing click suppressed via pressHappenedRef, same pattern as swipe; context-menu suppressed while pressing; vibrate(12)); .nw-noselect CSS kills the iOS selection loupe / Android image callout on cards.
- AI FIX PIPELINE: new /api/debug/ai-fix (admin-password gated) — dispatch by report type: title → AI headline rewrite; summary/summary-missing → AI neutral summary (validated 120-1200 chars); photo → re-runs findImageForTopic with VLM content verification, removes the wrong image if no valid replacement; video → kills all videos6/<topicId>__<hl> caches + blocklists the reported videoId (dead list); sources → AI audits the article list, unrelated entries removed (JSON index list, leaning counts recomputed); other → AI investigation with web search. Every fix is applied EVERYWHERE the story lives: every newsCache category containing it, archive/<topicId>, searchIndex, plus the persistent stores for its type (title-rewrites/, summaries/). Report is marked fixed with the AI's own note + model; /debug shows the note and allows re-runs.
- DEBUG PAGE: new "User Bug Reports" card (auto-loads on auth, refresh, per-report status badges, Make AI Fix with live spinner + result note, Dismiss).
- ASK AI POPUP: root cause — the panel rendered inside the topic detail's root motion.div; a transform on an ancestor makes position:fixed anchor to that (scrolling) sheet, so the popup scrolled away instead of sticking. Fix: createPortal(document.body) + centered dialog (items-center, rounded-2xl, max-h-[80vh]) — now truly fixed to the screen's middle while the article scrolls behind it.
- Verified: bunx tsc --noEmit 0 errors; eslint clean on all 14 changed files; dev-server smoke tests: / 200, /debug 200, /api/search 200 (11 hits, archive layer live, "ukraine" == "UKRAINE" same topic sets), /api/report POST 200 + 401/400 gates, /api/debug/ai-fix 401 gate; smoke-test report deleted from Firebase; searchIndex already at 320+ entries and growing.
- Committed + pushed to main.

Stage Summary:
- Search now covers the live feed AND the entire permanent archive (17,933 stories and growing), case-insensitive, from every search button; archive results badge + show their year.
- Broken one-word titles can never ship: AI output validated, cached rewrites validated, and a final repair pass swaps in the best article headline.
- Hold any card → app bar (share/open/like/dislike/report); reports ship with the story to /debug; "Make AI Fix" lets the AI rewrite the story everywhere with its own account of what it did.
- Ask AI is a real centered modal that sticks to the middle of the screen while scrolling.
- Deploy note: Vercel picks up on push. The archive search index self-builds over the first day of real search traffic (80 entries per search, backfill logged as indexedNow).
- Known backlog: bias bar image version, Active CPU audit, privacy policy country/city, email swap to moneyisbroken@gmail.com.
