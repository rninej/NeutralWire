/**
 * summary-sections.ts — shared parser for NeutralWire neutral summaries.
 *
 * The LLM neutral summary (POST /api/summary) uses a light markup:
 *
 *   **The Big Picture**
 *
 *   Paragraph text…
 *
 *   **Why It Matters**
 *
 *   More text with **inline bold** bits…
 *
 * The in-app topic detail (src/components/topic-detail.tsx) renders this
 * with animated h3/p sections. /story/<id> (the crawlable story page Google
 * indexes) needs the SAME structure server-rendered, so the parsing lives
 * HERE — one parser, both surfaces, no drift.
 *
 * Also mirrors the app's known-heading fallbacks (the model sometimes
 * writes "The Big Picture\n" without asterisks) and the template-summary
 * detector from /api/summary (extractive fallbacks must never be shown as
 * the real neutral summary).
 */

export interface SummarySegment {
  text: string
  bold: boolean
}

export interface SummarySection {
  kind: 'heading' | 'paragraph'
  /** Present when kind === 'heading'. */
  heading?: string
  /** Paragraph content, split on inline **bold** markers. */
  segments: SummarySegment[]
}

/** Headings the model is prompted to use (plus common freestyles). */
const KNOWN_HEADINGS = [
  'The Big Picture',
  'Why It Matters',
  'How Different Outlets Are Covering It',
  'What Happens Next',
  'What Happened',
  'The Context',
  'Background',
  'Different Perspectives',
  'Reactions',
  'Key Facts',
  'Analysis',
  'Impact',
]

const KNOWN_HEADING_RE = new RegExp(
  `^\\*?\\*?(${KNOWN_HEADINGS.join('|')})\\*?\\*?\\s*\\n`,
  'i',
)

/**
 * Parse a neutral summary into heading/paragraph sections.
 * Pure function — safe on the server and in client components.
 */
export function parseSummarySections(summary: string): SummarySection[] {
  const sections: SummarySection[] = []
  const chunks = (summary || '').split('\n\n')

  for (const chunk of chunks) {
    const text = chunk.trim()
    if (!text) continue

    // **Bold heading** on its own line.
    const boldMatch = text.match(/^\*\*(.+)\*\*$/)
    if (boldMatch) {
      sections.push({ kind: 'heading', heading: boldMatch[1], segments: [] })
      continue
    }

    // Known heading (with or without asterisks) followed by its paragraph.
    const headingMatch = text.match(KNOWN_HEADING_RE)
    if (headingMatch) {
      sections.push({ kind: 'heading', heading: headingMatch[1], segments: [] })
      const rest = text.slice(headingMatch[0].length).trim()
      if (rest) {
        sections.push({ kind: 'paragraph', segments: splitInlineBold(rest) })
      }
      continue
    }

    // Plain paragraph (may contain inline **bold**).
    sections.push({ kind: 'paragraph', segments: splitInlineBold(text) })
  }

  return sections
}

/** Split a paragraph on inline **bold** markers into segments. */
function splitInlineBold(text: string): SummarySegment[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts
    .filter((p) => p.length > 0)
    .map((p) => {
      const bold = /^\*\*(.+)\*\*$/.exec(p)
      return bold
        ? { text: bold[1], bold: true }
        : { text: p, bold: false }
    })
}

/**
 * Flatten a summary to plain text (no ** markers, single-spaced) —
 * for <meta name="description">, JSON-LD description and RSS snippets,
 * where markup would leak as literal asterisks.
 */
export function plainSummaryText(summary: string): string {
  return (summary || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * True when a stored summary is the EXTRACTIVE (template) fallback the
 * old /api/summary code persisted when every AI provider failed. Those
 * read like "…indicating significant public interest" — exactly the
 * "ruined neutral summary" users complained about. They must be treated
 * as ABSENT so the real summary gets (re)generated.
 * (Same markers as /api/summary's isTemplateSummary.)
 */
export function isTemplateSummary(summary: string): boolean {
  return (
    summary.includes('indicating significant public interest') ||
    summary.includes('The breadth of coverage suggests') ||
    summary.includes('Source details are no longer available for this archived story')
  )
}
