import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Ground News Free — Compare News Bias Across Sources",
  description:
    "A free, open news aggregator that compares how left, center, and right outlets cover the same stories. Built with public RSS feeds — no API keys, no paywalls.",
  keywords: ["news", "bias", "media bias", "ground news", "news aggregator", "left right center"],
  authors: [{ name: "Ground News Free" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "Ground News Free",
    description: "Compare how left, center, and right outlets cover the same stories.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
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
      </body>
    </html>
  );
}
