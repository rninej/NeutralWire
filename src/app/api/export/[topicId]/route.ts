import { NextRequest, NextResponse } from 'next/server'
import { findTopicAnywhere } from '@/lib/topic-lookup'
import { getRequesterTier, accountForApiKey } from '@/lib/subscriptions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 30

/**
 * GET /api/export/[topicId]?format=md|txt|json — article export (Ultra).
 *
 * Auth: the visitor's session cookie (Ultra account) OR an Ultra API key
 * (?key=nwul_…). Produces a faithful, self-contained export of the
 * story: title, neutral summary, bias split, every source (outlet,
 * leaning, link) and a NeutralWire link — as Markdown (default),
 * plain text, or JSON. Served as a file download with a safe filename.
 *
 * Free users get a 402 with needUpgrade so the UI can open the paywall.
 */
function toMarkdown(topicId: string, topic: TopicShape): string {
  const lines: string[] = []
  lines.push(`# ${topic.title}`)
  lines.push('')
  lines.push(`*Exported from [NeutralWire](https://neutralwire.org/?topic=${topicId}) — how left, centre and right covered it.*`)
  lines.push('')
  lines.push(`**Coverage:** ${topic.coverage} source${topic.coverage === 1 ? '' : 's'} — ${topic.leanLeft} left / ${topic.leanCenter} centre / ${topic.leanRight} right`)
  if (topic.summary) {
    lines.push('')
    lines.push('## Neutral summary')
    lines.push('')
    lines.push(topic.summary)
  }
  if (topic.articles?.length) {
    lines.push('')
    lines.push('## Sources across the spectrum')
    lines.push('')
    for (const a of topic.articles) {
      lines.push(`- [${a.title}](${a.link}) — *${a.sourceName || a.sourceId} (${a.leaning})*`)
    }
  }
  lines.push('')
  lines.push('---')
  lines.push(`Compare the coverage live: https://neutralwire.org/?topic=${topicId}`)
  return lines.join('\n')
}

function toPlainText(topicId: string, topic: TopicShape): string {
  const parts: string[] = []
  parts.push(topic.title.toUpperCase())
  parts.push('')
  parts.push(`Coverage: ${topic.coverage} sources — ${topic.leanLeft} left / ${topic.leanCenter} centre / ${topic.leanRight} right`)
  if (topic.summary) {
    parts.push('')
    parts.push('NEUTRAL SUMMARY')
    parts.push(topic.summary)
  }
  if (topic.articles?.length) {
    parts.push('')
    parts.push('SOURCES ACROSS THE SPECTRUM')
    for (const a of topic.articles) {
      parts.push(`- ${a.title} (${a.sourceName || a.sourceId}, ${a.leaning}) — ${a.link}`)
    }
  }
  parts.push('')
  parts.push(`Compare the coverage live: https://neutralwire.org/?topic=${topicId}`)
  return parts.join('\n')
}

interface TopicShape {
  topicId: string
  title: string
  summary?: string
  coverage: number
  leanLeft: number
  leanCenter: number
  leanRight: number
  articles?: Array<{
    title: string
    link: string
    sourceName?: string
    sourceId?: string
    leaning: string
  }>
}

function safeFilename(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'neutralwire-story'
  )
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ topicId: string }> },
) {
  const { topicId } = await ctx.params
  const formatParam = req.nextUrl.searchParams.get('format') || 'md'
  const format = ['md', 'txt', 'json'].includes(formatParam) ? formatParam : 'md'

  // ── Ultra gate: session cookie OR API key ──
  let unlocked = false
  const key = req.nextUrl.searchParams.get('key') || ''
  if (key) {
    const account = await accountForApiKey(key)
    unlocked = Boolean(account)
  }
  if (!unlocked) {
    const requester = await getRequesterTier(req)
    unlocked = requester.allUnlocked || requester.tier === 'ultra'
  }
  if (!unlocked) {
    return NextResponse.json(
      {
        error: 'Exporting and downloading articles is an Ultra feature.',
        needUpgrade: true,
      },
      { status: 402 },
    )
  }

  // ── Find the topic (archive + every live cache) ──
  const topic = (await findTopicAnywhere(topicId)) as TopicShape | null
  if (!topic) {
    return NextResponse.json({ error: 'Story not found.' }, { status: 404 })
  }

  const filename = safeFilename(topic.title)
  if (format === 'json') {
    return new NextResponse(JSON.stringify({ ...topic, source: 'neutralwire.org' }, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}.json"`,
      },
    })
  }
  if (format === 'txt') {
    return new NextResponse(toPlainText(topicId, topic), {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}.txt"`,
      },
    })
  }
  return new NextResponse(toMarkdown(topicId, topic), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}.md"`,
    },
  })
}
