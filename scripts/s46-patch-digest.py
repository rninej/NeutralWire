#!/usr/bin/env python3
"""Replace the newsletter builder block in digest.ts with the new grid system."""
import re

PATH = '/home/z/my-project/src/lib/digest.ts'
src = open(PATH).read()

# ── Find the block: from the generateNewsletter doc comment through the end
#    of buildFallbackNewsletter (ends right before the Resend from-address
#    ladder comment). ──
start_marker = "/** The AI newsletter writer — returns ready-to-send HTML."
end_marker = "/** Send via Resend (when configured) — else file to the outbox."
si = src.index(start_marker)
ei = src.index(end_marker)
old_block = src[si:ei]
print(f"Replacing block: {len(old_block)} chars "
      f"(lines ~{src[:si].count(chr(10))+1} to {src[:ei].count(chr(10))+1})")
assert 'buildFallbackNewsletter' in old_block
assert 'generateNewsletter' in old_block

new_block = '''/** The AI newsletter writer — CONTENT ONLY, rendered through the shared
 * grid template.
 *
 * THE AI IS A POLISH LAYER, NEVER A GATE (the digest's founding lesson):
 * when callAI is unavailable the same deterministic template renders with
 * heuristic content (see below), so the email goes out EVERY time, in the
 * SAME layout.
 *
 * The AI returns STRUCTURED content — {subject, note, items:[{headline,
 * summary}]} — never HTML: every link and every style comes from the
 * server-side template, so no provider outage or malformed reply can ever
 * break the email's layout (the old full-HTML handoff left Outlook-safe
 * rendering to whatever the model felt like emitting that day). Items map
 * to OUR stories BY ORDER — the AI cannot swap or invent URLs. */
export async function generateNewsletter(
  email: string,
  stories: TopicArticle[],
): Promise<{ subject: string; html: string } | null> {
  if (stories.length === 0) return null
  const list = stories
    .map(
      (s, i) =>
        `${i + 1}. ${s.title}${s.summary ? ` — ${s.summary.slice(0, 160)}` : ''} [${s.coverage} sources; bias L${s.leanLeft}/C${s.leanCenter}/R${s.leanRight}]`,
    )
    .join('\\n')

  const raw = await callAI({
    systemPrompt:
      'You are the editor of the NeutralWire email digest — a neutral news comparison service showing how left, centre and right outlets cover the same stories. You will receive today\\'s stories as numbered lines. Reply with ONLY JSON: {"subject":"a short witty but strictly neutral subject line","note":"1-2 sentence editor\\'s note to open the digest (warm, witty, neutral — mention how coverage splits across the spectrum today)","items":[{"headline":"the story headline (you may lightly clean/clarity-fix it)","summary":"2 short sentences: what happened + how left/centre/right coverage differs"}]} — exactly one item per story, in the SAME ORDER as given, same count. No other text.',
    userPrompt: `Subscriber: ${email}\\nToday's stories (title — summary [sources; bias split]):\\n${list}\\n\\nReply with only the JSON.`,
    maxTokens: 1600,
  })

  let note =
    'How the spectrum covered today, side by side — every story below shows the left/centre/right split at a glance.'
  let subject = ''
  let items: Array<{ headline?: string; summary?: string }> = []
  if (raw) {
    try {
      const m = raw.match(/\\{[\\s\\S]*\\}/)
      if (m) {
        const parsed = JSON.parse(m[0]) as {
          subject?: string
          note?: string
          items?: Array<{ headline?: string; summary?: string }>
        }
        if (parsed.subject) subject = String(parsed.subject).slice(0, 120)
        if (parsed.note) note = String(parsed.note).slice(0, 280)
        if (Array.isArray(parsed.items)) items = parsed.items
      }
    } catch {
      // fall through to the heuristic content below
    }
  }

  // Map AI content onto OUR stories by order; anything missing/short gets
  // the heuristic fill — the template never sees a hole.
  const rows = stories.map((s, i) => {
    const aiItem = items[i] || {}
    const headline =
      typeof aiItem.headline === 'string' && aiItem.headline.trim().length >= 8
        ? aiItem.headline.trim().slice(0, 140)
        : s.title
    const summary =
      typeof aiItem.summary === 'string' && aiItem.summary.trim().length >= 20
        ? aiItem.summary.trim().slice(0, 220)
        : s.summary?.slice(0, 200) ||
          `Covered by ${s.coverage} ${s.coverage === 1 ? 'outlet' : 'outlets'} — open the story to compare how each side frames it.`
    return { story: s, headline, summary }
  })

  if (!subject) {
    subject =
      stories.length > 1
        ? `Your NeutralWire digest — ${stories.length} stories across the spectrum`
        : `Your NeutralWire digest — ${(stories[0]?.title || "today's stories").slice(0, 60)}`
  }
  return {
    subject: subject.slice(0, 120),
    html: renderDigestEmail({ email, note, rows }),
  }
}

// ── The digest email template (the ONE layout, AI or not) ────────────────
//
// Design goals (the owner's brief): stories must be visible MULTIPLE AT
// ONCE — the old one-below-another letter format buried every story below
// a full-screen block of text. The new layout is a GRID digest:
//
//   • a slim branded header band + one-line editor's note,
//   • TWO story cards per row (table cells — the only layout primitive
//     every email client, Outlook included, renders reliably; CSS
//     grid/flex are NOT email-safe),
//   • each card: rank number, headline (linked), 2-sentence summary, an
//     n-sources line, the site's signature L/C/R bias bar in the same
//     blue/zinc/red as the site, and a Read-the-full-picture link,
//   • a footer with the one-click unsubscribe link.
//
// Everything inline-styled (email clients strip <style> blocks and many
// disregard classes), width-capped at 640px, stack-safe on phones (the
// 50% cells wrap one-per-row naturally on narrow clients).

/** Site-matching spectrum colours (blue-500 / zinc-500 / red-500). */
const BIAS_COLORS = { left: '#3b82f6', center: '#71717a', right: '#ef4444' }

function escHtml(s: string): string {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

interface DigestRow {
  story: TopicArticle
  headline: string
  summary: string
}

function renderDigestEmail(opts: { email: string; note: string; rows: DigestRow[] }): string {
  const { email, note, rows } = opts
  const greeting = email.split('@')[0] || 'there'
  const dateLine = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
  const unsub = unsubscribeLink(email)

  // ── One story card (a single-cell table so borders+radius travel well) ──
  const card = (row: DigestRow, n: number): string => {
    const s = row.story
    const total = Math.max(1, s.leanLeft + s.leanCenter + s.leanRight)
    const lPct = Math.round((s.leanLeft / total) * 100)
    const cPct = Math.round((s.leanCenter / total) * 100)
    const rPct = Math.max(0, 100 - lPct - cPct)
    const url = `https://neutralwire.org/?topic=${encodeURIComponent(s.topicId)}`
    // Empty bias segments collapse to a 0-width cell; the row keeps a
    // 6px height so the bar always reads as a bar.
    const seg = (pct: number, color: string) =>
      `<td width="${Math.max(pct, 0)}%" style="background:${color};font-size:0;line-height:6px;height:6px;">&nbsp;</td>`
    return `
        <td width="50%" valign="top" style="padding:6px 5px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;">
            <tr><td style="border:1px solid #e4e4e7;border-radius:10px;padding:13px 14px;background:#ffffff;">
              <p style="margin:0 0 5px;font-size:10.5px;letter-spacing:0.4px;color:#a1a1aa;font-family:Arial,Helvetica,sans-serif;font-weight:bold;">
                <span style="color:#f59e0b;">#${n}</span> &nbsp;&middot;&nbsp; ${s.coverage} ${s.coverage === 1 ? 'SOURCE' : 'SOURCES'}
              </p>
              <a href="${url}" style="font-size:15px;line-height:1.35;color:#18181b;font-weight:bold;text-decoration:none;font-family:Georgia,'Times New Roman',serif;">${escHtml(row.headline)}</a>
              <p style="margin:7px 0 10px;font-size:12.5px;line-height:1.5;color:#52525b;font-family:Georgia,'Times New Roman',serif;">${escHtml(row.summary)}</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;">
                <tr>${seg(lPct, BIAS_COLORS.left)}${seg(cPct, BIAS_COLORS.center)}${seg(rPct, BIAS_COLORS.right)}</tr>
              </table>
              <p style="margin:4px 0 0;font-size:10px;color:#a1a1aa;font-family:Arial,Helvetica,sans-serif;">
                <span style="color:${BIAS_COLORS.left};font-weight:bold;">L ${lPct}%</span> &middot;
                <span style="color:${BIAS_COLORS.center};font-weight:bold;">C ${cPct}%</span> &middot;
                <span style="color:${BIAS_COLORS.right};font-weight:bold;">R ${rPct}%</span>
              </p>
              <a href="${url}" style="display:inline-block;margin-top:10px;font-size:12px;font-weight:bold;color:#18181b;text-decoration:none;font-family:Arial,Helvetica,sans-serif;border-bottom:2px solid #f59e0b;padding-bottom:1px;">Read the full picture &rarr;</a>
            </td></tr>
          </table>
        </td>`
  }

  // ── Rows of two cards; an odd tail gets a filler cell to keep the table happy ──
  const gridRows: string[] = []
  for (let i = 0; i < rows.length; i += 2) {
    const a = card(rows[i], i + 1)
    const b = i + 1 < rows.length ? card(rows[i + 1], i + 2) : `<td width="50%" style="padding:6px 5px;">&nbsp;</td>`
    gridRows.push(`<tr>${a}${b}</tr>`)
  }

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">
<tr><td align="center" style="padding:20px 10px 28px 10px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">

  <!-- Header band -->
  <tr><td style="background:#18181b;padding:18px 26px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="font-size:19px;font-weight:bold;color:#fafafa;font-family:Arial,Helvetica,sans-serif;letter-spacing:0.3px;">
          Neutral<span style="color:#f59e0b;">Wire</span>
        </td>
        <td align="right" style="font-size:10.5px;color:#a1a1aa;font-family:Arial,Helvetica,sans-serif;letter-spacing:1.5px;font-weight:bold;">
          DAILY&nbsp;DIGEST
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- Greeting + date + editor's note -->
  <tr><td style="padding:16px 26px 6px 26px;">
    <p style="margin:0 0 2px;font-size:11px;color:#a1a1aa;font-family:Arial,Helvetica,sans-serif;letter-spacing:0.3px;">${escHtml(dateLine)} &middot; ${rows.length} ${rows.length === 1 ? 'story' : 'stories'}</p>
    <p style="margin:0 0 10px;font-size:15px;color:#18181b;font-family:Georgia,'Times New Roman',serif;font-weight:bold;">Hello ${escHtml(greeting)}</p>
    <p style="margin:0;font-size:13px;line-height:1.55;color:#3f3f46;font-family:Georgia,'Times New Roman',serif;">${escHtml(note)}</p>
  </td></tr>

  <!-- The grid -->
  <tr><td style="padding:8px 14px 4px 14px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${gridRows.join('\\n')}
    </table>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:16px 26px 20px 26px;border-top:1px solid #f4f4f5;">
    <p style="margin:0 0 4px;font-size:11px;color:#a1a1aa;font-family:Arial,Helvetica,sans-serif;">
      Sent by <a href="https://neutralwire.org" style="color:#71717a;">NeutralWire</a> — neutral news, every spectrum.
    </p>
    <a href="${unsub}" style="font-size:11px;color:#a1a1aa;font-family:Arial,Helvetica,sans-serif;">Unsubscribe in one click</a>
    <span style="color:#d4d4d8;"> &middot; </span>
    <a href="https://neutralwire.org/subscribe" style="font-size:11px;color:#a1a1aa;font-family:Arial,Helvetica,sans-serif;">Manage preferences</a>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`
}

/** One-click unsubscribe link for the footer. Token = sha256 of the email
 * + a fixed salt (stops casual enumeration of other people's unsubscribe
 * URLs without needing a server secret). */
function unsubscribeLink(email: string): string {
  const token = crypto
    .createHash('sha256')
    .update(`${email.toLowerCase().trim()}::nw-digest-unsub-v1`)
    .digest('hex')
    .slice(0, 32)
  return `https://neutralwire.org/api/digest/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`
}

'''

src = src[:si] + new_block + src[ei:]
open(PATH, 'w').write(src)
print("digest.ts updated OK")
