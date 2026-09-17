# Discover content rules — images & headlines

What actually earns the card. Condensed from Google's Discover documentation
and field experience, mapped onto NeutralWire's pipeline.

## Images — the card IS the picture

**Hard requirements**
- ≥ **1200 px wide** — anything smaller caps at thumbnail and is skipped for
  large-card placements.
- `max-image-preview:large` robots meta (shipped — verify in view-source).
- Real, editorial photographs. Not logos, not stretched tiles, not collages.

**NeutralWire policy (already live)**
- og:images are scraped from outlets (typically ≥1200 px) and **vision-verified
  against the headline** (the "Tesco fix", cache v6) before being cached.
- The `/api/img` proxy serves heroes with 7-day CDN caching.
- `/news-sitemap.xml` carries `image:image` per photo'd story — the explicit
  "use this picture" signal.
- **No photo → no image entry.** Never a black/placeholder card (same rule the
  notification pipeline already follows).
- The branded bias-bar composite (`/api/og-image`) is used for *social link
  previews only* — Google Discover cards use the raw hero.

**Weekly spot-check (2 min)**
Open five fresh `/story/<id>` pages from the feed. Each hero should be a real,
relevant, large photo. If a story has a wrong/dated image, use the long-press →
"Make AI Fix" path or wait for the next refresh re-pick.

## Headlines — the hook that must not lie

Google demotes:
- Clickbait and teaser withholding ("You won't believe…", "This one trick…").
- ALL-CAPS shouting and trailing "…" bait.
- Mismatch between title and page content (the page must deliver the promise).

NeutralWire advantages:
- Titles are aggregated from **real outlet headlines** and cleaned at ingest
  (WATCH:/prefix stripping, trailing "- WATCH" removal — cache v7).
- The story page structurally delivers the title: same headline, same summary,
  plus the left/centre/right comparison — title↔content parity by construction.

House style for AI-fixed titles:
1. Say what happened, to whom, where — facts only.
2. When outlets frame it differently, pick the neutral factual core.
3. ~60–90 characters; full sentence or clean noun phrase; no trailing ellipsis.

## E-E-A-T — why a comparison site passes review

- **Experience**: the product itself IS the demonstration — every story shows
  the outlets side by side.
- **Expertise**: source ratings (left/centre/right leanings) are documented per
  outlet in `src/lib/source-ratings.ts`.
- **Authoritativeness**: `NewsMediaOrganization` + `NewsArticle` JSON-LD, real
  outlet attribution with outbound `isBasedOn` links on every story.
- **Trust**: privacy policy, no paywalls, no dark patterns; topics archived so
  links never rot.

## Freshness

- Discover favours content published within the last hours-to-days.
- `/news-sitemap.xml` filters to the **last 48 hours** automatically.
- The cron refresh keeps feeds ≤30 min stale — nothing to do manually.
- Consistency beats bursts: the steady trickle of new stories (already the
  app's rhythm) trains the recrawl cadence.
