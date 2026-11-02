/**
 * summary-skeleton.tsx — the Neutral Summary card's loading placeholder.
 *
 * WHY A SHARED COMPONENT (Nov 2026): the in-app topic detail and the
 * crawlable /story page each had their own ad-hoc placeholder — the
 * /story one was four plain `animate-pulse` bars, and the topic-detail
 * one was denser but mobile-tuned only. The owner asked for "a nice
 * skeleton loader for desktop mode too", so both surfaces now share ONE
 * polished placeholder:
 *
 *  - mirrors the REAL summary's structure (bold section heading followed
 *    by a 3-line paragraph, × 3 sections) so the swap from skeleton to
 *    text is shape-stable — no layout jump, no content "popping in";
 *  - uses the premium `shimmer` sweep (globals.css) instead of a flat
 *    opacity flicker;
 *  - responsive rhythm: tighter on mobile (space-y-5 / h-3 lines),
 *    roomier on desktop (space-y-6 / h-3.5 lines, wider heading) so it
 *    reads as a deliberate loading state on the lg+ full-page article
 *    layout, not an afterthought;
 *  - staggered first-section emphasis: the topmost heading is slightly
 *    wider/darker so the eye anchors where "The Big Picture" will land.
 *
 * Purely presentational — safe on server and client.
 */

const SECTION_HEADING_WIDTHS = ['w-36 md:w-44', 'w-28 md:w-36', 'w-32 md:w-40']
const SECTION_LAST_LINE_WIDTHS = ['w-4/5', 'w-3/4', 'w-2/3']

export function SummarySkeleton({ sections = 3 }: { sections?: number }) {
  return (
    <div className="space-y-5 md:space-y-6" aria-hidden="true">
      {Array.from({ length: sections }).map((_, i) => (
        <div key={i} className="space-y-2.5 md:space-y-3">
          {/* Fake bold section heading ("The Big Picture" …) */}
          <div
            className={`h-3.5 rounded bg-muted shimmer md:h-4 ${
              SECTION_HEADING_WIDTHS[i % SECTION_HEADING_WIDTHS.length]
            } ${i === 0 ? 'bg-muted-foreground/25' : ''}`}
          />
          {/* Fake paragraph — 3 lines, last one shorter like real prose */}
          <div className="space-y-2">
            <div className="h-3 w-full rounded bg-muted shimmer" />
            <div className="h-3 w-11/12 rounded bg-muted shimmer" />
            <div
              className={`h-3 rounded bg-muted shimmer ${
                SECTION_LAST_LINE_WIDTHS[i % SECTION_LAST_LINE_WIDTHS.length]
              }`}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
