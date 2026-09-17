# NeutralWire

**Left / centre / right news aggregation PWA — see how every outlet spins the same story.**

NeutralWire clusters the day's news into stories and shows, for each one, how
left-leaning, centre and right-leaning outlets are covering it — side by side,
with a lean distribution bar. Free, no paywalls, auto-detects the visitor's
country. Live at **https://neutralwire.org**.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · shadcn/ui ·
Framer Motion · Firebase RTDB (REST + ETag conditional reads) · GDELT + RSS
aggregation · Web Push · PWA · P2P mesh relay (experimental) · Vercel

## Growth: the Google Discover programme

The repo ships a complete Discover readiness surface:

| Capability | Where |
|---|---|
| `max-image-preview:large` gate | `src/app/layout.tsx` |
| Crawlable story pages + `NewsArticle` JSON-LD | `src/app/story/[id]/page.tsx` |
| News sitemap (≤48 h, image entries) | `src/app/news-sitemap.xml/route.ts` |
| RSS 2.0 feed (Publisher Center ready) | `src/app/feed.xml/route.ts` |
| Plan / resources / live readiness checks | `/debug/discover` (Discover Kit) |
| Owner-action docs & scripts | `resources/discover/` |

Everything Firebase-touching there is bandwidth-safe (the 6.2 GB lesson):
static sitemap, ETag-cached single reads, CDN `s-maxage` + response ETags.

## Operations console

`/debug` (password-gated analytics) — PWA growth, feature flags, popup
system, bug reports + "Make AI Fix", mesh relay monitor, Firebase bandwidth
panel, push diagnostics. Mobile-friendly: sticky quick-nav chips + the
Discover Kit entry card.

## Develop

```bash
bun install
bun run dev        # http://localhost:3000
bun run lint       # eslint
bunx tsc --noEmit  # types
bun run build      # production build
```

No local Firebase setup needed — the RTDB is accessed via its public REST
API (read the code under `src/lib/firebase-server.ts` for the auth model
and the ETag conditional-read cache).
