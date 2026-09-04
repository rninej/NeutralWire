import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";
import { ErrorBoundary } from "@/components/error-boundary";
import { SecretScreenRecorder } from "@/components/secret-screen-recorder";
import { GatedAnalytics } from "@/components/analytics-gated";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // metadataBase: ensures all relative URLs in metadata (OG images, icons,
  // canonical) resolve to absolute URLs using the production domain.
  // Required for correct OG link previews on WhatsApp/Twitter/etc when
  // shared from neutralwire.org.
  metadataBase: new URL("https://neutralwire.org"),
  title: "NeutralWire — See How Every Outlet Spins the Same Story",
  description:
    "Is your news feeding you the full picture? NeutralWire compares how left, right, and center outlets cover the SAME story — side by side. See the bias, spot the spin, decide for yourself. Free, no paywalls, auto-detects your country. Try it before your next headline.",
  keywords: ["news", "bias", "media bias", "neutralwire", "news aggregator", "left right center", "unbiased news", "compare news"],
  authors: [{ name: "NeutralWire" }],
  // NOTE: no `manifest` here — the <head> renders the manifest <link>
  // manually with suppressHydrationWarning, because the launch-gate script
  // rewrites its href (dark ↔ light manifest) pre-hydration. Defining it
  // here too would render a SECOND unsuppressed link that fires a
  // hydration attribute-mismatch warning for light-theme users.
  // Google Search Console verification (updated for neutralwire.org domain)
  verification: {
    google: "szdK3fkYGRu3DqBfWpi6i3JpPLhqFZUx8I22qqGSQJA",
  },
  icons: {
    icon: [
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
    shortcut: "/favicon-32.png",
  },
  appleWebApp: {
    capable: true,
    // "black" (not "default") — the status bar must be dark to match the
    // dark OS launch screen (manifest background_color #0a0a0a + the
    // apple-touch-startup-image set). "default" would flash a white bar
    // over the dark launch. Content still starts BELOW the bar (no
    // overlap, unlike black-translucent), so the layout is unaffected.
    statusBarStyle: "black",
    title: "NeutralWire",
  },
  openGraph: {
    title: "NeutralWire — See How Every Outlet Spins the Same Story",
    description: "Is your news feeding you the full picture? Compare how left, right, and center outlets cover the SAME story — side by side. See the bias, spot the spin, decide for yourself.",
    type: "website",
    siteName: "NeutralWire",
  },
  // Canonical URL: tells search engines that neutralwire.org is the
  // primary domain (not neutralwire.vercel.app). Combined with metadataBase,
  // this produces <link rel="canonical" href="https://neutralwire.org/">.
  alternates: {
    canonical: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "NeutralWire — See How Every Outlet Spins the Same Story",
    description: "Is your news feeding you the full picture? Compare how left, right, and center outlets cover the SAME story — side by side. See the bias, spot the spin.",
  },
};

export const viewport: Viewport = {
  // theme-color follows the SYSTEM colour scheme (the browser can't see the
  // in-app theme choice before JS runs). For the installed PWA the Android
  // title bar comes from the manifest, which the launch-gate script swaps
  // per the user's actual theme (see the head script below).
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: true,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* The PWA manifest. Rendered manually (NOT via metadata.manifest)
            with suppressHydrationWarning: the launch-gate script below
            swaps this href to /manifest-light.json pre-paint for light
            users (and theme-families.ts re-syncs it on every theme
            change), so the attribute legitimately differs between the
            server render and hydration. */}
        <link rel="manifest" href="/manifest.json" suppressHydrationWarning />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black" />
        <meta name="apple-mobile-web-app-title" content="NeutralWire" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        {/* ── iOS PWA launch screens (apple-touch-startup-image) ──
            iOS ignores the manifest's background_color for the home-screen
            launch screen — without these it shows a plain WHITE screen for a
            beat before the first paint. Each link matches a device via its
            media query; the PNGs are static frames of the splash (corner
            glows + wordmark + tri-color bar + tagline) at physical pixel
            sizes, generated by scripts/generate-startup-images.js.
            THEME-AWARE (v26): TWO sets exist — the classic dark frames and
            a light set (white bg, dark wordmark, softer orbs) under
            /apple-launch/light/. Every device's media query is qualified
            with (prefers-color-scheme: dark|light), so the OS launch image
            follows the DEVICE colour scheme. iOS can't read the in-app
            theme (localStorage) before the page loads, so the OS frame is
            the neutral per-scheme match; the in-app splash below then
            renders in the user's EXACT family+mode from the webview's
            first frame. iOS launch becomes: static frame (system scheme)
            → themed animated splash → app. */}
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-640x1136.png" media="(device-width: 320px) and (device-height: 568px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-750x1334.png" media="(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-1125x2436.png" media="(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-1170x2532.png" media="(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-1179x2556.png" media="(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-1206x2622.png" media="(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-1242x2208.png" media="(device-width: 414px) and (device-height: 736px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-828x1792.png" media="(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-1242x2688.png" media="(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-1284x2778.png" media="(device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-1290x2796.png" media="(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-1320x2868.png" media="(device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-1536x2048.png" media="(device-width: 768px) and (device-height: 1024px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-2048x1536.png" media="(device-width: 1024px) and (device-height: 768px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-1620x2160.png" media="(device-width: 810px) and (device-height: 1080px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-2160x1620.png" media="(device-width: 1080px) and (device-height: 810px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-1640x2360.png" media="(device-width: 820px) and (device-height: 1180px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-2360x1640.png" media="(device-width: 1180px) and (device-height: 820px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-1668x2224.png" media="(device-width: 834px) and (device-height: 1112px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-2224x1668.png" media="(device-width: 1112px) and (device-height: 834px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-1668x2388.png" media="(device-width: 834px) and (device-height: 1194px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-2388x1668.png" media="(device-width: 1194px) and (device-height: 834px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-1488x2266.png" media="(device-width: 744px) and (device-height: 1133px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-2266x1488.png" media="(device-width: 1133px) and (device-height: 744px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-2048x2732.png" media="(device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/startup-2732x2048.png" media="(device-width: 1366px) and (device-height: 1024px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape) and (prefers-color-scheme: dark)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-640x1136.png" media="(device-width: 320px) and (device-height: 568px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-750x1334.png" media="(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-1125x2436.png" media="(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-1170x2532.png" media="(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-1179x2556.png" media="(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-1206x2622.png" media="(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-1242x2208.png" media="(device-width: 414px) and (device-height: 736px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-828x1792.png" media="(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-1242x2688.png" media="(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-1284x2778.png" media="(device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-1290x2796.png" media="(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-1320x2868.png" media="(device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-1536x2048.png" media="(device-width: 768px) and (device-height: 1024px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-2048x1536.png" media="(device-width: 1024px) and (device-height: 768px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-1620x2160.png" media="(device-width: 810px) and (device-height: 1080px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-2160x1620.png" media="(device-width: 1080px) and (device-height: 810px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-1640x2360.png" media="(device-width: 820px) and (device-height: 1180px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-2360x1640.png" media="(device-width: 1180px) and (device-height: 820px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-1668x2224.png" media="(device-width: 834px) and (device-height: 1112px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-2224x1668.png" media="(device-width: 1112px) and (device-height: 834px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-1668x2388.png" media="(device-width: 834px) and (device-height: 1194px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-2388x1668.png" media="(device-width: 1194px) and (device-height: 834px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-1488x2266.png" media="(device-width: 744px) and (device-height: 1133px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-2266x1488.png" media="(device-width: 1133px) and (device-height: 744px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-2048x2732.png" media="(device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait) and (prefers-color-scheme: light)" />
        <link rel="apple-touch-startup-image" href="/apple-launch/light/startup-2732x2048.png" media="(device-width: 1366px) and (device-height: 1024px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape) and (prefers-color-scheme: light)" />
        {/* Google Search Console verification — also set via metadata.verification
            above, but duplicated here as a direct meta tag to guarantee it's
            always present in the HTML (Next.js metadata API merging can
            sometimes not include verification when generateMetadata in
            page.tsx returns its own metadata object). */}
        <meta name="google-site-verification" content="szdK3fkYGRu3DqBfWpi6i3JpPLhqFZUx8I22qqGSQJA" />
        {/* iOS PWA: allow standalone display + push notifications */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        {/* ── Performance: preconnect to key external domains ── */}
        {/* Firebase RTDB — used for news cache, summaries, device data.
            preconnect warms the TLS connection so the first Firebase read
            is ~200ms faster (no DNS + TCP + TLS handshake delay). */}
        <link rel="preconnect" href="https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app" />
        <link rel="dns-prefetch" href="https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app" />
        {/* ipwho.is — client-side country detection fires on EVERY page load;
            preconnecting removes DNS+TLS from its critical path. */}
        <link rel="preconnect" href="https://ipwho.is" />
        <link rel="dns-prefetch" href="https://ipwho.is" />
        {/* Major image CDNs — preconnect so image proxy fetches are faster */}
        <link rel="dns-prefetch" href="https://ichef.bbci.co.uk" />
        <link rel="dns-prefetch" href="https://static01.nyt.com" />
        <link rel="dns-prefetch" href="https://i.guim.co.uk" />
        <link rel="dns-prefetch" href="https://s.france24.com" />
        <link rel="dns-prefetch" href="https://static.independent.co.uk" />
        <link rel="dns-prefetch" href="https://www.japantimes.co.jp" />
        {/* ── Preload the news API — the FIRST request the page makes ──
            Starts the fetch before the JS bundle finishes parsing. With
            SWR caching in the SW, this means the cached response is served
            INSTANTLY on repeat visits, and the fresh fetch starts in
            parallel. fetchpriority="high" tells the browser this is the
            most important resource to fetch.
            NOTE: the param ORDER exactly matches the URLSearchParams order
            the client builds (category, limit, slim, minCoverage) — the
            preload and the real fetch must be the SAME URL string or the
            browser fetches it twice. */}
        <link rel="preload" as="fetch" href="/api/news?category=relevant&limit=24&slim=1&minCoverage=1" crossOrigin="anonymous" fetchPriority="high" />
        {/* Preload the icon — used in the header, shown immediately on load */}
        <link rel="preload" as="image" href="/icon-192.png" fetchPriority="high" />
        {/* ── PWA launch gate + splash THEME resolver ──
            Runs synchronously in <head>, BEFORE the first paint, so both
            decisions are made before the splash element even renders.
            (a) GATE — the splash plays ONLY when the app is FRESHLY OPENED
            as an installed PWA:
              • display-mode standalone (or minimal-ui) — i.e. launched from
                the home screen / app drawer, NOT a normal browser tab. The
                website NEVER shows the animation.
              • NavigationTiming type === 'navigate' — a FRESH document load.
                Pull-to-refresh, F5, location.reload() and the service-
                worker-update reload are all type 'reload', and back/forward
                returns are 'back_forward' — none of them replay the splash.
            When both pass, the script adds `nw-launch` to <html>; the
            inlined splash CSS below only renders #nw-splash under that
            class.
            (b) THEME — resolve the user's theme family + mode from the
            SAME localStorage keys the theme system uses
            (neutralwire:theme-family / neutralwire:theme-mode, with the
            legacy neutralwire:theme next-themes key as fallback), then add
            `nw-splash-<family>` + `nw-splash-light|dark` classes to <html>.
            The splash palette CSS below keys off those classes, so the
            launch animation renders in the EXACT theme the user picked —
            light mode gets a light splash, every family gets its own
            colours — resolved before the first paint, zero flash.
            It also points <link rel="manifest"> at /manifest-light.json
            for light users so Chrome's Android launch screen + title bar
            follow the theme on the next launch (theme-families.ts
            re-syncs it on every theme change).
            <html> already carries suppressHydrationWarning, so the
            pre-hydration class mutations are hydration-safe. The
            nw-splash-* classes are NOT in next-themes' theme list, so its
            pre-hydration script never strips them.
            window.__NW_LAUNCH exposes the decision for
            debugging/testing. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var standalone=false;try{standalone=window.matchMedia('(display-mode: standalone)').matches||window.matchMedia('(display-mode: minimal-ui)').matches}catch(e){}var navType='navigate';try{var navs=performance.getEntriesByType('navigation');if(navs&&navs.length&&navs[0].type)navType=navs[0].type}catch(e){}var playing=standalone&&navType==='navigate';window.__NW_LAUNCH={standalone:standalone,navType:navType,playing:playing};if(playing){document.documentElement.classList.add('nw-launch')}var F=['neutral','midnight','sepia','high-contrast','ocean','forest','sunset','lavender','rose','mono','cyber'],family='neutral',mode='auto';try{var f=localStorage.getItem('neutralwire:theme-family');if(f&&F.indexOf(f)>-1)family=f;var m=localStorage.getItem('neutralwire:theme-mode');if(m==='light'||m==='dark'||m==='auto')mode=m;if(!f||F.indexOf(f)<0){var t=localStorage.getItem('neutralwire:theme');if(t==='light'||t==='dark')mode=t;else if(t==='system')mode='auto';else if(t){var RV={'midnight':['midnight','dark'],'midnight-light':['midnight','light'],'sepia':['sepia','light'],'sepia-dark':['sepia','dark'],'high-contrast':['high-contrast','light'],'high-contrast-dark':['high-contrast','dark'],'ocean':['ocean','dark'],'ocean-light':['ocean','light'],'forest':['forest','dark'],'forest-light':['forest','light'],'sunset':['sunset','dark'],'sunset-light':['sunset','light'],'lavender':['lavender','dark'],'lavender-light':['lavender','light'],'rose':['rose','dark'],'rose-light':['rose','light'],'mono':['mono','dark'],'mono-light':['mono','light'],'cyber':['cyber','dark'],'cyber-light':['cyber','light']};var r=RV[t];if(r){family=r[0];mode=r[1]}}}}catch(e){}var dark=mode==='dark'||(mode!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);try{document.documentElement.classList.add('nw-splash-'+family);document.documentElement.classList.add(dark?'nw-splash-dark':'nw-splash-light');window.__NW_LAUNCH.theme={family:family,mode:mode,dark:dark}}catch(e){}if(!dark){try{var ls=document.querySelectorAll('link[rel="manifest"]');for(var i=0;i<ls.length;i++)ls[i].setAttribute('href','/manifest-light.json')}catch(e){}}}catch(e){}})();`,
          }}
        />
        {/* ── PWA launch splash — full-screen tri-color animation ──
            Critical CSS, inlined so it paints with the very first HTML
            byte (no waiting for the CSS bundle). REPLACES the previous
            minimal icon splash — this is the one and only launch
            animation (nothing plays after it).

            PWA-ONLY + FRESH-OPEN-ONLY (see the launch-gate script above):
            the base rule keeps #nw-splash display:none — it only becomes
            display:flex under html.nw-launch, which the gate script sets
            exclusively for a freshly opened installed PWA. Browser tabs
            and in-app reloads (pull-to-refresh, SW-update reload, F5) and
            back/forward navigations never see it.

            The design uses NeutralWire's 3 spectrum colors — blue (left),
            grey (center), red (right):
              • Two large soft orbs (blue top-left, red bottom-right) tint
                the FULL screen and breathe in.
              • The wordmark rises in while the tri-color bar CONVERGES:
                the blue segment slides in from the left, the red segment
                from the right, and the grey center expands — they snap
                together into the balanced bias bar that is the brand.

            ADAPTIVE + LOOPING (v25): the entrance is no longer a one-shot
            that finishes and freezes into a static frame (the "it is just
            an image" report — the whole sequence could finish while the OS
            launch image still covered the webview, leaving a frozen frame
            for the rest of the load). The full brand sequence now LOOPS
            every 2.8s: orbs + wordmark + tri-color bar converge (~0.4s),
            hold with the specular light sweeping the bar + a soft orb
            breathe (~1.8s), gentle dissolve + rewind (~0.5s), replay.
            Whatever the OS launch screen does, when it lifts there is
            ALWAYS motion on screen, and the sweep reads as "loading"
            rather than "frozen". The minimum brand beat is 1100ms so even
            a fully-cached instant load still shows the complete entrance.
            The splash still retires only when the inline controller below
            adds `nw-release` to <html> — the app calls
            window.__NW_LAUNCH.ready() (page-client fires it the moment the
            first feed content is rendered) — or at a 2.6s hard cap so a
            slow connection can never trap the user. Result: the splash
            fades straight into a fully loaded feed — no skeleton flash.
            After the reveal's cross-fade completes, the controller also
            adds `nw-settled` (800ms later) which clears the
            nw-app-reveal animation — a FILLED transform animation on
            #nw-app-root otherwise leaves an identity matrix on it that
            breaks touch scrolling inside fixed-position overlays (the
            "can't swipe down in an article" bug).

            THEME-AWARE (v26): the launch sequence renders in the theme the
            user actually picked — light mode gets a light splash, and every
            theme family (midnight, sepia, ocean, … × light/dark) gets its
            own palette. The gate script above resolves family+mode from
            localStorage pre-paint and adds nw-splash-<family> +
            nw-splash-light|dark to <html>; the palette rules below map
            those to the SAME background/foreground/muted tokens the app's
            theme classes define in globals.css. Because the splash bg is
            literally the app's --background, the release cross-fade is
            pixel-perfect — no colour jump between splash and app. The
            blue/red orbs keep the brand colours at a softer alpha on light
            surfaces; the bias-bar segments stay brand blue/grey/red in
            every theme. The OS launch screens around it are neutral
            per colour scheme (dark/white manifests, prefers-color-scheme
            iOS startup images) — the webview hands off into the themed
            splash within the first frame it controls.
            HYDRATION-SAFE BY DESIGN: the splash element itself is 100% CSS
            and React never mutates it. The only DOM writes are CLASS
            additions on <html> (nw-launch + nw-splash-* pre-hydration by
            the gate script, nw-release post-hydration by the controller) —
            <html> carries suppressHydrationWarning AND is rendered by the
            server-only root layout, so React never re-renders it. The
            out-animation keeps animation-fill-mode: forwards, so once
            faded the layer stays retired (opacity 0, visibility hidden)
            and nothing can re-show it. */}
        <style
          dangerouslySetInnerHTML={{
            __html: `
/* Splash palette — neutral dark defaults (identical to the old fixed
   design), neutral-light override, then per-family×mode palettes mirroring
   the --background/--foreground/--muted-foreground tokens of each theme
   class in globals.css. Higher-specificity family rules win over both. */
html{--nw-sp-bg:#0a0a0a;--nw-sp-fg:#fafafa;--nw-sp-sub:#a1a1a1;--nw-sp-orb-b:.38;--nw-sp-orb-r:.34;--nw-sp-track:.16}
html.nw-splash-light{--nw-sp-bg:#ffffff;--nw-sp-fg:#0a0a0a;--nw-sp-sub:#737373;--nw-sp-orb-b:.26;--nw-sp-orb-r:.22;--nw-sp-track:.24}
html.nw-splash-midnight.nw-splash-dark{--nw-sp-bg:oklch(.16 .025 250);--nw-sp-fg:oklch(.94 .012 240);--nw-sp-sub:oklch(.72 .02 240)}
html.nw-splash-midnight.nw-splash-light{--nw-sp-bg:oklch(.965 .012 240);--nw-sp-fg:oklch(.27 .035 250);--nw-sp-sub:oklch(.5 .03 250)}
html.nw-splash-sepia.nw-splash-dark{--nw-sp-bg:oklch(.24 .015 55);--nw-sp-fg:oklch(.87 .03 70);--nw-sp-sub:oklch(.66 .04 60)}
html.nw-splash-sepia.nw-splash-light{--nw-sp-bg:oklch(.94 .025 75);--nw-sp-fg:oklch(.3 .03 50);--nw-sp-sub:oklch(.5 .03 50)}
html.nw-splash-high-contrast.nw-splash-dark{--nw-sp-bg:#000;--nw-sp-fg:#fff;--nw-sp-sub:oklch(.85 0 0)}
html.nw-splash-high-contrast.nw-splash-light{--nw-sp-bg:#fff;--nw-sp-fg:#000;--nw-sp-sub:oklch(.2 0 0)}
html.nw-splash-ocean.nw-splash-dark{--nw-sp-bg:oklch(.21 .04 220);--nw-sp-fg:oklch(.92 .02 200);--nw-sp-sub:oklch(.65 .03 200)}
html.nw-splash-ocean.nw-splash-light{--nw-sp-bg:oklch(.965 .02 200);--nw-sp-fg:oklch(.3 .05 220);--nw-sp-sub:oklch(.5 .05 210)}
html.nw-splash-forest.nw-splash-dark{--nw-sp-bg:oklch(.2 .03 150);--nw-sp-fg:oklch(.9 .03 140);--nw-sp-sub:oklch(.62 .03 140)}
html.nw-splash-forest.nw-splash-light{--nw-sp-bg:oklch(.965 .02 145);--nw-sp-fg:oklch(.28 .04 150);--nw-sp-sub:oklch(.48 .04 148)}
html.nw-splash-sunset.nw-splash-dark{--nw-sp-bg:oklch(.25 .04 30);--nw-sp-fg:oklch(.93 .02 40);--nw-sp-sub:oklch(.65 .03 40)}
html.nw-splash-sunset.nw-splash-light{--nw-sp-bg:oklch(.965 .025 55);--nw-sp-fg:oklch(.3 .05 30);--nw-sp-sub:oklch(.5 .05 35)}
html.nw-splash-lavender.nw-splash-dark{--nw-sp-bg:oklch(.28 .03 300);--nw-sp-fg:oklch(.92 .02 300);--nw-sp-sub:oklch(.65 .03 300)}
html.nw-splash-lavender.nw-splash-light{--nw-sp-bg:oklch(.965 .02 300);--nw-sp-fg:oklch(.3 .05 300);--nw-sp-sub:oklch(.5 .05 300)}
html.nw-splash-rose.nw-splash-dark{--nw-sp-bg:oklch(.25 .03 15);--nw-sp-fg:oklch(.93 .02 15);--nw-sp-sub:oklch(.65 .03 15)}
html.nw-splash-rose.nw-splash-light{--nw-sp-bg:oklch(.965 .018 15);--nw-sp-fg:oklch(.32 .05 15);--nw-sp-sub:oklch(.52 .05 15)}
html.nw-splash-mono.nw-splash-dark{--nw-sp-bg:oklch(.22 0 0);--nw-sp-fg:oklch(.9 0 0);--nw-sp-sub:oklch(.6 0 0)}
html.nw-splash-mono.nw-splash-light{--nw-sp-bg:oklch(.955 0 0);--nw-sp-fg:oklch(.25 0 0);--nw-sp-sub:oklch(.47 0 0)}
html.nw-splash-cyber.nw-splash-dark{--nw-sp-bg:oklch(.15 .02 150);--nw-sp-fg:oklch(.85 .15 150);--nw-sp-sub:oklch(.55 .1 150)}
html.nw-splash-cyber.nw-splash-light{--nw-sp-bg:oklch(.97 .01 150);--nw-sp-fg:oklch(.24 .03 150);--nw-sp-sub:oklch(.45 .06 150)}
#nw-splash{position:fixed;inset:0;z-index:9999;display:none;overflow:hidden;background:var(--nw-sp-bg,#0a0a0a);color:var(--nw-sp-fg,#ececec);pointer-events:none}
html.nw-launch #nw-splash{display:flex;align-items:center;justify-content:center}
html.nw-release #nw-splash{animation:nw-splash-out .18s ease .05s forwards}
#nw-splash .nw-sp-orb{position:absolute;width:62vmax;height:62vmax;border-radius:50%;filter:blur(52px);opacity:0;animation:nw-sp-orb 2.8s ease-in-out infinite}
#nw-splash .nw-sp-orb-b{top:-18vmax;left:-16vmax;background:radial-gradient(circle at 35% 35%,rgb(59 130 246/var(--nw-sp-orb-b,.38)),rgb(59 130 246/0) 68%)}
#nw-splash .nw-sp-orb-r{bottom:-18vmax;right:-16vmax;background:radial-gradient(circle at 65% 65%,rgb(239 68 68/var(--nw-sp-orb-r,.34)),rgb(239 68 68/0) 68%)}
#nw-splash .nw-sp-wrap{position:relative;display:flex;flex-direction:column;align-items:center;gap:16px;transform:translateZ(0)}
#nw-splash .nw-sp-word{font-family:var(--font-geist-sans),system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:26px;font-weight:800;letter-spacing:.01em;animation:nw-sp-word 2.8s cubic-bezier(.16,1,.3,1) infinite}
#nw-splash .nw-sp-bar{position:relative;display:flex;width:min(62vw,300px);height:12px;border-radius:99px;overflow:hidden;background:rgb(127 127 127/var(--nw-sp-track,.16))}
#nw-splash .nw-sp-bar::after{content:'';position:absolute;inset:0;background:linear-gradient(100deg,rgba(255,255,255,0) 30%,rgba(255,255,255,.24) 50%,rgba(255,255,255,0) 70%);transform:translateX(-130%);animation:nw-sp-sweep 1.15s cubic-bezier(.4,0,.2,1) .45s infinite}
#nw-splash .nw-seg{display:block;height:100%;transform:translateZ(0)}
#nw-splash .nw-seg-b{width:37%;background:#3b82f6;border-radius:99px 0 0 99px;animation:nw-seg-left 2.8s cubic-bezier(.18,.89,.32,1.08) infinite}
#nw-splash .nw-seg-g{width:26%;background:#a1a1a1;transform-origin:50% 50%;animation:nw-seg-grow 2.8s cubic-bezier(.16,1,.3,1) infinite}
#nw-splash .nw-seg-r{width:37%;background:#ef4444;border-radius:0 99px 99px 0;animation:nw-seg-right 2.8s cubic-bezier(.18,.89,.32,1.08) infinite}
#nw-splash .nw-sp-tag{font-family:var(--font-geist-sans),system-ui,sans-serif;font-size:11px;font-weight:600;letter-spacing:.24em;text-transform:uppercase;opacity:0;color:var(--nw-sp-sub,#9a9a9a);animation:nw-sp-tag 2.8s ease infinite}
@keyframes nw-splash-out{to{opacity:0;visibility:hidden}}
@keyframes nw-sp-sweep{to{transform:translateX(130%)}}
@keyframes nw-sp-orb{0%{opacity:0;transform:scale(.85)}6%{opacity:1;transform:scale(1)}42%{transform:scale(1.035)}78%{opacity:1;transform:scale(1)}88%{opacity:0;transform:scale(1.05)}100%{opacity:0;transform:scale(.85)}}
@keyframes nw-sp-word{0%{opacity:0;transform:translateY(10px)}9%{opacity:1;transform:none}78%{opacity:1;transform:none}88%{opacity:0;transform:translateY(8px)}100%{opacity:0;transform:translateY(10px)}}
@keyframes nw-seg-left{0%{transform:translateX(-180%)}15%{transform:translateX(0)}80%{transform:translateX(0)}93%{transform:translateX(-180%)}100%{transform:translateX(-180%)}}
@keyframes nw-seg-right{0%{transform:translateX(180%)}15%{transform:translateX(0)}80%{transform:translateX(0)}93%{transform:translateX(180%)}100%{transform:translateX(180%)}}
@keyframes nw-seg-grow{0%{transform:scaleX(0)}15%{transform:scaleX(1)}80%{transform:scaleX(1)}93%{transform:scaleX(0)}100%{transform:scaleX(0)}}
@keyframes nw-sp-tag{0%{opacity:0;transform:translateY(4px)}12%{opacity:1;transform:none}78%{opacity:1;transform:none}87%{opacity:0;transform:translateY(4px)}100%{opacity:0;transform:translateY(4px)}}
@media (prefers-reduced-motion:reduce){#nw-splash .nw-sp-orb,#nw-splash .nw-sp-word,#nw-splash .nw-seg,#nw-splash .nw-sp-tag{animation:none}#nw-splash .nw-sp-orb{opacity:.5}#nw-splash .nw-sp-word,#nw-splash .nw-sp-tag{opacity:1}#nw-splash .nw-seg-g{transform:none}#nw-splash .nw-sp-bar::after{display:none}}
            `,
          }}
        />
        {/* ── Adaptive splash controller ──
            Tiny inline script that owns the splash LIFECYCLE (see the CSS
            comment above). It only runs when the launch gate actually
            played the splash (window.__NW_LAUNCH.playing). Exposes
            window.__NW_LAUNCH.ready() — page-client calls it once the first
            feed content has rendered — and releases the splash when BOTH
            the minimum brand beat (1100ms — long enough for the full
            looping entrance to be perceived) has elapsed AND the app is
            ready, with a 2.6s hard cap for slow networks (then the feed's
            own skeleton loader takes over, as before).
            Release = add the `nw-release` class to <html> (the CSS above
            fades the layer out and retires it). The release runs inside a
            double requestAnimationFrame so the freshly-rendered feed has
            actually been PAINTED before the splash starts fading — the
            user never glimpses an unpainted frame.
            Belt-and-braces: page-client also force-releases after 5s in
            case this script ever fails. All wrapped in try/catch so it can
            never take the page down. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var L=window.__NW_LAUNCH;if(!L||!L.playing)return;var MIN=1100,MAX=2600,t0=performance.now(),released=false,ready=false;function release(){if(released)return;released=true;try{L.released=true;L.reason=ready?'ready':'timeout';document.documentElement.classList.add('nw-release');setTimeout(function(){try{document.documentElement.classList.add('nw-settled')}catch(e){}},800)}catch(e){}}function afterPaint(fn){try{requestAnimationFrame(function(){requestAnimationFrame(fn)})}catch(e){fn()}}function schedule(){if(released)return;var w=MIN-(performance.now()-t0);if(w>0)setTimeout(function(){afterPaint(release)},w);else afterPaint(release)}L.ready=function(){if(ready||released)return;ready=true;schedule()};setTimeout(function(){if(!released)release()},MAX)}catch(e){}})();`,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {/* ── PWA launch splash — full-screen tri-color animation ──
            Server-rendered (identical HTML for everyone → hydration is a
            no-op) but INVISIBLE by default: the CSS only displays it under
            html.nw-launch, which the head launch-gate script sets strictly
            when the app is freshly opened as an installed PWA — never in a
            browser tab, never on pull-to-refresh/reload/back-forward.
            When it does play, the PWA opens straight into the branded
            animation instead of a white screen: blue slides in from the
            left, red from the right, grey expands from the center — the
            three converge into the NeutralWire bias bar over large tinted
            screen orbs. The whole sequence renders in the user's chosen
            theme (the head gate script adds nw-splash-<family> +
            nw-splash-light|dark to <html> pre-paint; the palette rules in
            the head CSS drive every colour except the brand bar/orbs).
            ADAPTIVE (v24): the entrance plays in ~380ms, then the layer
            HOLDS (a soft light sweeps across the bar — see the head CSS)
            until the head controller adds html.nw-release: page-client
            calls window.__NW_LAUNCH.ready() when the first feed content
            has rendered, so the splash fades (180ms, fill-mode forwards
            → opacity 0 / visibility hidden, retired forever) straight
            into a fully loaded page. 560ms minimum brand beat, 2.6s hard
            cap, 5s app-side safety net — a slow network falls back to the
            feed skeleton, a normal one never shows it.
            No JS touches this element: React renders it once, the CSS
            animation handles its whole lifecycle, and nothing can re-show
            it or fight hydration. */}
        <div id="nw-splash" aria-hidden="true">
          {/* Full-screen tinted orbs — blue (left) + red (right). */}
          <div className="nw-sp-orb nw-sp-orb-b" />
          <div className="nw-sp-orb nw-sp-orb-r" />
          <div className="nw-sp-wrap">
            <div className="nw-sp-word">NeutralWire</div>
            {/* The bias bar: blue | grey | red converging into one. Plain
                <i> elements on purpose — they render identically before
                and after hydration and are driven purely by CSS. */}
            <div className="nw-sp-bar">
              <i className="nw-seg nw-seg-b" />
              <i className="nw-seg nw-seg-g" />
              <i className="nw-seg nw-seg-r" />
            </div>
            <div className="nw-sp-tag">Left · Center · Right</div>
          </div>
        </div>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
          {/* Invisible paste-triggered screen recorder (developer footage
              tool) — renders null; listens for the secretscreenrecord…
              magic words. See secret-screen-recorder.tsx. */}
          <SecretScreenRecorder />
          <Toaster />
        </ThemeProvider>
        {/* Service worker registration — required for PWA install + push notifications.
            Passes updateViaCache: 'none' so the browser ALWAYS fetches the
            latest sw.js (never a stale cached copy). Also listens for a new
            SW taking over and reloads the page so the new notification
            config (e.g. removed action buttons) takes effect immediately.
            ── v23 LOAD-TIME CHANGES ──
            1. Registration runs on requestIdleCallback (fallback: window
               load). The old 'load' listener waited for EVERY subresource
               (images, chunks) before the SW even began installing — now
               the install + precache start seconds earlier and the
               beforeinstallprompt machinery is available sooner, without
               ever competing with first paint.
            2. controllerchange no longer reloads on the FIRST takeover
               (the initial SW install claim) — that fired a pointless full
               page reload on every brand-new visitor, an entire extra
               load cycle right when we want the fastest first impression.
               Only SUBSEQUENT takeovers (real updates) reload. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                var register = function() {
                  navigator.serviceWorker.register('/sw.js', {
                    updateViaCache: 'none'  // always fetch fresh sw.js
                  }).then(
                    function(registration) {
                      // If a new SW is waiting to activate, tell it to skip
                      // waiting immediately (it already calls skipWaiting on
                      // install, but this covers the case where it's already
                      // installed but waiting). (registration can be
                      // undefined in rare contexts, e.g. browsers with
                      // service workers disabled — guard it.)
                      if (registration && registration.waiting) {
                        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
                      }
                    },
                    function(err) {
                      console.warn('[SW] registration failed:', err);
                    }
                  );
                };
                if (window.requestIdleCallback) {
                  window.requestIdleCallback(register, { timeout: 2000 });
                } else {
                  window.addEventListener('load', register);
                }

                // Reload when a new SW takes over — but NEVER on the first
                // takeover (initial install): that reload was pure waste for
                // new visitors. After the first takeover, any subsequent
                // controllerchange is a real update → reload once.
                var hadController = !!navigator.serviceWorker.controller;
                var refreshing = false;
                navigator.serviceWorker.addEventListener('controllerchange', function() {
                  if (refreshing) return;
                  if (!hadController) {
                    hadController = true; // first takeover: just note it
                    console.log('[SW] first takeover — no reload needed');
                    return;
                  }
                  refreshing = true;
                  console.log('[SW] new controller took over — reloading');
                  window.location.reload();
                });
              }
            `,
          }}
        />
        {/* ── Firebase download tracker (DEV ONLY) ──
            Polls /api/fb-stats and logs Firebase download sizes to the
            browser console. This is a DEVELOPMENT TOOL — in production it
            was causing ~120 serverless invocations/hour per active user
            (every 30s polling), which:
              - Burned Vercel Fluid Compute CPU (4h/month limit)
              - Burned Function Invocations (104K/1M limit)
              - Each poll was a cold function call (~50ms CPU)

            Now gated behind a `?debug=fb` URL param OR
            `localStorage.debug_fb = 1`. Default: does NOT poll at all
            in production, saving ~120 invocations/hour per user. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                // Only run if explicitly enabled via URL param or localStorage
                var enabled = false;
                try {
                  if (window.location.search.indexOf('debug=fb') !== -1) {
                    enabled = true;
                    try { localStorage.setItem('debug_fb', '1'); } catch (e) {}
                  } else if (localStorage.getItem('debug_fb') === '1') {
                    enabled = true;
                  }
                } catch (e) {}

                if (!enabled) return;

                var sessionTotal = 0;
                var lastSessionId = null;
                var lastInstanceBytes = 0;

                function formatBytes(bytes) {
                  if (bytes < 1024) return bytes + ' B';
                  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
                  return (bytes / 1048576).toFixed(2) + ' MB';
                }

                function poll() {
                  fetch('/api/fb-stats', { cache: 'no-store' })
                    .then(function(res) { return res.ok ? res.json() : null; })
                    .then(function(data) {
                      if (!data) return;
                      if (data.sessionId !== lastSessionId) {
                        if (lastSessionId !== null) {
                          console.log(
                            '%c[Firebase] Previous instance total: ' + formatBytes(lastInstanceBytes),
                            'color: #ff6b6b; font-weight: bold;'
                          );
                        }
                        lastSessionId = data.sessionId;
                        lastInstanceBytes = data.sessionDownloadBytes;
                        sessionTotal += data.sessionDownloadBytes;
                      } else {
                        var delta = data.sessionDownloadBytes - lastInstanceBytes;
                        if (delta > 0) {
                          sessionTotal += delta;
                          lastInstanceBytes = data.sessionDownloadBytes;
                        }
                      }
                      console.log(
                        '%c[Firebase] Session: ' + formatBytes(sessionTotal) +
                        ' | Instance: ' + formatBytes(data.sessionDownloadBytes) +
                        ' (' + data.sessionOps + ' ops)',
                        'color: #4ecdc4; font-weight: bold;'
                      );
                      if (data.recentOps && data.recentOps.length > 0) {
                        var recent = data.recentOps.slice(-5);
                        var newOps = recent.filter(function(op) {
                          return op.ts > (window.__lastFbLogTs || 0);
                        });
                        if (newOps.length > 0) {
                          console.groupCollapsed(
                            '%c[Firebase] Last ' + newOps.length + ' reads:',
                            'color: #95e1d3;'
                          );
                          newOps.forEach(function(op) {
                            console.log(
                              op.method + ' ' + op.path + ' → ' + formatBytes(op.bytes)
                            );
                          });
                          console.groupEnd();
                          window.__lastFbLogTs = newOps[newOps.length - 1].ts;
                        }
                      }
                    })
                    .catch(function() {});
                }

                console.log(
                  '%c[Firebase Tracker] DEBUG mode active. Polling every 60s. Add ?debug=fb to enable.',
                  'color: #c44569; font-weight: bold; font-size: 14px;'
                );
                // Poll every 60 seconds (was 30s — halved to reduce invocations)
                setInterval(poll, 60000);
                setTimeout(poll, 3000);
              })();
            `,
          }}
        />
        {/* Vercel Analytics — page view tracking, cookie-consent gated
            (events are dropped until "Accept all"; see analytics-gated.tsx) */}
        <GatedAnalytics />
      </body>
    </html>
  );
}
