# Google Publisher Center — submission checklist

Goal: register NeutralWire as a publication with Google (Google News / Discover
surfaces). Approval is **not** strictly required for Discover, but it strengthens
the publication identity signals Google uses for both.

**Time needed:** ~20 minutes (+ days-to-weeks review by Google).

## Before you start

- [ ] The site is live on `https://neutralwire.org` (Vercel production).
- [ ] `https://neutralwire.org/feed.xml` returns valid RSS 2.0 (open it — you
      should see `<rss version="2.0">` with NeutralWire items).
- [ ] You have the Google account that owns the Search Console property
      (verification token already lives in the site's root layout).
- [ ] Publication logo ready: **512×512 px, PNG with transparent background**,
      no small text (it is displayed at ~28 px in some surfaces). Use
      `public/icon-512.png` if nothing custom exists.
- [ ] A short "About" blurb (~300 chars) — reuse the site description.

## Step-by-step

1. **Open** <https://publishercenter.google.com/> → sign in with the owner
   account → **Add publication**.
2. **Publication details**
   - Publication name: `NeutralWire` (exactly this — matches the JSON-LD
     `NewsMediaOrganization.name` on the site).
   - Label / site: `neutralwire.org`.
   - Language: `English`.
   - Primary country: your main audience market (the app auto-detects country
     per visitor; pick the one with the most traffic).
3. **Add the RSS feed**
   - Feed URL: `https://neutralwire.org/feed.xml`
   - Category: *News* → sub-category *Politics* (or *General*).
   - Publisher Center will validate the feed — full titles, summaries, dates
     and stable GUIDs are already in place.
4. **Logo** — upload the 512×512 PNG.
5. **Publication info / About** — paste the blurb; link the privacy policy
   (`https://neutralwire.org/privacy`).
6. **Submit for review.**
   - Google checks: feed validity, site quality, basic E-E-A-T, no policy
     violations (no clickbait patterns, no misleading medical/financial claims).
   - Typical turnaround: several days to a few weeks. You'll get an email.
7. **After approval**
   - The publication appears in Google News surfaces; story eligibility for
     Discover improves via the publication identity.
   - Re-check every few weeks that `/feed.xml` stays healthy (the /debug
     Discover Kit → Readiness tab shows a live check).

## Common rejection reasons (and how NeutralWire avoids them)

| Reason | NeutralWire status |
|---|---|
| Feed empty / malformed | Full-content RSS with stable GUIDs, auto-refreshed with the news cron |
| No clear publication identity | NewsMediaOrganization JSON-LD + publisher logo + about page |
| Aggregator without added value | Every story page adds the left/centre/right comparison — the core editorial value |
| Policy issues (clickbait, deceptive) | Title cleaner strips teaser prefixes; titles come from real outlets |
| Broken story links | Topics are archived on first view — shared URLs never rot |
