import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";
import { ErrorBoundary } from "@/components/error-boundary";
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
  title: "NeutralWire — Compare News Bias Across Sources",
  description:
    "A free, open news aggregator that compares how left, center, and right outlets cover the same stories. Auto-detects your country for relevant local + world news. Built with public RSS feeds — no API keys, no paywalls.",
  keywords: ["news", "bias", "media bias", "neutralwire", "news aggregator", "left right center"],
  authors: [{ name: "NeutralWire" }],
  manifest: "/manifest.json",
  // Google Search Console verification
  verification: {
    google: "0i1WWZTYihBkJCw9G-oKv_H-C1uA-c0hGlOgZKyhlig",
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
    title: "NeutralWire",
    description: "Compare how left, center, and right outlets cover the same stories.",
    type: "website",
    siteName: "NeutralWire",
  },
  // Canonical URL: tells search engines that neutralwire.org is the
  // primary domain (not neutralwire.vercel.app). Combined with metadataBase,
  // this produces <link rel="canonical" href="https://neutralwire.org/">.
  alternates: {
    canonical: "/",
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
        {/* iOS PWA: allow standalone display + push notifications */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        {/* ── Performance: preconnect to key external domains ── */}
        {/* Firebase RTDB — used for news cache, summaries, device data */}
        <link rel="preconnect" href="https://neutralwire-2f24e-default-rtdb.europe-west1.firebasedatabase.app" />
        <link rel="dns-prefetch" href="https://neutralwire-2f24e-default-rtdb.europe-west1.firebasedatabase.app" />
        {/* Major image CDNs — preconnect so image proxy fetches are faster */}
        <link rel="dns-prefetch" href="https://ichef.bbci.co.uk" />
        <link rel="dns-prefetch" href="https://static01.nyt.com" />
        <link rel="dns-prefetch" href="https://i.guim.co.uk" />
        <link rel="dns-prefetch" href="https://s.france24.com" />
        <link rel="dns-prefetch" href="https://static.independent.co.uk" />
        <link rel="dns-prefetch" href="https://www.japantimes.co.jp" />
        {/* Preload the news API — the FIRST request the page makes. This
            starts the fetch before the JS bundle finishes parsing. */}
        <link rel="preload" as="fetch" href="/api/news?category=relevant&limit=24&minCoverage=1" crossOrigin="anonymous" />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
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
        {/* Vercel Analytics — page view tracking */}
        <Analytics />
      </body>
    </html>
  );
}
