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

---
Task ID: 3
Agent: main (Super Z)
Task: Add country auto-detection + 2 new subtopics (Relevant default + My Country) + image-in-every-card layout + rename to NeutralWire + API-powered search fallback.

Work Log:
- Tested free IP geolocation APIs: ip-api.com (server-side, no key, no CORS) and ipwho.is (CORS-friendly for client fallback) both work. ipapi.co is Cloudflare-blocked.
- Created src/lib/country-detect.ts:
  - detectCountryServer(): reads client IP from cf-connecting-ip / x-real-ip / x-forwarded-for headers, calls ip-api.com server-side. 1-hour in-process cache per IP.
  - detectCountryClient(): browser-side fallback via ipwho.is (CORS-friendly). 24-hour localStorage cache.
  - sourcesForCountry(): maps ISO country code → relevant source IDs (curated for 50+ countries, falls back to international set).
  - isoToFlag() / countryName() helpers.
- Created /api/country endpoint: server-side detection, returns {code, name, flag, detected}. Falls back to "International" if detection fails.
- Updated news-sources.ts:
  - Added `relevant` and `mycountry` virtual categories to CATEGORIES array (first two positions).
  - Added PRIMARY_CATEGORIES = ['relevant', 'mycountry'] and SECONDARY_CATEGORIES = [top, world, politics, business, technology, science, health].
  - Updated feedsForCategory() to accept {countrySourceIds} option:
    - `mycountry`: only feeds from sources relevant to visitor's country
    - `relevant`: local feeds PLUS global top/world feeds (mix)
    - Non-virtual categories ignore country
- Updated news-cache.ts:
  - cachePath() now namespaces virtual categories as `<category>__<country>` (e.g. `relevant__US`, `mycountry__HK`)
  - readCachedNews / writeCachedNews / canRefresh / refreshCategory all accept country param
  - isVirtualCategory() helper exported
- Updated /api/news and /api/refresh routes:
  - Auto-detect visitor's country server-side for virtual categories (or accept ?country= override)
  - Pass countrySourceIds to aggregateCategory()
  - Country returned in response for client display
- Updated news-aggregator.ts: aggregateCategory() accepts countrySourceIds option, passes through to feedsForCategory()
- Rewrote src/components/topic-card.tsx with new layout:
  - Header (title + meta) ABOVE the image
  - Image (every card, with ImageIcon fallback placeholder if no image)
  - Description BELOW the image
  - Bias bar + View sources button BELOW the description
  - pickImage() falls back from topic.imageUrl → any article.imageUrl
  - imgError state hides broken images gracefully
- Created /api/search endpoint:
  - Reads entire newsCache/ root in one Firebase call
  - Iterates all topics × all articles across all categories (incl. virtual)
  - Matches on topic title, topic summary, article title, article description, article source name
  - Returns up to 50 hits with snippet highlighting the match
  - 1.7s for 11 categories × 1700+ articles
- Created src/components/search-results.tsx:
  - Card grid of search hits with leaning badge, source, snippet, "Read at X" link
  - Loading state and empty state
- Rewrote src/app/page.tsx:
  - Default category changed to 'relevant'
  - PRIMARY_CATEGORIES (Relevant, My Country) shown as primary tabs with country flag prefix
  - SECONDARY_CATEGORIES hidden behind "More" expandable button
  - Country auto-detected on mount via /api/country → client fallback to ipwho.is
  - Country badge in header showing flag + code
  - Search now: instant local filter → if 0 results, automatic /api/search fallback showing SearchResults component
  - Clear-search X button
- Renamed "Ground News Free" → "NeutralWire" everywhere: layout.tsx metadata, page header, page footer, footer description
- Pre-populated Firebase caches for `relevant__US` and `mycountry__US` (24 topics each)
- Lint: 0 errors, 0 warnings
- Agent Browser verification:
  - Page title: "NeutralWire — Compare News Bias Across Sources"
  - Country auto-detected as 🇭🇰 HK (sandbox IP)
  - Default tab "Relevant" shows HK-relevant + world stories
  - "My Country" tab shows HK-relevant sources (BBC, Al Jazeera, Japan Times, France 24, NYT)
  - "More" expands to Top Stories / World / Politics / Business / Tech / Science / Health
  - Card layout verified: title → image → description → bias bar (via DOM query)
  - 19 news images loaded on the page
  - Search "Ukraine": local filter returned 0, API fallback returned hits from FT and DW with snippets
  - Search "xyznonexistentterm123": API searched 11 categories in 1824ms, showed "No results" with stats
  - No console errors

Stage Summary:
- 2 new subtopics added: "Relevant" (default, mix of local + world) and "My Country" (local only)
- Country auto-detected server-side via IP (ip-api.com) with client-side fallback (ipwho.is)
- Top Stories moved to "More" expandable section
- Every news card now shows: title → image → description → bias bar (with ImageIcon fallback for imageless stories)
- Renamed Ground News Free → NeutralWire (header, footer, metadata)
- Search now falls back to /api/search which scans the entire Firebase cache (11 categories, 1700+ articles) when local filtering yields nothing
- 9 Firebase cache nodes now: top, world, politics, business, technology, science, health, relevant__US, mycountry__US (more added per-country as visitors arrive)
- Files added: src/lib/country-detect.ts, src/app/api/country/route.ts, src/app/api/search/route.ts, src/components/search-results.tsx
- Files modified: src/lib/news-sources.ts, src/lib/news-aggregator.ts, src/lib/news-cache.ts, src/app/api/news/route.ts, src/app/api/refresh/route.ts, src/app/page.tsx, src/app/layout.tsx, src/components/topic-card.tsx

---
Task ID: 4
Agent: main (Super Z)
Task: Fix country detection (UK user seeing wrong country), remove "More" expandable, remove image placeholder icon, remove footer descriptive text.

Work Log:
- Diagnosed country detection issue: server-side detection via request headers was unreliable behind the Caddy gateway (sandbox IP detected instead of real user IP). The client-side fallback via ipwho.is WAS working but only ran when server detection failed.
- Fix 1 — Country detection made client-side PRIMARY:
  - Rewrote detectCountryClient() to try 3 APIs in order: ipwho.is → reallyfreegeoip.org → cloudflare/cdn-cgi/trace
  - Removed server-side detection as the primary path (still available as /api/country but no longer called by default)
  - Added localStorage manual override: 'neutralwire:country-manual' key checked before auto-detection
  - Verified: requests now show country=GB in dev log when UK user visits (confirmed via dev log: "GET /api/news?category=relevant&limit=24&minCoverage=1&country=GB 200 in 990ms")
  - Firebase cache now has relevant__GB node populated
- Fix 2 — Manual country picker:
  - Created src/components/country-picker.tsx: Popover with searchable country list (50+ countries with flags)
  - Shows current country as a button (🇬🇧 GB) in the header, clickable to open picker
  - Selection persisted to localStorage so it survives page reloads
  - Includes "International" option as default fallback
  - User can override auto-detection at any time
- Fix 3 — Removed "More" expandable:
  - All 9 categories now shown flat in the header: Relevant, My Country | Top Stories, World, Politics, Business, Tech, Science, Health
  - Primary categories (Relevant, My Country) separated from secondary by a divider
  - Removed extrasOpen state and ChevronDown/ChevronRight imports
- Fix 4 — Removed image placeholder icon:
  - Cards without images no longer show the ImageIcon placeholder
  - They just show: header (title + meta) → description → bias bar (no image section at all)
  - Verified: 24 cards on page, 16 with images, 8 without — no placeholder icons visible
- Fix 5 — Removed footer descriptive text:
  - Footer now just says "NeutralWire" (centered, minimal)
  - Removed all paragraphs about Firebase, caching, bias ratings, AllSides, MBFC
  - Also removed the descriptive paragraph from the Sources view
- Cleaned up unused imports: MapPin, ChevronDown, ChevronRight, NEWS_SOURCES, CATEGORIES
- Lint: 0 errors, 0 warnings
- Agent Browser verification:
  - Country picker button shows 🇭🇰 HK (sandbox) / user can manually select 🇬🇧 United Kingdom
  - All 9 categories visible flat (no "More" button)
  - 8 cards without images show clean layout (no placeholder icon)
  - Footer shows only "NeutralWire"
  - No console errors

Stage Summary:
- Country detection now works correctly for UK users: client-side ipwho.is detects GB, cached in Firebase as relevant__GB
- Manual country picker lets users override detection if needed (persisted to localStorage)
- All category tabs visible without needing to click "More"
- Cards without images are clean (header + description + bias bar only, no placeholder)
- Footer is minimal (just "NeutralWire")
- Files added: src/components/country-picker.tsx
- Files modified: src/lib/country-detect.ts (client-side primary + multiple API fallbacks + SELECTABLE_COUNTRIES), src/app/page.tsx (country picker, flat categories, minimal footer, removed unused imports), src/components/topic-card.tsx (removed placeholder icon)
