# Cron wiring — keeping the Discover feeds warm (optional)

The new Discover routes are **already bandwidth-safe by design**:

| Route | Firebase cost per regeneration | CDN |
|---|---|---|
| `/sitemap.xml` | **zero** (static, force-static) | 24 h |
| `/news-sitemap.xml` | 1 room read, ETag-cached → **0 bytes when unchanged** | 15 min (`s-maxage=900`) |
| `/feed.xml` | same | 15 min |
| `/story/[id]` | 1 archive read (few KB), ETag-cached | 15 min ISR |

Because every response sets `Cache-Control: public, s-maxage=…,
stale-while-revalidate`, the Vercel edge serves Googlebot and visitors from
cache and revalidates in the background — no explicit warm-up is *required*.

## Optional: explicit warm-up after each cron refresh

If you want a fresh news-sitemap the instant the feed rotates (rather than up
to 15 min later on the first hit), append two fire-and-forget pings to the
existing cron refresh handler `src/app/api/cron/refresh-all/route.ts`:

```ts
// ── Discover feed warm-up (fire-and-forget, never blocks the response) ──
const warm = async (path: string) => {
  try {
    await fetch(`${SITE_URL}${path}?warm=1`, {
      // cache: 'no-store' so THIS warm-up request always revalidates the edge
      cache: 'no-store',
    })
  } catch { /* best-effort */ }
}
void warm('/news-sitemap.xml')
void warm('/feed.xml')
```

Notes:
- A warm-up fetch with `cache: 'no-store'` forces the edge to re-fetch the
  route once; with the ETag layer the underlying Firebase read is usually a
  zero-byte 304 — this stays cheap even at every-30-min cadence.
- Deploy-aware: `SITE_URL` should come from an env var (`VERCEL_PROJECT_PRODUCTION_URL`
  or the hard-coded `https://neutralwire.org` from `src/lib/site.ts`).
- The user-powered cron (`userCron`) and the cron-job.org backstop both end up
  in `refresh-all`, so one wiring covers both triggers.

## What NOT to do

- Do not remove the `s-maxage` cache headers "to be fresher" — that path led
  to the 6.2 GB Firebase incident. Freshness is bounded by `stale-while-revalidate`
  + the 30-min feed cadence, which is well inside Discover's tolerance.
- Do not list every story URL in `/sitemap.xml`; the news sitemap is the right
  vehicle (48 h window) and stays small.
