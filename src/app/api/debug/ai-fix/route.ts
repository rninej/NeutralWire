import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import { verifyAdminPassword } from '@/lib/admin-auth'
import {
  callAI,
  callAICompound,
  getLastProvider,
} from '@/lib/ai-providers'
import {
  findImageForTopic,
  createImageVerifyContext,
  flushImageVerdicts,
} from '@/lib/news-aggregator'
import { findTopicAnywhere } from '@/lib/topic-lookup'
import { writeSearchIndexEntry } from '@/lib/search-index'
import { refreshMeshManifestForRoom } from '@/lib/news-cache'
import type { TopicArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
// AI generation + image discovery + cache rewrites can legitimately take
// 30-50s (parallel provider race is fast, but findImageForTopic fetches
// OG images and verifies them with a vision model).
export const maxDuration = 60

/**
 * "Make AI Fix" — triggered from /debug on a user bug report.
 *
 * The AI has FULL WRITE ACCESS to every place a story lives:
 *   title-rewrites/<topicId>     (future refreshes keep the fixed title)
 *   summaries/<topicId>          (article view reads this)
 *   newsCache/<category>/topics  (the live feed users see right now)
 *   archive/<topicId>            (permanent copy + shared links)
 *   searchIndex/<topicId>        (archive search results)
 *   videos6/<topicId>__<hl>      (video resolution caches)
 *
 * Dispatch by report type:
 *   title          → AI rewrites the headline from the article coverage
 *   summary | summary-missing → AI regenerates the neutral summary
 *   photo          → re-runs image discovery + content verification
 *                    (falls back to removing the wrong image)
 *   video          → kills the resolved video cache + blocks that video
 *   sources        → AI reviews the article list, unrelated ones removed
 *   other          → AI analyses (with web search) and reports findings
 */

const DB_URL =
  'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'

interface BugReport {
  id: string
  type: string
  note: string
  deviceId: string
  createdAt: number
  updatedAt: number
  status: 'open' | 'fixed' | 'dismissed'
  topic: TopicArticle
  fixedAt?: number
  aiNote?: string
  aiModel?: string
}

// ── helpers ──

function wordCount(s: string): number {
  return (s || '').trim().split(/\s+/).filter(Boolean).length
}

function isBrokenTitle(t: string): boolean {
  const v = (t || '').trim()
  return wordCount(v) < 4 || v.length < 16
}

/** Extract the first JSON array of numbers from a model reply. */
function parseIndexList(reply: string): number[] | null {
  if (!reply) return null
  const cleaned = reply.replace(/```json|```/g, '').trim()
  const m = cleaned.match(/\[[\d\s,]*\]/)
  if (!m) return null
  try {
    const arr = JSON.parse(m[0]) as unknown[]
    const nums = arr.map(Number).filter((n) => Number.isInteger(n) && n >= 0)
    return nums.length > 0 ? [...new Set(nums)] : []
  } catch {
    return null
  }
}

/** List every newsCache key (shallow — key names only, tiny). */
async function listCacheKeys(): Promise<string[]> {
  try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), 6000)
    const res = await fetch(`${DB_URL}/newsCache.json?shallow=true`, {
      cache: 'no-store',
      signal: controller.signal,
    })
    clearTimeout(t)
    if (res.ok) {
      const text = await res.text()
      if (text && text !== 'null') {
        return Object.keys(JSON.parse(text) as Record<string, unknown>)
      }
    }
  } catch {
    // fall through
  }
  return []
}

/**
 * Patch the topic EVERYWHERE it lives: every newsCache category that
 * contains it, the archive, and the search index. Returns where it was
 * patched. The patch function receives the current copy and returns the
 * fields to merge.
 */
async function patchTopicEverywhere(
  topicId: string,
  patch: (current: TopicArticle) => Partial<TopicArticle>,
): Promise<string[]> {
  const patchedIn: string[] = []

  // 1. Live cache — every category containing the topic.
  const keys = await listCacheKeys()
  for (const key of keys.slice(0, 20)) {
    try {
      const payload = await firebaseRead<{
        topics?: TopicArticle[]
        fetchedAt?: number
        [k: string]: unknown
      }>(`newsCache/${key}`)
      if (!payload?.topics) continue
      let changed = false
      const topics = payload.topics.map((t) => {
        if (t?.topicId === topicId) {
          changed = true
          patchedIn.push(`newsCache/${key}`)
          return { ...t, ...patch(t) } as TopicArticle
        }
        return t
      })
      if (changed) {
        await firebaseWrite(`newsCache/${key}`, { ...payload, topics })
        // Keep the server-signed mesh manifest in sync with the patched
        // node — otherwise the room's P2P relay fails closed (hash
        // mismatch) until the next full refresh.
        await refreshMeshManifestForRoom(key)
      }
    } catch {
      // continue
    }
  }

  // 2. Archive (permanent copy) + search index.
  try {
    const archived = await firebaseRead<TopicArticle>(`archive/${topicId}`)
    if (archived?.topicId) {
      const merged = { ...archived, ...patch(archived) } as TopicArticle
      await firebaseWrite(`archive/${topicId}`, merged)
      patchedIn.push('archive')
      void writeSearchIndexEntry(merged)
    }
  } catch {
    // best-effort
  }

  return [...new Set(patchedIn)]
}

/** Collect the freshest full topic for a report (snapshot → archive → cache). */
async function resolveReportTopic(report: BugReport): Promise<TopicArticle> {
  if (report.topic?.articles && report.topic.articles.length > 0) {
    return report.topic
  }
  const found = await findTopicAnywhere(report.topic?.topicId || '', {
    alsoArchive: false,
  })
  return found || report.topic
}

function articleContext(topic: TopicArticle): string {
  const lines = (topic.articles || [])
    .slice(0, 12)
    .map(
      (a, i) =>
        `${i}. [${a.leaning}] ${a.sourceName}: "${a.title}" — ${(a.description || '')
          .slice(0, 160)}`,
    )
  return lines.join('\n') || '(no article list available)'
}

// ── the fixers ──

async function fixTitle(
  topic: TopicArticle,
  note: string,
): Promise<{ patch: Partial<TopicArticle>; note: string } | null> {
  const reply = await callAI({
    systemPrompt: `You are a news headline editor for NeutralWire. A user reported this story's headline as broken or wrong. Write a replacement headline from the actual article coverage.

Rules:
- 6-14 words, plain factual English, Title Case not required.
- Preserve the key facts (who, what, where) from the articles.
- No quotes, no prefixes like "Headline:", no trailing punctuation.
- Output ONLY the headline.`,
    userPrompt: `Reported headline: "${topic.title}"
Report note from user: ${note || '(none)'}

Article coverage:
${articleContext(topic)}

Current summary for context: ${(topic.summary || '').slice(0, 400)}

Replacement headline:`,
    maxTokens: 80,
  })
  const candidate = (reply || '').trim().replace(/^["']|["']$/g, '')
  if (!candidate || isBrokenTitle(candidate) || candidate.length > 200) {
    return null
  }
  return {
    patch: { title: candidate },
    note: `Headline rewritten by AI: "${topic.title}" → "${candidate}"`,
  }
}

async function fixSummary(
  topic: TopicArticle,
  note: string,
): Promise<{ patch: Partial<TopicArticle>; note: string } | null> {
  const reply = await callAI({
    systemPrompt: `You are a neutral news summariser for NeutralWire. A user reported this story's neutral summary as wrong or missing. Write a replacement summary from the article coverage.

Rules:
- 2 short paragraphs (~60-90 words total), plain English.
- Strictly neutral: state what is reported, attribute claims ("according to X"), no editorialising.
- Only facts present in the articles below. No knowledge from outside.
- Output ONLY the summary text.`,
    userPrompt: `Reported summary: "${(topic.summary || '(missing)').slice(0, 300)}"
Report note from user: ${note || '(none)'}

Article coverage:
${articleContext(topic)}

Story headline: ${topic.title}

Replacement summary:`,
    maxTokens: 300,
  })
  const summary = (reply || '').trim()
  if (!summary || summary.length < 120 || summary.length > 1200) {
    return null
  }
  return {
    patch: { summary },
    note: `Neutral summary regenerated by AI (${wordCount(summary)} words).`,
  }
}

async function fixPhoto(
  topic: TopicArticle,
  note: string,
): Promise<{ patch: Partial<TopicArticle>; note: string } | null> {
  // Re-run the full image pipeline: OG images, upgrades, scoring AND
  // vision-model content verification (a confidently-unrelated image is
  // skipped). If nothing valid is found, the wrong image is REMOVED (a
  // clean text card beats a wrong photo).
  const verifyCtx = await createImageVerifyContext()
  const img = await findImageForTopic(topic, 5, verifyCtx)
  await flushImageVerdicts(verifyCtx)
  if (img) {
    if (img === topic.imageUrl) {
      return {
        patch: {},
        note: `Image pipeline re-verified the current photo as the best valid match — kept it. (User note: "${note || 'none'}")`,
      }
    }
    return {
      patch: { imageUrl: img },
      note: `Image replaced by AI-verified candidate (old: ${(topic.imageUrl || 'none').slice(0, 80)}… → new: ${img.slice(0, 80)}…).`,
    }
  }
  return {
    patch: { imageUrl: null },
    note: 'No valid replacement image found — the incorrect photo was removed (card renders cleanly without an image).',
  }
}

async function fixVideo(
  topic: TopicArticle,
): Promise<{ patch: Partial<TopicArticle>; note: string } | null> {
  // Kill every language cache entry for this topic's video resolution,
  // remembering the resolved videoId as dead so re-resolution never
  // serves it again.
  const topicId = topic.topicId
  let killed = 0
  try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), 6000)
    const res = await fetch(`${DB_URL}/videos6.json?shallow=true`, {
      cache: 'no-store',
      signal: controller.signal,
    })
    clearTimeout(t)
    if (res.ok) {
      const text = await res.text()
      if (text && text !== 'null') {
        const keys = Object.keys(JSON.parse(text) as Record<string, unknown>)
        const matching = keys.filter((k) => k.startsWith(`${topicId}__`))
        for (const key of matching) {
          try {
            const cached = await firebaseRead<{
              ts: number
              result: { videoId?: string }
            }>(`videos6/${key}`)
            const dead = [
              ...new Set([...(cached?.result?.videoId ? [cached.result.videoId] : [])]),
            ]
            await firebaseWrite(`videos6/${key}`, {
              ts: Date.now(),
              result: { ok: false, reason: 'reported-incorrect' },
              dead,
            })
            killed++
          } catch {
            // continue
          }
        }
      }
    }
  } catch {
    // best-effort
  }
  return {
    patch: {},
    note: `Video cache cleared for this story (${killed} language entr${killed === 1 ? 'y' : 'ies'} reset; the reported video is now blocklisted). The next open re-searches and picks a different video.`,
  }
}

async function fixSources(
  topic: TopicArticle,
  note: string,
): Promise<{ patch: Partial<TopicArticle>; note: string } | null> {
  const articles = topic.articles || []
  if (articles.length === 0) {
    return { patch: {}, note: 'No sources stored for this story — nothing to review.' }
  }
  const reply = await callAI({
    systemPrompt: `You are a news source auditor for NeutralWire. A user reported that some listed sources don't belong to this story. Review each article and decide which ones are UNRELATED to the story's headline.

Respond with ONLY a JSON array of the indices to REMOVE (e.g. [0, 3]). An empty array [] means all sources belong — remove nothing. Judge strictly: an article is unrelated only if its subject clearly differs from the story.`,
    userPrompt: `Story headline: ${topic.title}
Story summary: ${(topic.summary || '').slice(0, 300)}
User report note: ${note || '(none)'}

Articles:
${articleContext(topic)}

Indices to remove (JSON array):`,
    maxTokens: 120,
  })
  const removeIdx = parseIndexList(reply ?? '')
  if (removeIdx === null) {
    return null
  }
  if (removeIdx.length === 0) {
    return { patch: {}, note: 'AI reviewed the source list — all articles plausibly belong to this story; nothing removed.' }
  }
  const valid = removeIdx.filter((i) => i < articles.length)
  if (valid.length === 0) {
    return { patch: {}, note: 'AI review returned out-of-range indices — no changes made.' }
  }
  const removedTitles = valid.map((i) => `"${articles[i].title.slice(0, 60)}"`)
  const kept = articles.filter((_, i) => !valid.includes(i))
  // Re-count the leaning split from the kept articles.
  const leanLeft = kept.filter((a) => a.leaning === 'left').length
  const leanCenter = kept.filter((a) => a.leaning === 'center').length
  const leanRight = kept.filter((a) => a.leaning === 'right').length
  return {
    patch: { articles: kept, leanLeft, leanCenter, leanRight, coverage: kept.length },
    note: `AI removed ${valid.length} unrelated source(s): ${removedTitles.join(', ')}.`,
  }
}

async function fixOther(
  topic: TopicArticle,
  note: string,
): Promise<{ patch: Partial<TopicArticle>; note: string } | null> {
  // Free-form analysis WITH web search — the AI investigates the story
  // and reports what (if anything) is wrong and how to fix it.
  const reply =
    (await callAICompound({
      systemPrompt:
        'You are a news quality auditor for NeutralWire. Investigate the reported story and write a concise finding (2-4 sentences): what is wrong (if anything), and the recommended fix. Be specific and factual.',
      userPrompt: `Story: ${topic.title}
Summary: ${(topic.summary || '').slice(0, 300)}
User report: ${note || '(no details given)'}

Articles:
${articleContext(topic)}

Your finding:`,
    })) ||
    (await callAI({
      systemPrompt:
        'You are a news quality auditor for NeutralWire. Review the reported story from the given context and write a concise finding (2-4 sentences): what is wrong (if anything), and the recommended fix.',
      userPrompt: `Story: ${topic.title}
Summary: ${(topic.summary || '').slice(0, 300)}
User report: ${note || '(no details given)'}

Articles:
${articleContext(topic)}

Your finding:`,
      maxTokens: 200,
    }))
  const finding = (reply || '').trim()
  if (!finding || finding.length < 30) return null
  return { patch: {}, note: `AI investigation: ${finding.slice(0, 800)}` }
}

// ── route ──

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { reportId?: string; password?: string }
    if (!body.reportId || !body.password || !verifyAdminPassword(body.password)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const reportId = String(body.reportId).replace(/[^a-z0-9]/gi, '')

    const report = await firebaseRead<BugReport>(`reports/${reportId}`)
    if (!report || !report.topic?.topicId) {
      return NextResponse.json({ error: 'Report not found' }, { status: 404 })
    }
    // NOTE: a previously-fixed report may be RE-run deliberately from
    // /debug ("Re-run AI fix" button) — the fix operates on the report's
    // current (already-patched) topic snapshot, so re-runs are safe.

    const topic = await resolveReportTopic(report)
    const type = report.type
    let result: { patch: Partial<TopicArticle>; note: string } | null = null

    if (type === 'title') result = await fixTitle(topic, report.note)
    else if (type === 'summary' || type === 'summary-missing')
      result = await fixSummary(topic, report.note)
    else if (type === 'photo') result = await fixPhoto(topic, report.note)
    else if (type === 'video') result = await fixVideo(topic)
    else if (type === 'sources') result = await fixSources(topic, report.note)
    else result = await fixOther(topic, report.note)

    if (!result) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'The AI could not produce a confident fix for this report (provider failed or output failed validation). Try again in a moment.',
        },
        { status: 502 },
      )
    }

    // ── Apply the patch everywhere the story lives ──
    const patchedIn = await patchTopicEverywhere(topic.topicId, () => result!.patch)

    // Type-specific persistent stores:
    if (type === 'title' && result.patch.title) {
      // title-rewrites/<topicId> — the refresh pipeline reads this, so
      // FUTURE refreshes of this story keep the fixed headline.
      await firebaseWrite(`title-rewrites/${topic.topicId}`, result.patch.title)
    }
    if (
      (type === 'summary' || type === 'summary-missing') &&
      result.patch.summary
    ) {
      // summaries/<topicId> — the article view reads this directly.
      await firebaseWrite(`summaries/${topic.topicId}`, {
        summary: result.patch.summary,
        generatedAt: Date.now(),
        title: result.patch.title || topic.title,
        sourceCount: (topic.articles || []).length,
      })
    }

    const aiNote = `${result.note} Applied to: ${
      patchedIn.length > 0 ? patchedIn.join(', ') : 'report only (story no longer live)'
    }.`

    // ── Mark the report fixed (with the AI's own account of the fix) ──
    await firebaseWrite(`reports/${reportId}`, {
      ...report,
      status: 'fixed',
      fixedAt: Date.now(),
      updatedAt: Date.now(),
      aiNote,
      aiModel: getLastProvider(),
      topic: { ...report.topic, ...result.patch },
    })

    return NextResponse.json({
      ok: true,
      aiNote,
      aiModel: getLastProvider(),
      changes: result.patch,
      patchedIn,
    })
  } catch (err) {
    console.warn('[api/debug/ai-fix] error:', err)
    return NextResponse.json(
      { error: 'AI fix failed', detail: String(err).slice(0, 200) },
      { status: 500 },
    )
  }
}
