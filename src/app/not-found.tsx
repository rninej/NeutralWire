import Link from 'next/link'
import type { Metadata } from 'next'
import { SITE_NAME } from '@/lib/site'

export const metadata: Metadata = {
  title: `Story not found — ${SITE_NAME}`,
  robots: { index: false },
}

/**
 * Branded 404 — mostly reached from dead /story/<id> URLs (older stories
 * whose clusters rotated out before the Oct 2026 archive-everything fix;
 * their data is unrecoverable, so a REAL 404 status stays correct for
 * Google — this page just makes the dead end useful and on-brand for the
 * humans who land on it).
 *
 * Server component (no client JS): logo, plain explanation, and two
 * escapes — top stories + the topic search inside the live app.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center gap-2.5 px-4 py-3">
          { }
          <img
            src="/logo.svg"
            alt=""
            width={30}
            height={30}
            className="h-[30px] w-[30px] rounded-md ring-1 ring-black/10 dark:ring-white/20"
          />
          <span className="text-base font-extrabold tracking-tight">{SITE_NAME}</span>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-4 py-16 text-center">
        <div className="flex items-center gap-1.5" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full bg-blue-500" />
          <span className="h-2.5 w-2.5 rounded-full bg-zinc-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
        </div>
        <h1 className="mt-4 text-3xl font-extrabold tracking-tight">
          This story has moved on
        </h1>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
          The page you followed is from an older news cycle that has since
          rotated out. News moves fast — here is what the spectrum is
          covering right now.
        </p>
        <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-full bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition-transform hover:scale-[1.03] active:scale-95"
          >
            Read today&apos;s top stories
          </Link>
          <Link
            href="/?focus=search"
            className="inline-flex items-center justify-center rounded-full border border-border px-6 py-2.5 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
          >
            Search every story
          </Link>
        </div>
      </main>

      <footer className="border-t border-border py-6 text-center text-xs text-muted-foreground">
        {SITE_NAME} · left, centre &amp; right on every story
      </footer>
    </div>
  )
}
