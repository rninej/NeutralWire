import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";
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
          {children}
          <Toaster />
        </ThemeProvider>
        {/* Service worker registration — required for PWA install + push notifications */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function() {
                  navigator.serviceWorker.register('/sw.js').then(
                    function(registration) {
                      console.log('[SW] registered:', registration.scope);
                    },
                    function(err) {
                      console.warn('[SW] registration failed:', err);
                    }
                  );
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
