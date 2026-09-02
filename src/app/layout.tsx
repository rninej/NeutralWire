import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";
import { ErrorBoundary } from "@/components/error-boundary";
import { SecretScreenRecorder } from "@/components/secret-screen-recorder";
import { Analytics } from "@vercel/analytics/next";

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
  manifest: "/manifest.json",
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
    statusBarStyle: "default",
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
  themeColor: "#0a0a0a",
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
        <link rel="manifest" href="/manifest.json" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="NeutralWire" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
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
        {/* ── PWA launch splash — critical CSS, inlined so it paints with the
            very first HTML byte (no waiting for the CSS bundle). The splash
            shows the app icon + wordmark + a shimmer bar while the app boots.
            HYDRATION-SAFE BY DESIGN: it is 100% CSS — the out-animation
            (0.3s hold + 0.15s fade, animation-fill-mode: forwards) retires
            the layer at a fixed ~450ms with ZERO JavaScript DOM mutation, so
            React never sees an attribute mismatch during hydration and
            nothing can ever re-show it. The whole animation therefore never
            lasts more than half a second, on ANY connection speed.
            prefers-color-scheme matches the pre-paint html theme class
            (default theme is "system"), so dark-mode users see a dark
            splash, not a white flash. Colors are neutral on purpose:
            custom family themes are applied client-side AFTER the splash
            is already gone. */}
        <style
          dangerouslySetInnerHTML={{
            __html: `
#nw-splash{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:#fff;color:#171717;pointer-events:none;animation:nw-splash-out .15s ease .3s forwards}
@media (prefers-color-scheme:dark){#nw-splash{background:#0a0a0a;color:#ececec}}
#nw-splash .nw-sp-wrap{display:flex;flex-direction:column;align-items:center;gap:14px;transform:translateZ(0)}
#nw-splash .nw-sp-icon{width:56px;height:56px;border-radius:14px;animation:nw-sp-pop .28s cubic-bezier(.16,1,.3,1) both}
#nw-splash .nw-sp-word{font-family:var(--font-geist-sans),system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:20px;font-weight:800;letter-spacing:.02em;animation:nw-sp-fade .3s ease both .05s}
#nw-splash .nw-sp-bar{width:120px;height:3px;border-radius:99px;overflow:hidden;background:rgba(127,127,127,.22)}
#nw-splash .nw-sp-bar i{display:block;height:100%;width:40%;border-radius:99px;background:currentColor;opacity:.55;animation:nw-sp-slide .6s ease-in-out infinite}
@keyframes nw-splash-out{to{opacity:0;visibility:hidden}}
@keyframes nw-sp-pop{from{transform:scale(.7);opacity:0}to{transform:scale(1);opacity:1}}
@keyframes nw-sp-fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes nw-sp-slide{0%{transform:translateX(-140%)}100%{transform:translateX(320%)}}
@media (prefers-reduced-motion:reduce){#nw-splash .nw-sp-icon,#nw-splash .nw-sp-word,#nw-splash .nw-sp-bar i{animation:none}#nw-splash .nw-sp-bar i{transform:translateX(60%);opacity:.35}}
            `,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {/* ── PWA launch splash (≤0.5s brand flash) ──
            Server-rendered so it paints with the first HTML — the PWA opens
            straight into branded content instead of a white screen. The
            inlined CSS above fades it out and retires it (opacity 0,
            visibility hidden, animation-fill-mode: forwards) at a FIXED
            ~450ms — 300ms hold + 150ms fade — so it never lasts more than
            half a second no matter how slow the connection is.
            NO JavaScript touches this element: React renders it once, the
            CSS animation handles its whole lifecycle, and nothing can
            re-show it or fight hydration. */}
        <div id="nw-splash" aria-hidden="true">
          <div className="nw-sp-wrap">
            {/* Plain <img> on purpose: it's preloaded in <head>, above
                React's control, and must render identically before and
                after hydration. */}
            <img className="nw-sp-icon" src="/icon-192.png" alt="" width={56} height={56} />
            <div className="nw-sp-word">NeutralWire</div>
            <div className="nw-sp-bar">
              <i />
            </div>
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
            config (e.g. removed action buttons) takes effect immediately. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function() {
                  navigator.serviceWorker.register('/sw.js', {
                    updateViaCache: 'none'  // always fetch fresh sw.js
                  }).then(
                    function(registration) {
                      console.log('[SW] registered:', registration.scope);
                      // If a new SW is waiting to activate, tell it to skip
                      // waiting immediately (it already calls skipWaiting on
                      // install, but this covers the case where it's already
                      // installed but waiting).
                      if (registration.waiting) {
                        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
                      }
                    },
                    function(err) {
                      console.warn('[SW] registration failed:', err);
                    }
                  );

                  // When a new SW takes over (controllerchange), reload the
                  // page ONCE so the new notification config applies. We use
                  // a flag to avoid reload loops.
                  var refreshing = false;
                  navigator.serviceWorker.addEventListener('controllerchange', function() {
                    if (refreshing) return;
                    refreshing = true;
                    console.log('[SW] new controller took over — reloading');
                    window.location.reload();
                  });
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
        {/* Vercel Analytics — page view tracking */}
        <Analytics />
      </body>
    </html>
  );
}
