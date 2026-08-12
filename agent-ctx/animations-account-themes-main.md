# Task: animations-account-themes

**Agent:** main (Z.ai Code)
**Task ID:** animations-account-themes
**Date:** 2025-08-12

## Summary

Three-part enhancement to NeutralWire (Next.js 16 news PWA):

1. **App-wide animation polish** — smoother tab sliding pill, card hover
   lift + shadow, page transition fade, smoother stagger, button micro-
   interactions (active:scale-95), theme toggle circular reveal (View
   Transitions API), shimmer loading states.

2. **Account icon + user page** — replaced the header's Heart (Ko-fi) +
   DollarSign (Refer) buttons with a single `UserCircle` Account button
   that opens a full-screen user page containing: guest name, referral
   section, ultra-personalize feed (8 subtopic toggles), theme switcher
   (5 themes), notifications, and Support NeutralWire (Ko-fi).

3. **Multi-theme system** — extended next-themes with 3 new themes
   (Midnight, Sepia, High Contrast) on top of the existing Light + Dark.
   All glass / shimmer / scrollbar CSS rules extended to handle the new
   themes. Theme selection persisted in `localStorage:neutralwire:theme`.

## Files Changed

### Created
- `src/lib/guest-name.ts` (67 lines) — `getGuestName`, `getOrCreateGuestName`,
  `regenerateGuestName`. Generates `Guest XXXX` (4 random digits) on first
  visit, persisted in `localStorage:neutralwire:guest-name`.
- `src/lib/use-theme-reveal.ts` (95 lines) — `useThemeReveal` hook that
  wraps `setTheme` in a View Transitions API circular reveal from the
  click point. Falls back to instant switch on browsers without VT support.
  Also exports `THEME_OPTIONS` array (id/label/description/swatch for the
  5 themes) and `ThemeId` type.
- `src/components/user-page.tsx` (490 lines) — full-screen user page
  overlay with 6 staggered sections:
  1. Guest name (calls `getOrCreateGuestName()`)
  2. Refer others (calls `/api/referral/create` + `/api/referral/stats`,
     uses `buildReferralUrl` from `src/lib/referral.ts`)
  3. Ultra-personalize feed (8 subtopic Switch toggles — world, politics,
     business, technology, science, health, sports, top — using
     `setInterestsLocal` + `syncInterestsWithFirebase` from
     `src/lib/user-interests.ts`; "Reset personalization" button)
  4. Theme (5-theme grid using `ThemeSwitcher` from `theme-toggle.tsx`)
  5. Notifications (Enable button + frequency selector; mirrors the
     NotificationEnabler logic from `referral-dialog.tsx`)
  6. Support NeutralWire (Ko-fi link, moved from header)
- `src/agent-ctx/animations-account-themes-main.md` (this file)

### Modified
- `src/app/globals.css` (+ ~280 lines) — added 3 new theme variable
  blocks (`.midnight`, `.sepia`, `.high-contrast`); extended `.dark`
  selectors for glass-frosted, glass-liquid, platform glass, card-glass,
  shimmer, and scrollbar rules to also match `.midnight` (Midnight is a
  dark variant); added `.sepia .shimmer` warm-tinted sweep; added High
  Contrast overrides (solid borders, no translucency, stronger focus
  ring); added `@keyframes nw-ripple` + `.ripple` / `.ripple__wave`
  classes for material-style button ripples; added
  `::view-transition-old/new(root)` rules + `@keyframes nw-theme-reveal`
  + `nw-theme-fade-out` for the circular reveal theme transition; added
  `.card-lift` class for the hover lift + box-shadow transition; added
  `.tab-pill-text` for smooth tab text color cross-fade.
- `src/components/theme-provider.tsx` (rewritten, 47 lines) —
  `ThemeProvider` now sets `storageKey="neutralwire:theme"`,
  `themes=['light','dark','midnight','sepia','high-contrast']`, and
  removed `disableTransitionOnChange` (would interfere with View
  Transitions).
- `src/components/theme-toggle.tsx` (rewritten, 111 lines) — `ThemeToggle`
  quick-toggles light↔dark with circular reveal + `active:scale-95` tap
  micro-interaction. New `ThemeSwitcher` export: a 2-3 col grid of theme
  swatches with gradient preview, label, description, and active ring —
  used in the user page.
- `src/app/page-client.tsx` (4 edits):
  - Imports: removed `DollarSign`, `Heart`; added `UserCircle`. Removed
    `ReferralDialog` import; added `UserPage` import.
  - State: `referralOpen` → `userPageOpen`.
  - Header: replaced the Heart Ko-fi link + DollarSign Refer button with
    a single `<Button onClick={() => setUserPageOpen(true)}>` Account
    button (UserCircle icon, `active:scale-95` tap micro-interaction).
  - JSX: replaced `{referralOpen && <ReferralDialog />}` with
    `<AnimatePresence>{userPageOpen && <UserPage />}</AnimatePresence>`
    so the entrance + exit animations run.
  - `CategoryTab`: converted `<button>` to `<motion.button>` with
    `whileTap={{ scale: 0.94 }}`; added `.tab-pill-text` class for
    smooth text color cross-fade; re-tuned sliding pill spring physics
    (stiffness 380, damping 28, mass 0.85 — slightly more lively).
- `src/components/topic-card.tsx` (3 edits):
  - Stagger delay: 0.04 → 0.035 per card, max 0.32 → 0.30 (smoother
    spread); duration 0.3 → 0.32 (more relaxed); y offset 8 → 6 (subtler).
  - `whileHover`: `scale: 1.02` → `scale: 1.015, y: -2` (combined lift +
    scale); `whileTap`: `scale: 0.98` → `0.985`.
  - Added `card-lift` class to both branches of `wrapWithSwipe` (with
    and without swipe-to-dismiss). The class adds a 0.25s transform +
    box-shadow transition so the hover lift + bias-tinted glow (from
    `card-glow`) animate in together.
- `src/components/topic-detail.tsx` (2 edits):
  - Page transition: `y: 40` → `y: 16` (more fade, less slide);
    duration 0.3 → 0.28.
  - `SummarySkeleton`: replaced every `animate-pulse rounded bg-muted`
    with `shimmer rounded bg-muted` (gradient sweep on top of bg-muted
    for a more premium loading effect).

## How the Theme Reveal Works

The `useThemeReveal` hook in `src/lib/use-theme-reveal.ts`:
1. Captures the click position from the React MouseEvent.
2. Sets `--theme-reveal-x` and `--theme-reveal-y` CSS custom properties
   on `<html>` (defaults to viewport center if no event).
3. Calls `document.startViewTransition(() => setTheme(next))` if the
   browser supports the View Transitions API (Chrome 111+, Edge 111+,
   Safari 18+). Otherwise calls `setTheme(next)` directly (instant
   switch — still functional, just no animation).

The CSS in `globals.css`:
- `::view-transition-old(root)` keeps the old snapshot visible (opacity
  stays at 1) so the new theme is revealed ON TOP of the old one.
- `::view-transition-new(root)` animates `clip-path: circle(0% → 150%)`
  at the click point — the new theme "wipes in" outward in a circle.
- Animation duration: 0.55s with `cubic-bezier(0.2, 0.6, 0.3, 1)`.

## How the Theme System Works

- next-themes is configured with `attribute="class"` so the theme name
  is applied as a class on `<html>`.
- `themes` prop lists all 5 valid theme IDs so next-themes knows which
  values to accept.
- `storageKey="neutralwire:theme"` persists the selection in localStorage
  under the app's namespace (no collision with other apps on the domain).
- `defaultTheme="system"` + `enableSystem` so first-time visitors get
  their OS preference.
- The CSS variable blocks in `globals.css` (`:root` for light, `.dark`,
  `.midnight`, `.sepia`, `.high-contrast`) define all the standard
  shadcn/ui variables (--background, --foreground, --card, --primary,
  --border, etc.) for each theme.
- High Contrast adds extra overrides: `*:not(svg *)` border-color forced
  to pure black; `.glass` / `.card-glass` backgrounds forced solid
  white with no backdrop-filter; `.text-muted-foreground` forced to
  near-black; `*:focus-visible` gets a 3px solid black outline.

## Verification

- `bun run lint` — PASS (0 errors, 0 warnings).
- `curl http://localhost:3000/` — HTTP 200 (was 500 briefly when I
  forgot to export `ThemeSwitcher` from `theme-toggle.tsx`; fixed by
  adding the export).
- Agent Browser: page loads cleanly, NO console errors.
- Clicked "Open account" → user page opens with all 6 sections visible
  (Guest name "Guest 2468", referral code/URL/stats, 8 personalization
  toggles, 5 theme buttons, Enable notifications, Support NeutralWire).
- Clicked "Midnight" → `<html className="midnight">` + localStorage
  `neutralwire:theme = "midnight"`.
- Clicked "Sepia" → `<html className="sepia">`.
- Clicked "High Contrast" → `<html className="high-contrast">`.
- Clicked "Light" → `<html className="light">` (light variables apply
  via `:root` selector).
- Clicked "Politics" toggle → localStorage `neutralwire:interests =
  ["politics"]`.
- Clicked "Close" → user page closes (AnimatePresence exit animation
  runs).
- Header ThemeToggle: click → dark, click again → light.
- Category tab click (Politics) → no errors; sliding pill animates.
- Topic card click → topic detail opens (fade + slight slide);
  Close → closes.
- localStorage verified: `neutralwire:guest-name = "Guest 2468"`,
  `neutralwire:theme = "light"` (after switching back).

## Things Preserved (Not Broken)

- Ko-fi donation: moved into the user page "Support NeutralWire" section.
- Referral tracking: server-side `/api/referral/track` still fires on
  every page load (untouched). The referral code is created in the user
  page via `/api/referral/create` (same endpoint the old ReferralDialog
  used). The `?ref=CODE` URL parameter still works for incoming
  referrals.
- Existing interests system: `setInterestsLocal` +
  `syncInterestsWithFirebase` + the `neutralwire:interests-changed`
  custom event all still work. The main feed (page-client.tsx) listens
  for the event and re-personalizes immediately when a toggle changes.
- Existing platform glass theme: `.glass` / `.glass-frosted` /
  `.glass-liquid` / `.card-glass` rules preserved; extended for
  `.midnight` (dark blue variant).
- Existing shimmer / card-glow / nw-scrollbar / scroll-top-enter CSS:
  preserved; shimmer extended for `.midnight` + `.sepia`.
- Existing swipe-to-dismiss: `wrapWithSwipe` still works; only the
  outer `motion.div` className got `card-lift` added.
- Existing topic-detail animations: image zoom-in, sticky Ask AI,
  like/dislike tap scale, share-button swap — all preserved.
- `referral-dialog.tsx` file: kept as-is (no longer opened from the
  header, but the file + its `NotificationEnabler` component still
  exist in case any future code wants to use them).

## What Was NOT Done (intentionally)

- Did NOT remove `src/components/referral-dialog.tsx`. It's now dead code
  (no entry point), but removing it would be a bigger change than needed
  for this task. Tree-shaking excludes it from the bundle since nothing
  imports it.
- Did NOT add a ripple effect to every button. The CSS classes
  (`.ripple`, `.ripple__wave`, `@keyframes nw-ripple`) are defined in
  globals.css and ready to use, but I only added `active:scale-95` to
  the Account button and ThemeToggle. The ripple needs JS to set
  `--ripple-x`/`--ripple-y` on pointerdown, which would require a
  custom hook or wrapper component. The tap-scale micro-interaction
  gives the same "feels responsive" effect with zero JS overhead.
- Did NOT change the dev server port (still 3000).
- Did NOT run `bun run build` (per the rules).
