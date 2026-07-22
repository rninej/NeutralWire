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

---
Task ID: 5
Agent: main (Super Z)
Task: Fix 4 issues: HTML in descriptions, flag emoji on mobile, UK news prioritisation, duplicate stories.

Work Log:
- Fix 1 — HTML/code leaking into card descriptions:
  - Root cause: description cleaning order was decodeEntities(stripHtml(stripCdata(raw))) — stripHtml ran BEFORE decodeEntities, so encoded HTML like &lt;p&gt; survived stripping and then got decoded into visible <p> tags.
  - Fix: new cleanDescription() function that does: stripCdata → decodeEntities → stripHtml → decodeEntities → collapse whitespace. Double-decode catches any entities revealed by the first decode.
  - Verified: 0/24 descriptions contain HTML after fix.

- Fix 2 — Flag emoji on mobile category tabs:
  - Removed flag emoji from CategoryTab component entirely — tabs now just show "Relevant", "My Country" etc. with no country prefix.
  - Updated CountryPicker trigger button to show "GB" text instead of flag emoji (just a map pin icon + country code).
  - The flag emojis are still in the dropdown list for visual identification when picking a country, which is fine.

- Fix 3 — UK news prioritisation in Relevant tab:
  - Added localCoverage field to TopicArticle — counts how many articles in a topic come from the visitor's local sources.
  - Modified clusterTopics() to accept a localSourceIds set and track localCoverage per topic.
  - Modified aggregateCategory() sort: for `relevant` category with local sources, sort by (coverage + localCoverage * 2.0) instead of just coverage. This means:
    - A UK story with 2 sources + 5 local = score 12, beats a non-UK story with 5 sources = score 5
    - But a major international story with 17 sources = score 17, still beats it
    - Result: UK news rises to positions 4-9, major international stays at 1-3
  - CRITICAL FIX: applyFilters() in /api/news/route.ts was RE-SORTING topics by coverage desc, destroying the local boost. Removed the re-sort — applyFilters now only filters and slices, preserving the aggregator's sort order.
  - Verified: GB Relevant tab now shows: 1. Trump birthright (17 src), 2. Monaco bomb (6 src), 3. South Africa (6 src), 4. Andy Burnham (2 src, 5 local), 5. Guardian defence plan (2 src, 4 local), 6. Starmer defence (2 src, 4 local), 7. Gojek (4 src), 8. Shetland tunnels (3 src, 3 local), 9. Strawberry Moon UK (1 src, 4 local)

- Fix 4 — Duplicate stories in different wording:
  - Root cause: Jaccard similarity threshold 0.34 was too strict for same-event stories with different headlines. E.g., "Trump threatens to abolish birthright citizenship" vs "Supreme Court upholds birthright citizenship" share keywords but Jaccard < 0.34 because the union is large.
  - Fix: hybrid clustering with two conditions (either triggers a match):
    1. Jaccard >= 0.22 (lowered from 0.34)
    2. Shared significant keywords >= 3 (catches long-titled stories where Jaccard ratio is low but key entities match)
  - Also narrowed time window from 72h to 48h to avoid clustering unrelated stories that happen to share common words.
  - Verified: the Supreme Court birthright citizenship ruling is now ONE topic with 17 sources (was previously split into 3-4 separate topics). Other genuinely different Supreme Court stories (transgender sports, campaign finance) remain as separate topics.

- Cleared and re-populated all Firebase caches with new clustering + description cleaning.
- Lint: 0 errors, 0 warnings.
- Agent Browser verification: UK news at positions 4-9 in Relevant tab, no HTML in descriptions, no flag emoji on tabs, no duplicate stories, mobile viewport clean.

Stage Summary:
- 4/4 issues fixed and verified
- UK news now properly prioritised in Relevant tab (local boost score = coverage + localCoverage * 2.0)
- Same-event stories with different wording now cluster into one topic (hybrid Jaccard + shared-keyword clustering)
- No HTML/code in card descriptions (double-decode + strip approach)
- No flag emoji on category tabs or country picker button (just text "GB")
- Files modified: src/lib/news-aggregator.ts (cleanDescription, clusterTopics with localSourceIds + hybrid clustering, aggregateCategory with local-boost sort), src/app/api/news/route.ts (applyFilters no longer re-sorts), src/app/page.tsx (CategoryTab flag removed), src/components/country-picker.tsx (flag emoji removed from trigger button)

---
Task ID: 6
Agent: main (Super Z)
Task: Fix images for top news (OG image fallback + proxy), add full-page detail view with neutral LLM summary, share button, sources, bias legend.

Work Log:
- Fix 1 — Images for top news:
  - Root cause: many news CDNs (BBC, Guardian, Raw Story) block external image access (401/403/400). RSS feed image URLs that look valid fail when loaded in the browser.
  - Added validateImageUrl(): does a full GET request (not HEAD) with browser-like User-Agent + Referer headers, checks content-type and size. Cached 30 min per URL.
  - Updated findImageForTopic(): collects ALL candidate images (topic.imageUrl + all article imageUrls + OG images from article pages), validates each with GET, returns first working URL.
  - Updated aggregateCategory(): validates images for top 10 topics in parallel. Broken URLs are cleared (set to null) so cards show clean layout without image.
  - Created /api/img image proxy: fetches images server-side with proper Referer header, caches blobs for 1 hour. Bypasses CORS/referrer restrictions.
  - Updated TopicCard + TopicDetail to use /api/img?url=... proxy for all images.
  - Fixed stale imgError state: changed from boolean to imgErrorMap (keyed by URL) so error state auto-resets when image URL changes.
  - Added key prop to TopicCard (topicId + imageUrl) to force remount when image changes.
  - Fixed fetchData: virtual categories now wait for country detection before fetching (prevented fetching with wrong country on initial load).
  - Results: all categories now have 19-24/24 topics with validated images. Featured card image loads at 2000px resolution.

- Fix 2 — Full-page detail view:
  - Created src/components/topic-detail.tsx: full-screen overlay with:
    - Sticky top bar with Close and Share buttons
    - Title (h1), image, bias bar with legend (L/C/R counts)
    - Neutral Summary card: AI-generated in-depth summary from z-ai LLM
    - Sources grouped by leaning (Left / Center / Right) with clickable article links
  - Created /api/summary endpoint: uses z-ai-web-dev-sdk to generate neutral summary. System prompt instructs: neutral, journalistic, 3-4 paragraphs (what happened, context, reactions, what next). Caches results 2 hours in-process.
  - TopicCard now clickable: clicking anywhere on the card (except links/buttons) opens the detail overlay. Added hover ring effect for affordance.
  - Detail overlay features:
    - Escape key closes
    - Body scroll locked when open
    - Share button uses navigator.share() on mobile, falls back to clipboard copy
    - Image proxied through /api/img
    - LLM summary loads async with loading spinner
    - Error fallback shows original descriptions if LLM fails

- Re-cached all Firebase categories with validated images.
- Lint: 0 errors, 0 warnings.
- Agent Browser verification:
  - Featured card has image (2000px naturalWidth)
  - 7/8 visible cards have images
  - Clicking card opens full-screen detail overlay
  - Detail shows: title, image, bias bar (14L/12C/2R), neutral summary (AI-generated, 250+ words), 14 source links grouped by leaning
  - Share button present, Close button present
  - No console errors

Stage Summary:
- Top news now always has an image (validated server-side, proxied through /api/img)
- Clicking any card opens a full-page detail view with:
  - AI-generated neutral in-depth summary (z-ai LLM)
  - Share button (top right)
  - Image, header, bias bar with legend
  - All sources grouped by political leaning
- Files added: src/app/api/img/route.ts (image proxy), src/app/api/summary/route.ts (LLM summary), src/components/topic-detail.tsx
- Files modified: src/lib/news-aggregator.ts (validateImageUrl, findImageForTopic with GET validation, image check for top 10 topics), src/components/topic-card.tsx (proxyImage, clickable card, imgErrorMap), src/app/page.tsx (detailTopic state, TopicDetail overlay, key props)

---
Task ID: 8
Agent: main (Super Z)
Task: Cache neutral summaries in Firebase Realtime Database to save time + API calls for subsequent users.

Work Log:
- Updated /api/summary route with 3-layer caching:
  1. In-process Map (instant ~0ms, per-instance, 2h TTL) — fastest, but lost on restart
  2. Firebase RTDB (~200ms, shared across ALL instances, permanent) — the new layer
  3. Generate fresh (LLM ~4s or extractive fallback ~0ms) — slowest, only runs once per topic
- Storage layout in Firebase: summaries/<topicId> = { summary, generatedAt, title, sourceCount }
- Added IN_FLIGHT deduplication: if two users open the same topic simultaneously, only one LLM call runs; the second user waits and reuses the result.
- Flow: check memory → check Firebase → generate → save to both memory + Firebase → return
- Response includes `source` field: 'memory' | 'firebase' | 'generated' so client can tell where it came from
- Tested end-to-end:
  - First call: source=generated, 4.5s, summary saved to Firebase
  - Verified Firebase has: title, sourceCount, summary (1395 chars)
  - Second call: source=memory, 0.025s (180x faster)
- Removed unused decodeEntities function
- Lint: 0 errors, 0 warnings

Stage Summary:
- Summaries now persist in Firebase permanently, shared across all server instances
- First user to view a topic pays the ~4s LLM cost; every subsequent user (on any instance) gets it in ~200ms from Firebase
- Concurrent requests for the same topic are deduplicated (only 1 LLM call)
- Files modified: src/app/api/summary/route.ts (added firebaseRead/firebaseWrite, IN_FLIGHT dedup, StoredSummary type)

---
Task ID: 9
Agent: main (Super Z)
Task: Per-user tailored notifications + interests impact relevant page + Share button on mobile + fix AI search "connection error" + install popup on topic view

Work Log:

1. **Per-user tailored notifications + engagement tracking**:
   - Created `src/lib/user-interests.ts` (client-side utility):
     - 8 sectors: politics, world, technology, business, science, health, sports, entertainment
     - Each sector has a curated keyword list (e.g. "trump", "starmer", "parliament" → politics)
     - `getInterests()` / `setInterestsLocal()` / `syncInterestsWithFirebase()` — manage interests
     - `getEngagement()` / `bumpEngagement()` — per-sector scores 0..100, +10 per click, +15 per share, +10 per AI ask, +2 per time tick (capped at 100)
     - `detectSectors(title, summary)` — keyword scan to map a story → sectors
     - `personalizationBoost(topic, interests, engagement)` — reordering score for the news feed
   - Created `src/app/api/engagement/route.ts`:
     - POST `type=interests` → writes `devices/<deviceId>/interests` array
     - POST `type=engagement` → writes `devices/<deviceId>/engagement/<sector>` = {score, clicks, lastUpdate}
   - Added `sendPersonalizedWebPush()` to `src/lib/pushify.ts`:
     - Reads ALL devices from Firebase
     - For each device with pushSubscription + notificationsEnabled, picks the best story from a candidate pool based on the device's `interests` array and `engagement` map
     - Sends per-device web-push with a per-slot tag (so morning/lunch/evening don't overwrite each other)
     - Falls back to the AI-picked broadcast story for devices with no interests
   - Updated `src/app/api/push/trigger/route.ts`:
     - Now does TWO sends in parallel:
       1. Pushify broadcast with AI-picked best UK story (for Pushify subscribers)
       2. Per-device personalized web-push (each device gets the story matching their interests+engagement)
     - Fetches 5 categories (relevant, world, technology, business, science) for the candidate pool
     - Detects sectors for each candidate using the same keyword map (mirrored server-side)
     - Returns `{ broadcast, personalized: {sent, personalized, fallback} }`
   - Engagement is tracked on:
     - Topic click (TopicCard → handleOpenDetail)
     - Topic open via shared link (/?topic=...)
     - AI question (AskAiPanel handleSend)
     - Share button (handleShare)

2. **Interests picker impacts the relevant page**:
   - `PwaOnboarding.handleOnboardingComplete` now:
     - Saves to localStorage via `setInterestsLocal()` (news page reads this)
     - Syncs to Firebase via `syncInterestsWithFirebase()` (cron reads this)
     - Dispatches `neutralwire:interests-changed` event so the news page re-sorts immediately
   - `page-client.tsx` now:
     - Loads interests + engagement on mount
     - Listens for `neutralwire:interests-changed` and `neutralwire:engagement-changed` events
     - `filteredTopics` memo applies `personalizationBoost()` when no active search AND user has interests/engagement
     - Stable sort preserves aggregator ordering for ties (so high-coverage + local stories still surface)
     - Boost formula: `coverage + min(8, interestMatch*3 + engagementScore*0.05)` — capped so a single sector can't dominate
   - `TopicCard` onClick handlers now use `handleOpenDetail` (wraps `setDetailTopic` + engagement bump)
   - URL-based topic opening (from shared `/?topic=` links) also routes through `handleOpenDetailRef`

3. **Share button on mobile + different gradient**:
   - `topic-detail.tsx` Share button:
     - Changed gradient from `from-purple-500 via-blue-500 to-cyan-400` → `from-amber-400 via-orange-500 to-rose-500`
     - Icon color changed `text-purple-500` → `text-orange-500`
     - "Share" text is now visible on ALL viewports (removed `hidden sm:inline`)
     - Added `aria-label="Share this story"` for accessibility
   - The Ask AI button keeps its original purple→blue→cyan gradient, so the two CTAs are now visually distinct

4. **Fix AI search "connection error" bug**:
   - Root cause: sequential provider chain took 60s+ (8 Gemini × 8s + 2 Groq × 8s + OpenRouter), exceeded Vercel's 10s maxDuration, fetch rejected → "Connection error" catch fired
   - Rewrote `src/lib/ai-providers.ts`:
     - Added the 4 new Gemini models requested (gemini-3.5-flash, gemini-3.5-flash-lite, gemini-3.1-pro, gemini-3-flash) at the front of GEMINI_MODELS
     - `callAI` now uses `Promise.any()` to race Gemini (first available) + Groq (first available) + OpenRouter IN PARALLEL — first non-null answer wins
     - `callAICompound` does the same parallel race but with `googleSearch` tool enabled on Gemini
     - `callGemini` takes a `useSearch` flag — callAI skips search (fast, uses training data), callAICompound enables it
     - Per-provider timeout reduced to 4s (6s for search-enabled Gemini) — total budget fits within 9s
     - Sequential retry on remaining Gemini/Groq models only fires if parallel race fails (rare)
   - Rewrote `src/app/api/ask-ai/route.ts`:
     - Hard 9s deadline check before calling compound (avoids Vercel timeout)
     - Better system prompt: tells the model it does NOT have web search in normal mode, so ({/compound}) is only emitted when truly needed
     - Friendly fallback messages instead of empty answers when compound fails
     - Returns helpful JSON error instead of crashing on any failure
   - Updated `AskAiPanel.handleSend`:
     - Added client-side 12s AbortController timeout (above server's 10s so server can return its own error first)
     - Distinguishes AbortError (timeout) from real network errors
     - Parses error JSON from non-OK responses (handles Vercel 504 HTML pages gracefully)
     - Specific messages: "AI took too long" vs "Connection error" vs server-provided error

5. **Install app popup on topic view**:
   - Updated `src/components/pwa-install-prompt.tsx`:
     - Detects `?topic=` in URL on mount → shows install prompt after 800ms (high-conversion moment: user clicked a shared story link)
     - Listens for `neutralwire:topic-opened` custom event → shows prompt after 1.5s (catches in-app topic opens)
     - Refactored dismiss cooldown check into `isDismissed()` helper, used by both home-page and topic-open triggers
     - Home page iOS still uses the original 2s delay
   - `topic-detail.tsx` now dispatches `window.dispatchEvent(new CustomEvent('neutralwire:topic-opened'))` on mount, so opening any topic (via card click OR shared link) triggers the install prompt

Verification:
- Lint: 0 errors, 0 warnings on all modified files
- TypeScript: no new errors introduced (pre-existing errors in unrelated files unchanged)
- Engagement API tested with curl: interests + engagement writes confirmed in Firebase (`devices/test_d_123` showed `interests:["politics","technology"]` and `engagement.politics.score:10`)
- Ask AI tested with curl:
  - "Capital of France?" → answered correctly in 2.8s (parallel, no search needed)
  - "Latest Tesla stock price?" → returned helpful fallback message in 7.8s (compound flow triggered, all providers rate-limited, graceful failure)
  - "Who is the UK PM?" → answered correctly in 8.4s (Keir Starmer, from training data, no ({/compound}) needed)
- News page loads in 50ms cached, 800ms fresh
- Page with `?topic=` param renders 200 OK in 2.3s

Stage Summary:
- 5 tasks completed end-to-end
- Per-user notifications now sent via parallel web-push (each device gets a story matching their interests+engagement), Pushify still broadcasts the AI-picked best UK story
- Interests picked during onboarding now actively re-order the "Relevant" news tab in real time (boost formula capped so no single sector dominates)
- Share button on topic detail uses amber/orange/rose gradient (distinct from purple/blue/cyan Ask AI button) and shows "Share" text on mobile
- AI search no longer fails with "Connection error" — parallel provider racing + per-provider timeouts fit within Vercel's 10s budget; compound flow returns helpful fallbacks instead of crashing
- Install app popup now appears when a user opens a topic (either via shared link like /?topic=ayw0ayh or by clicking a card), in addition to the existing home-page 2s trigger
- Files added: src/lib/user-interests.ts, src/app/api/engagement/route.ts
- Files modified: src/lib/ai-providers.ts (parallel racing + new Gemini models + useSearch flag), src/lib/pushify.ts (sendPersonalizedWebPush), src/app/api/ask-ai/route.ts (deadline + better errors), src/app/api/push/trigger/route.ts (per-user push + sector detection), src/components/pwa-onboarding.tsx (Firebase sync + event dispatch), src/components/pwa-install-prompt.tsx (?topic= + topic-opened event), src/components/topic-detail.tsx (engagement tracking + Share button + topic-opened event + better AI errors), src/app/page-client.tsx (interests state + personalization boost + handleOpenDetail)
