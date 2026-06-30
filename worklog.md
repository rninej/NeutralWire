---
Task ID: 1
Agent: main (Super Z)
Task: Build a free Ground News-style website using free resources (no paid APIs, no API keys)

Work Log:
- Verified free news data sources: GDELT API was IP-restricted, but RSS feeds from BBC, NYT, The Guardian, CNN, Fox News, Breitbart, NPR, CNBC, NYT Post, Al Jazeera, France 24, etc. all returned 200 OK
- Created `src/lib/news-sources.ts` — registry of 30+ outlets across left/center/right with political leaning ratings from AllSides / MBFC public community ratings
- Created `src/app/api/news/route.ts` — Node.js runtime RSS aggregator:
  - Fetches all feeds in parallel (18s timeout)
  - Custom regex-based RSS 2.0 / RSS 1.0 / Atom parser (no extra deps)
  - 5-min per-feed cache + 4-min topic cache (module-level Maps)
  - Title-keyword Jaccard similarity (threshold 0.34) for clustering same-story coverage across outlets
  - 48h freshness window, dedup by source+link
  - Returns topic objects with coverage count, lean left/center/right tallies, articles sorted by recency
- Created UI components:
  - `src/components/theme-provider.tsx` + `theme-toggle.tsx` — light/dark mode via next-themes
  - `src/components/bias-bar.tsx` — signature blue/grey/red horizontal stacked bar (Ground News visual)
  - `src/components/topic-card.tsx` — featured/default/compact variants with expandable source list showing per-source leaning badge
  - `src/components/bias-columns.tsx` — three-column LEFT / CENTER / RIGHT view (Ground News signature)
  - `src/components/source-list.tsx` — full source registry grouped by leaning
- Built `src/app/page.tsx`:
  - Sticky header with logo, refresh button, dark mode toggle
  - Category tabs: Top / World / Politics / Business / Tech / Science / Health
  - Three views: Feed (featured + grid), Bias Split (3 columns), Sources (full list)
  - Search box filters topics/headlines/sources
  - Min-coverage filter (All / 2+ / 3+ / 4+ sources)
  - Bias legend banner with disclaimer
  - Loading skeletons + error state
  - Sticky footer with disclaimer about community bias ratings
- Lint: 0 errors, 0 warnings
- Agent Browser verification: page renders, fetches real live news (NYT, BBC, CNBC, Breitbart, The Hill, NY Post on same story), category switching works, Bias Split view shows 3 columns correctly, Sources view lists all 30+ outlets, dark mode toggles `class="dark"` on html, mobile viewport adapts, no console errors

Stage Summary:
- Stack: Next.js 16 + TypeScript + Tailwind CSS 4 + shadcn/ui + next-themes + lucide-react
- Data: 100% free public RSS feeds (no API keys, no paywalls)
- Features: real-time cross-source bias comparison, topic clustering, 7 categories, 3 view modes, search, dark mode, responsive
- Live news verified working: e.g. "Trump Renews Threat to Fire Fed Governor Lisa Cook" clustered from 6 sources (NYT/Hill/CNBC/BBC/Breitbart/NYPost) with L3/C4/R2 bias breakdown
- Files: src/lib/news-sources.ts, src/app/api/news/route.ts, src/components/{theme-provider,theme-toggle,bias-bar,topic-card,bias-columns,source-list}.tsx, src/app/page.tsx, src/app/layout.tsx

---
Task ID: 2
Agent: main (Super Z)
Task: Add Firebase Realtime Database (europe-west1) as a cache layer so the page loads instantly; only fetch RSS when cache is stale.

Work Log:
- Verified Firebase RTDB at https://neutralwire-2f24e-default-rtdb.europe-west1.firebasedatabase.app is publicly readable/writable (no auth token needed) — tested with curl PUT/GET
- Created src/lib/firebase-server.ts — REST API client (firebaseRead / firebaseWrite / firebasePatch) using fetch() with 8s timeout. REST chosen over firebase-admin (no service account) and firebase JS SDK (heavyweight + auth roundtrip)
- Created src/lib/news-aggregator.ts — extracted RSS aggregation logic (parseFeed, clusterTopics, aggregateCategory) from /api/news/route.ts so both /api/news and /api/refresh can share it
- Created src/lib/news-cache.ts — Firebase-backed cache layer:
  - Storage: newsCache/<category>/{updatedAt, sourceCount, articleCount, topics[]}
  - readCachedNews / writeCachedNews / isStale / canRefresh / refreshCategory
  - 10-min STALE_MS threshold (cache is "fresh enough" for 10 min)
  - 5-min MIN_REFRESH_GAP_MS local rate-limit per category
  - Dedupes concurrent refreshes for the same category via REFRESH_IN_FLIGHT map
- Rewrote src/app/api/news/route.ts as cache-first:
  - Read Firebase first (fast)
  - If missing: synchronous aggregate + write to Firebase (slow, but only first time per category)
  - If stale: return cache immediately + kick off background refresh via next/server `after()` (response not blocked)
  - Always aggregates 40 topics with minCoverage=1 so cache stores a superset; per-request limit/minCoverage filters applied on read
- Created src/app/api/refresh/route.ts — force-refresh endpoint:
  - Always runs fresh RSS aggregate
  - Writes to Firebase
  - 5-min rate limit per category (override with ?force=1)
- Updated src/app/page.tsx client:
  - Initial load: GET /api/news (returns cached data immediately if available)
  - If response was stale: auto-trigger /api/refresh in background after 2s
  - Refresh button: explicit /api/refresh call
  - "Fresh" / "Cached" badge in header showing load source + ms
  - reqIdRef guards against stale state when user rapidly switches categories
- Updated topic-card.tsx + bias-columns.tsx imports to use @/lib/news-aggregator types
- Lint: 0 errors, 0 warnings
- Cleared and re-populated Firebase cache for all 7 categories with full 40-topic superset

Performance verification (curl, ms = server-side response time):
- Cold start (no cache): 18-19s per category (RSS fetch + Firebase write) — happens ONCE per category
- Warm cache (subsequent loads): 300-700ms per category (Firebase read + return) — 25-60x faster
- All 7 categories now cached: top (24/1085), world (24/405), politics (24/267), business (24/134), technology (24/30), science (24/29), health (16/16)
- Agent Browser: page loads in ~5s with 24 full topics visible, "Fresh" badge shown, no console errors, Refresh button pulls fresh data on demand

Stage Summary:
- Architecture: Client → /api/news → reads Firebase RTDB (europe-west1) → returns cached topics in ~500ms. Background RSS refresh triggered automatically when cache > 10 min old. User-visible Refresh button forces immediate refresh.
- Free-tier friendly: cache reads are 120KB each, refresh writes are 120KB each rate-limited to 1 per 5 min per category per instance → ~240MB/day total Firebase traffic, well within Spark plan 10GB/day limit
- Files added: src/lib/firebase-server.ts, src/lib/news-aggregator.ts, src/lib/news-cache.ts, src/app/api/refresh/route.ts
- Files modified: src/app/api/news/route.ts (cache-first rewrite), src/app/page.tsx (background refresh UI), src/components/{topic-card,bias-columns}.tsx (import path update)
