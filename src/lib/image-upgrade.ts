/**
 * image-upgrade.ts — ONE shared, dependency-free image-URL quality module.
 *
 * WHY THIS EXISTS (Sep 2026, the "blurry images" fix): image URLs enter
 * the system from four doors — RSS feeds, og:image scrapes, GDELT
 * socialimage fields and Bing News thumbnails — and most arrive as SMALL
 * variants (width=140, /240/, a 100×100 Bing thumb, an NYT thumbStandard).
 * Each pipeline used to upgrade only SOME of its own URLs, so premium
 * subtopic cards (whose images come mostly from Bing donors + raw pool
 * thumbnails) rendered blurry, and any topic cached with a low-res URL
 * stayed blurry forever.
 *
 * The fix is structural: this module is imported by EVERY door —
 * news-aggregator, gdelt-aggregator, custom-topics (Bing donors + pool
 * thumbnails + og scrapes), the /api/img proxy (so every ALREADY-CACHED
 * topic is upgraded at serve time — the "once and for all" net) and
 * /api/og-image (the share composite). A low-res URL can no longer reach
 * a pixel.
 *
 * Deliberately dependency-free (no Firebase, no AI imports) so the tiny
 * /api/img route can import it without dragging the aggregator along.
 */

/** Bing News thumbnails: `https://www.bing.com/th?id=…&pid=News`.
 *  Without a size param Bing serves a ~100×100 crop — hopelessly blurry
 *  on a ~600px card. The same endpoint happily renders any size, so we
 *  pin a card-friendly 600×400 (3:2, matching the card aspect) whenever
 *  the URL carries no explicit w/h. Verified live: w=600&h=400 → exactly
 *  600×400 JPEG. */
export function upgradeBingThumb(url: string): string {
  if (!url) return url
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    if (host !== 'bing.com' || !u.pathname.startsWith('/th')) return url
    if (u.searchParams.has('w') || u.searchParams.has('h')) return url
    u.searchParams.set('w', '600')
    u.searchParams.set('h', '400')
    return u.toString()
  } catch {
    return url
  }
}

/**
 * Upgrade a publisher image URL to its full-resolution variant (≥600px).
 *
 * Examples:
 *   BBC:      /ace/standard/240/...  →  /ace/standard/800/...
 *   Guardian: ?width=140             →  ?width=1200
 *   NYT:      -mediumSquareAt3X      →  -articleLarge (or keep, it's 3x)
 *   Independent: /width=1200 (already large, leave alone)
 *   France24: /w:1280/ (already large, leave alone)
 *   Telegraph: keep
 *   CNBC:     ?v=...&w=1920 (already large, leave alone)
 *   Bing:     /th?id=…&pid=News     →  &w=600&h=400 (see upgradeBingThumb)
 */
export function upgradeToHighRes(url: string): string {
  if (!url) return url
  try {
    // Bing thumbnails FIRST (the URL-object check is more precise than
    // regexes, and Bing thumbs never match the publisher patterns below).
    const bing = upgradeBingThumb(url)
    if (bing !== url) return bing

    // BBC: /ace/<variant>/<N>/cpsprodpb/... → bump N to 800
    // Also /ace/ic/<N>/ and /${N}x${N}/ variants
    if (/ichef\.bbci\.co\.uk\//.test(url)) {
      return url
        .replace(/\/ace\/(?:standard|ic)\/\d+\//, '/ace/standard/800/')
    }
    // Guardian: width=NNN → width=1200
    if (/i\.guim\.co\.uk\//.test(url)) {
      return url.replace(/([?&])width=\d+/, '$1width=1200')
    }
    // NYT: -mediumSquareAt3X.jpg is 3x (good), but -thumbStandard / -small
    // variants are tiny. Upgrade known small variants to -articleLarge.
    // (static\d* — the CDNs are static01, static10, …; the old \d? missed
    // the two-digit hosts entirely.)
    if (/static\d*\.nyt\.com\//.test(url)) {
      return url
        .replace(/-thumbStandard\./, '-articleLarge.')
        .replace(/-thumbLarge\./, '-articleLarge.')
        .replace(/-small\./, '-articleLarge.')
        .replace(/-mediumSquareAt3X\./, '-jumbo.') // jumbo is larger than mediumSquareAt3X
    }
    // Al Jazeera: /640/ or /240/ → /1280/
    if (/www\.aljazeera\.com\//.test(url)) {
      return url.replace(/\/(?:240|360|480|640)\//, '/1280/')
    }
    // HuffPost/NBC CDN: resize as query param
    if (/media\.cldnry\.s-nbcnews\.com\//.test(url)) {
      return url.replace(/t_nbcnews-fp-\d+x\d+/, 't_nbcnews-fp-1200x630')
    }
    // Japan Times: keep /uploads/ images as-is (already full-res)
    // Reuters/Independent/FT: already large in RSS
    return url
  } catch {
    return url
  }
}
