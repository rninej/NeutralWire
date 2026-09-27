'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import { TrendingUp } from 'lucide-react'
import { Card } from '@/components/ui/card'
import {
  parseSummarySections,
  isTemplateSummary,
} from '@/lib/summary-sections'

/**
 * StorySummaryLive — the app's "Neutral Summary" card, on the crawlable
 * /story/<id> page Google links to.
 *
 * WHY THIS EXISTS: the story page used to render whatever thin wire
 * snippet lived on the topic node (topic.summary) — users clicking a
 * Google result landed on a shell with no neutral summary at all. The
 * REAL neutral summary lives in Firebase at summaries/<topicId>
 * (generated once, on demand, by /api/summary when a visitor opens the
 * story in the app).
 *
 * Behaviour:
 *  - Server-rendered with the STORED summary when one exists (full
 *    neutral summary right in the HTML — what Googlebot indexes).
 *  - When none exists yet: renders the best fallback text immediately,
 *    then POSTs /api/summary on mount — the SAME route the app uses —
 *    and swaps in the real LLM summary when it arrives (persisted by
 *    the route, so the NEXT server render has it in the raw HTML).
 *    Generation failures keep the fallback (or hide the card when there
 *    was no fallback at all — same policy as the in-app topic detail).
 */

interface StorySummaryLiveProps {
  topicId: string
  title: string
  /** Up to 12 articles — context for the summary POST. */
  articles: Array<{
    title: string
    description: string
    sourceName: string
    leaning: string
  }>
  /** Stored LLM summary, or the topic's wire-snippet fallback. */
  initialSummary: string
  /** True when initialSummary is a STORED LLM summary (no fetch needed). */
  hasStoredSummary: boolean
}

type Status = 'static' | 'generating' | 'upgraded' | 'failed'

export function StorySummaryLive({
  topicId,
  title,
  articles,
  initialSummary,
  hasStoredSummary,
}: StorySummaryLiveProps) {
  const [summary, setSummary] = React.useState(initialSummary)
  const [status, setStatus] = React.useState<Status>(
    hasStoredSummary ? 'static' : 'generating',
  )

  React.useEffect(() => {
    if (hasStoredSummary) return
    let cancelled = false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 25_000)

    fetch('/api/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topicId,
        title,
        articles,
        topicSummary: initialSummary,
      }),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as {
          summary?: string
          fallback?: boolean
        }
        if (cancelled) return
        // Extractive/template fallbacks are not the real neutral summary —
        // keep the fallback text instead of showing the template.
        if (
          !data.summary ||
          data.fallback ||
          isTemplateSummary(data.summary)
        ) {
          setStatus('failed')
          return
        }
        setSummary(data.summary)
        setStatus('upgraded')
      })
      .catch(() => {
        if (!cancelled) setStatus('failed')
      })
      .finally(() => clearTimeout(timer))

    return () => {
      cancelled = true
      controller.abort()
      clearTimeout(timer)
    }
  }, [topicId, hasStoredSummary])

  // Parse sections (memoised) — MUST run before any early return below
  // so hook order is stable across renders.
  const sections = React.useMemo(
    () => parseSummarySections(summary),
    [summary],
  )

  // No fallback AND generation failed → hide the card entirely (the
  // in-app topic detail applies the same policy).
  if (!summary && status === 'failed') return null

  return (
    <Card className="mt-6 gap-0 p-5 md:p-6">
      <div className="mb-3 flex items-center gap-2">
        <TrendingUp className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-base font-bold">Neutral Summary</h2>
        {status === 'generating' && (
          <span className="ml-auto flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
            </span>
            Writing the full neutral summary…
          </span>
        )}
      </div>

      {sections.length === 0 ? (
        // No text at all yet — skeleton while the first summary generates.
        <div className="space-y-3" aria-hidden>
          <div className="h-4 w-1/4 animate-pulse rounded bg-muted" />
          <div className="h-4 w-full animate-pulse rounded bg-muted" />
          <div className="h-4 w-11/12 animate-pulse rounded bg-muted" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      ) : status === 'upgraded' ? (
        <motion.div
          key="upgraded"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
          className="space-y-4 text-base leading-relaxed text-foreground/90 md:text-[17px] md:leading-[1.7]"
        >
          {sections.map((s, i) => renderSection(s, i))}
        </motion.div>
      ) : (
        <div className="space-y-4 text-base leading-relaxed text-foreground/90 md:text-[17px] md:leading-[1.7]">
          {sections.map((s, i) => renderSection(s, i))}
        </div>
      )}
    </Card>
  )
}

function renderSection(
  s: { kind: 'heading' | 'paragraph'; heading?: string; segments: Array<{ text: string; bold: boolean }> },
  i: number,
) {
  if (s.kind === 'heading') {
    return (
      <h3
        key={i}
        className={`text-lg font-bold text-foreground mb-1 ${i > 0 ? 'mt-5' : ''}`}
      >
        {s.heading}
      </h3>
    )
  }
  return (
    <p key={i}>
      {s.segments.map((seg, j) =>
        seg.bold ? (
          <strong key={j} className="font-bold text-foreground">
            {seg.text}
          </strong>
        ) : (
          <span key={j}>{seg.text}</span>
        ),
      )}
    </p>
  )
}
