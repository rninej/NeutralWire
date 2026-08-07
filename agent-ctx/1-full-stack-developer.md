# Task 1 — full-stack-developer — Rewrite PWA onboarding as article-based personalization quiz

## What changed

Completely rewrote `src/components/pwa-onboarding.tsx` (was 296 lines → now 669 lines) to replace the simple 8-emoji sector picker + reading-habits quiz with an article-based personalization quiz that fetches real news and asks the user to pick stories they like / dislike.

## Implementation

### Step 1 — Fetch 22 articles (loading state)
When `showOnboarding` becomes true, kicks off a parallel fetch via `useEffect`:

- **Primary fetches (9 categories × 2 articles = 18 max)**:
  - 7 base categories: `world`, `politics`, `business`, `technology`, `science`, `health`, `sports` (= 14)
  - `relevant` (always — 2 articles)
  - `top` OR `mycountry` — switches to `mycountry` only if a country is detected in localStorage (`neutralwire:country-manual` or `neutralwire:country`); otherwise uses `top` (= 2)

- **Random extras (2 random categories × 2 articles = 4 max)**:
  - Picks 2 categories from the pool `[world, politics, business, technology, science, health, sports, top, relevant, mycountry]`
  - Fetches each with `offset=2` so the articles differ from the primary fetch of the same category (the API supports `offset` for paging past the cached top stories)

- **Endpoint**: `/api/news?category=X&limit=2&slim=1&minCoverage=1&offset=N` (with `&country=CC` appended for virtual categories when a country is detected)
- Each fetch wrapped in `AbortController` with a 12-second timeout; failures return `[]` so the rest of the quiz still loads
- Combined results are deduped by `topicId` (the same story can appear in `world` AND `top`)
- Sorted by "most likely to interest": `world/politics (0) → business/tech (1) → science/health/sports (2) → relevant/top/mycountry (3)`. Within the same priority group, sorted by coverage desc.
- Stored in `articles: QuizArticle[]` state, then `step` advances from `'loading'` to `'likes'`

### Step 2 — "Select all news that interests you"
- Modal header H2: `Select all news that interests you`
- Subtitle: `Tap stories you want to see more of — we'll personalize your feed.`
- All 22 articles rendered in a scrollable grid:
  - **Desktop**: `sm:grid-cols-3` (3-column grid)
  - **Mobile**: `grid-cols-2` (2-column grid)
  - Scroll container: `max-h-[70vh] overflow-y-auto` with custom scrollbar styling (thin scrollbar, rounded thumb, `bg-muted-foreground/30`)
- Each card (`motion.button`):
  - Image thumbnail (16:9 aspect) via `/api/img?url=...` proxy — falls back to muted `ImageIcon` placeholder when no image
  - Category label badge (e.g. `World`, `Politics`, `Tech`)
  - Source count (e.g. `5 sources`)
  - Title (line-clamp-3)
  - Selection state: ring-2 + bg-foreground/5 + Check icon in top-right corner
  - Framer Motion staggered entrance (`opacity 0→1, y 8→0`, delay = `min(idx * 0.025, 0.4)`)
- Footer: `Continue` button (enabled even if nothing selected) — shows count when ≥1 selected
- Step indicator at top: `1. Interests → 2. Avoid` (current step bolded)

### Step 3 — "Select news you don't want to see"
- Same 22 articles, same grid layout, same `articles` state
- Modal header H2: `Select news you don't want to see`
- Subtitle: `Tap stories you'd rather not see — we'll push them down.`
- Selection state: ring-2 + bg-foreground/5 + `ThumbsDown` icon (instead of Check)
- Back button in header to return to step 2 (likedIds preserved)
- Footer: `Done — show me my news` button → calls `handleOnboardingComplete()`

### Step 4 — Save preferences (`handleOnboardingComplete`)
1. Loads existing interests from `localStorage['neutralwire:interests']` (so re-running the quiz doesn't wipe prior picks)
2. For each liked article: calls `detectSectors(title, summary)` and unions the returned sectors into the interests set. Validates each sector against the canonical `SECTORS` list (defensive — `detectSectors` already only returns valid IDs, but this guards against future drift)
3. Persists interests:
   - `localStorage.setItem(ONBOARDED_KEY, 'true')`
   - `setInterestsLocal(sectorsArray)` (writes `neutralwire:interests`)
   - `syncInterestsWithFirebase(deviceId, sectorsArray)` (fire-and-forget POST to `/api/engagement`)
4. For each disliked article: calls `bumpEngagementForTopic(deviceId, title, summary, 'dislike')` — this internally runs `detectSectors` and bumps each matching sector by `-15` (clamped at -50). Tracked across both localStorage engagement map and Firebase.
5. Closes onboarding modal and dispatches `window.dispatchEvent(new CustomEvent('neutralwire:interests-changed'))`

### Preserved existing behavior
- **PWA-only check**: `display-mode: standalone` media query + iOS `navigator.standalone` flag
- **1-hour dismiss cooldown**: `ONBOARDING_DISMISSED_KEY` timestamp set when X button pressed; popup won't re-appear for 1 hour
- **X button dismissal**: same `handleDismiss()` — sets timestamp, hides modal
- **Donation popup logic**: completely unchanged — `ARTICLES_OPENED_KEY` counter, `DONATE_PRESSED_KEY` (3-month suppression), `DONATE_NEXT_KEY` (doubling threshold 10→20→40→80), `DONATE_SHOWN_KEY` timestamp, Ko-fi link
- **`neutralwire:topic-opened` event listener**: unchanged

### Other details
- Modal: `fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-3 sm:p-4`
- Inner container: `w-full max-w-2xl rounded-2xl bg-background shadow-2xl flex flex-col max-h-[92vh]`
- Loading state: centered `Loader2` spinner + "Fetching fresh stories for you…"
- Empty/error state: friendly message + "Skip for now" outline button (still completes onboarding with whatever was selected)
- Accessibility: `role="dialog"`, `aria-modal="true"`, `aria-label` on modal; `aria-pressed` + `aria-label` on each card button; `aria-hidden` on decorative selected indicator; semantic button elements throughout
- TypeScript: imports `TopicArticle` type from `@/lib/news-aggregator` for the API response shape; no `any` types
- Imports kept: `SECTORS`, `detectSectors`, `bumpEngagementForTopic`, `setInterestsLocal`, `syncInterestsWithFirebase` from `@/lib/user-interests`; `getDeviceId` from `@/lib/referral`

## Lint result
`bun run lint` → 0 errors, 0 warnings (had one unused `eslint-disable-next-line @next/next/no-img-element` warning on first pass — removed the directive since the rule wasn't firing on `<img>` inside the JSX expression)

## Dev server
Confirmed via `dev.log` that the dev server is running cleanly on port 3000 — no compile errors after the change, all routes returning 200.

## Files changed
- `src/components/pwa-onboarding.tsx` — complete rewrite (296 → 669 lines)
