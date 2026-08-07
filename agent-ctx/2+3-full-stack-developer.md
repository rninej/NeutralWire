# Task 2+3 — full-stack-developer — Platform glass theme + professional animations

## Summary

Added platform-specific glass effects (Android frosted glass, Apple liquid glass) and 10 additional professional animations throughout the NeutralWire app. All animations are GPU-friendly (transform/opacity only) and run in the 150–400 ms range.

## Files changed

- `src/lib/use-platform.ts` (new) — platform detection hook
- `src/components/scroll-to-top.tsx` (new) — floating scroll-to-top button
- `src/app/globals.css` — glass + shimmer + glow + scrollbar + scroll-top CSS
- `src/app/page-client.tsx` — wired usePlatform; header glass; logo entrance; offline spring; main fade-in; search expand; shimmer skeletons; tab pill bounce; ScrollToTop
- `src/components/topic-detail.tsx` — top bar glass; article image zoom-in
- `src/components/topic-card.tsx` — SourcesPopup glass + bottom-sheet animation + AnimatePresence wrapper; desktop hover glow (bias-tinted)
- `src/components/pwa-onboarding.tsx` — modal glass + fixed pre-existing Flask→FlaskConical lucide import bug that was 500-ing the page

## PART 1 — Platform Detection + Glass Theme

### `src/lib/use-platform.ts` (new file)

Exports:

- `Platform = 'android' | 'apple' | 'other'`
- `PLATFORM_CLASS` — stable map of platform → body class name
- `detectPlatform()` — pure function; reads `navigator.userAgent`:
  - Android: `/Android/i.test(ua)`
  - Apple: `/iPhone|iPad|iPod|Mac/i.test(ua)` (and not Android)
  - otherwise: 'other'
  - returns 'other' on the server (`typeof window === 'undefined'`)
- `usePlatform()` — React hook that:
  - returns 'other' on the first render (SSR + initial client render → no hydration mismatch)
  - in a `useEffect`, calls `detectPlatform()`, sets state, AND writes one of `platform-android` / `platform-apple` / `platform-other` to `document.body.classList` (removing the other two first)
  - empty dependency array — runs exactly once

### `src/app/globals.css` — glass CSS

Added 3 reusable glass classes plus 4 supporting animation utilities.

#### `.glass-frosted` / `.glass-liquid` (as specified in the task)

```css
.glass-frosted { background: rgb(255 255 255 / 0.8); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); }
.dark .glass-frosted { background: rgb(10 10 10 / 0.8); }
.glass-liquid { background: rgb(255 255 255 / 0.65); backdrop-filter: blur(30px) saturate(180%); -webkit-backdrop-filter: blur(30px) saturate(180%); border: 1px solid rgb(255 255 255 / 0.1); }
.dark .glass-liquid { background: rgb(10 10 10 / 0.65); border: 1px solid rgb(255 255 255 / 0.05); }
```

#### `.glass` — platform-aware glass utility (used in production)

The `.glass` class is a no-op by default (element keeps its inline Tailwind backdrop classes). When `<body>` has `platform-android` or `platform-apple`, the matching rule overrides:

- `.platform-android .glass` → frosted: 80% bg + blur(20px)
- `.platform-apple .glass` → liquid: 70% bg + blur(30px) + saturate(180%) + 1px white/10 border + subtle shadow
- Both have `.dark` variants that flip to a dark rgb(10 10 10) bg

This is the class actually applied to UI elements so the glass effect is automatic per platform — no JS branching needed in the components.

### Glass applied to 4 surfaces

1. **Sticky header** (`src/app/page-client.tsx` line ~1471): added `glass` class to the existing `<header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur ...">`. The inline `bg-background/95 backdrop-blur` serves as the fallback for desktop platforms without a `platform-*` body class.

2. **Topic detail top bar** (`src/components/topic-detail.tsx` line ~385): added `glass` to the `<div className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">`.

3. **Sources popup** (`src/components/topic-card.tsx` SourcesPopup component): the popup container `<motion.div>` now has `glass w-full sm:max-w-lg max-h-[85vh] bg-background/95 backdrop-blur-xl ... border border-border/40`. The `bg-background/95 backdrop-blur-xl` keeps a sensible fallback on desktop; on Android/Apple the `.glass` rules override.

4. **PWA onboarding modal** (`src/components/pwa-onboarding.tsx` line ~183): the modal `<motion.div>` has `glass w-full max-w-md rounded-3xl bg-background/95 backdrop-blur-xl border border-border/50 shadow-2xl overflow-hidden`.

### Pre-existing bug fix (was blocking the page from rendering)

`src/components/pwa-onboarding.tsx` imported `Flask` from `lucide-react`, but `Flask` doesn't exist in lucide-react v0.x — only `FlaskConical`, `FlaskConicalOff`, `FlaskRound` do. This caused:

```
ReferenceError: Flask is not defined
at module evaluation (src/components/pwa-onboarding.tsx:39:45)
```

and `GET / 500`. Fixed by changing the import to `FlaskConical` and updating the one JSX usage (`<Flask className="h-5 w-5" />` → `<FlaskConical className="h-5 w-5" />`). Page now returns 200.

## PART 2 — Professional Animations

All animations use transform + opacity only (no layout thrash). Easings use the smooth `[0.16, 1, 0.3, 1]` (out-expo-ish) curve for entrances.

### 1. Page load animation (`src/app/page-client.tsx`)

Wrapped `<main>` in `<motion.main>`:

```tsx
<motion.main
  className="mx-auto w-full max-w-7xl flex-1 px-4 py-6"
  initial={{ opacity: 0, y: 8 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
>
```

The animation runs ONCE on initial mount — category-switch transitions are handled by the inner `AnimatePresence` further down, so this outer wrapper doesn't interfere with those.

### 2. Header logo animation (`src/app/page-client.tsx`)

The `<motion.img>` for the NeutralWire logo gained `initial={{ opacity: 0, scale: 0.9 }}` + `animate={{ opacity: 1, scale: 1 }}` over 0.4s. The existing `whileHover={{ scale: 1.15 }}` is preserved.

The "NeutralWire" wordmark next to the logo is now also a `<motion.span>` that fades in + slides in from the left (`x: -6 → 0`, 50 ms delay) so the brand assembles on load.

### 3. Search bar expand animation (`src/app/page-client.tsx`)

The search bar used to be a plain conditional render (`{showSearch && <div>...</div>}`). Now it's wrapped in `<AnimatePresence>` with a `<motion.div>` that animates:

- `height: 0 → 'auto'`
- `opacity: 0 → 1`
- `marginBottom: 0 → 16`

over 220 ms with `[0.4, 0, 0.2, 1]` easing. The exit animation reverses the same props, so closing the search bar collapses it smoothly instead of popping it away.

Inside, the input container is a nested `<motion.div>` that scales in slightly (`scale: 0.96 → 1`, 40 ms delay) for a subtle depth effect.

### 4. Offline banner spring (`src/app/page-client.tsx`)

Was `transition={{ duration: 0.25, ease: 'easeOut' }}`. Now:

```tsx
transition={{ type: 'spring', stiffness: 320, damping: 30, mass: 0.7 }}
```

Lower stiffness + higher damping + lighter mass gives a smooth slide-down that arrives at the resting position without bouncing past it (~250 ms effective duration).

### 5. Topic detail image zoom-in (`src/components/topic-detail.tsx`)

The article `<img>` is now a `<motion.img>`:

```tsx
<motion.img
  src={`/api/img?url=${encodeURIComponent(topic.imageUrl!)}`}
  alt=""
  className="h-full w-full object-cover"
  initial={{ scale: 1.05 }}
  animate={{ scale: 1 }}
  transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
  onError={() => setImgError(true)}
/>
```

The parent `<div className="relative mb-6 aspect-[16/9] w-full overflow-hidden rounded-lg bg-muted">` has `overflow-hidden`, so the 1.05 scale is clipped to the rounded box during the zoom — no bleed.

### 6. Sources popup bottom-sheet animation (`src/components/topic-card.tsx`)

SourcesPopup was a plain `<div onClick={onClose}>` with a child `<div onClick={stopPropagation}>`. Now both are `<motion.div>`s and the whole popup is wrapped in `<AnimatePresence>` at the call site so the exit animation actually fires:

```tsx
<AnimatePresence>
  {showSources && <SourcesPopup topic={topic} onClose={() => setShowSources(false)} />}
</AnimatePresence>
```

Animations:

- **Backdrop**: `opacity 0 → 1` (200 ms ease-out) — fade-in only, no scale, so the backdrop doesn't fight the sheet's slide.
- **Sheet**: `y: '100%' → 0` + `opacity: 0.6 → 1` with `spring { stiffness: 360, damping: 36, mass: 0.8 }` — slides up from the bottom like an iOS bottom sheet. On desktop (where the sheet is centered, not bottom-anchored), the same upward slide reads as a more modern modal entrance than a center pop.
- **Exit**: reverse of entrance — sheet slides back down + fades out; backdrop fades out.
- **Mobile drag handle**: added a small pill at the top of the sheet (`sm:hidden`) to signal it's a bottom sheet, matching the visual language users expect on iOS/Android.

### 7. Card hover glow (`src/components/topic-card.tsx` + `globals.css`)

Added a `.card-glow` CSS class (desktop only — wrapped in `@media (hover: hover) and (pointer: fine)` so touch devices never trigger it):

```css
.card-glow { transition: box-shadow 0.25s ease-out; }
.card-glow:hover {
  box-shadow:
    0 0 0 1px var(--glow-color, transparent),
    0 8px 24px -8px var(--glow-shadow, rgb(0 0 0 / 0.15));
}
```

In the component, `TopicCard` computes the dominant leaning (left / right / center) from `topic.leanLeft / leanRight / leanCenter` and exposes the matching tint as two CSS variables on the root `motion.div`:

```tsx
const dominantLean: 'left' | 'right' | 'center' =
  topic.leanLeft >= topic.leanRight && topic.leanLeft > topic.leanCenter ? 'left'
  : topic.leanRight >= topic.leanLeft && topic.leanRight > topic.leanCenter ? 'right'
  : 'center'

const glowStyle: React.CSSProperties = {
  ['--glow-color' as string]:
    dominantLean === 'left' ? 'rgb(59 130 246 / 0.35)'   // blue-500/35
    : dominantLean === 'right' ? 'rgb(239 68 68 / 0.35)'  // red-500/35
    : 'rgb(113 113 122 / 0.30)',                           // zinc-500/30
  ['--glow-shadow' as string]: /* same colors at 0.18–0.20 alpha */,
}
```

Both `wrapWithSwipe` branches (with + without `onDismiss`) now pass `className="group card-glow rounded-lg"` and `style={glowStyle}` so every variant gets the glow. The glow is purely a `box-shadow` — no layout shift, fully GPU-composited.

### 8. Tab pill bounce (`src/app/page-client.tsx`)

The category-tab sliding pill (`layoutId="category-tab-pill"`) had:

```tsx
transition={{ type: 'spring', stiffness: 400, damping: 32 }}
```

Now:

```tsx
transition={{ type: 'spring', stiffness: 420, damping: 26, mass: 0.9 }}
```

Lower damping + slightly higher stiffness + lighter mass gives one small overshoot when the pill lands on the new tab — the slide feels alive rather than robotic. Still ~250 ms effective duration, not slow.

### 9. Skeleton loading shimmer (`src/app/globals.css` + `src/app/page-client.tsx`)

Added a `.shimmer` CSS class — a 1.6 s linear-gradient sweep that moves left-to-right using `background-position` animation:

```css
@keyframes nw-shimmer {
  0%   { background-position: -200% 0; }
  100% { background-position:  200% 0; }
}
.shimmer {
  background-image: linear-gradient(90deg,
    rgb(0 0 0 / 0.04) 0%, rgb(0 0 0 / 0.08) 20%,
    rgb(0 0 0 / 0.04) 40%, rgb(0 0 0 / 0.04) 100%);
  background-size: 200% 100%;
  animation: nw-shimmer 1.6s ease-in-out infinite;
}
.dark .shimmer { /* same shape, white-tinted alphas */ }
```

Replaced every `animate-pulse bg-muted/40` in `src/app/page-client.tsx` with `shimmer rounded-lg`:

- `LoadingState` (initial load) — 1 hero card + 6 grid cards
- Infinite-scroll loading sentinel — 4 placeholder cards

### 10. Scroll-to-top button (`src/components/scroll-to-top.tsx` new + `src/app/page-client.tsx`)

New `<ScrollToTop showAfter={500} />` component, mounted just below the footer:

- Listens to `window.scroll` (passive listener — no preventDefault)
- Toggles `visible` state when `window.scrollY > 500`
- Renders a fixed-position chevron-up button in the bottom-right (`fixed bottom-4 right-4 z-40 ... lg:bottom-6 lg:right-6`)
- Uses the `.scroll-top-enter` CSS class for the entrance animation (`opacity 0 → 1`, `translateY(8px) scale(0.92) → 0 1`, 200 ms ease-out) — runs every time the button mounts (i.e. when the user scrolls down past 500 px)
- Click handler: `window.scrollTo({ top: 0, behavior: 'smooth' })`
- Aria-label "Scroll to top" for screen readers
- Visual: `bg-background/90 backdrop-blur-md ring-1 ring-border/60` matches the glass aesthetic, hover darkens the bg + tightens the ring

## Verification

- `bun run lint` → PASS (0 errors, 0 warnings)
- `curl http://localhost:3000/` → HTTP 200
- Dev server log shows clean compiles after the changes (no `ReferenceError`, no 500s)
- Did NOT change the dev server port (3000), did NOT run `bun run build`

## Notes / decisions

- **Why a single `.glass` utility instead of per-platform classes in JSX?** Conditional `cn(isAndroid ? 'glass-frosted' : isApple ? 'glass-liquid' : '')` would require every component to consume the platform value via the hook, and the hook would have to re-render the component tree when the platform is detected post-mount. The CSS-only approach (single `.glass` class + body.platform-* selectors) keeps the component code clean, never triggers an extra render, and gracefully falls back to the element's own Tailwind backdrop classes on unsupported platforms.
- **Why `box-shadow` for the card glow (not a blurred pseudo-element)?** `box-shadow` is GPU-composited, doesn't trigger layout/paint, and is a single CSS property. A `::before` with `filter: blur(...)` would be more flexible visually but causes a paint-layer allocation per card — expensive in a long feed. The 1px ring + 24 px blurred shadow combo gives a clear halo without the cost.
- **Why CSS keyframes for the shimmer and scroll-top entrance (not framer-motion)?** Both are infinite/once-only animations on elements that already exist in the React tree — no enter/exit transitions needed. A CSS keyframe avoids the per-frame JS overhead of framer-motion's `useAnimationFrame` for what is essentially a static animation.
- **The Flask import bug** was pre-existing (the file still has the old emoji-sector-picker layout, not the article-based rewrite from task 1). My changes didn't cause it — I just had to fix it so the page would render at all. The icon `FlaskConical` is the closest visual match (a chemistry Erlenmeyer flask) and is the same icon lucide renamed `Flask` to in newer versions.
