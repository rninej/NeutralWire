import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { firebaseRead, firebasePatch, firebaseWrite } from '@/lib/firebase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 15

/**
 * GET /api/digest/unsubscribe?email=…&token=… — the ONE-CLICK unsubscribe
 * behind the digest email's footer link.
 *
 * Token = sha256(email::nw-digest-unsub-v1).slice(0,32) — computed the
 * same way digest.ts's unsubscribeLink() builds it, so the link in the
 * email and this check always agree (and casual enumeration of other
 * people's addresses is stopped without a server secret).
 *
 * What it does:
 *   1. Flips digestSubscribers/<accountId>/prefs.enabled = false — the
 *      flag the digest sweep filters on (sub.prefs?.enabled !== false),
 *      so no further emails go out from the very next sweep.
 *   2. Also flips accounts/<accountId>/prefs/digest/enabled = false (via
 *      the accountIndex email lookup) so the /subscribe settings page
 *      shows the truth instead of re-arming the digest behind the user's
 *      back.
 *   3. Responds with a tiny human-friendly HTML page (email clients open
 *      this in a browser — a JSON blob would look broken to a human).
 *
 * Idempotent: unsubscribing twice is a no-op. Re-subscribing happens the
 * normal way — the /subscribe page.
 */
const UNSUB_SALT = 'nw-digest-unsub-v1'

function tokenFor(email: string): string {
  return createHash('sha256')
    .update(`${email.toLowerCase().trim()}::${UNSUB_SALT}`)
    .digest('hex')
    .slice(0, 32)
}

const PAGE = (ok: boolean, detail: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? 'Unsubscribed' : 'Something went wrong'} — NeutralWire</title>
<style>
  body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#f4f4f5;color:#18181b;}
  .card{max-width:420px;margin:64px auto;background:#fff;border-radius:14px;padding:32px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.06);}
  h1{font-size:20px;margin:0 0 8px;}
  p{font-size:13.5px;line-height:1.5;color:#52525b;margin:0 0 18px;}
  a.btn{display:inline-block;background:#18181b;color:#fafafa;text-decoration:none;border-radius:8px;padding:10px 18px;font-size:13px;font-weight:bold;}
</style></head>
<body><div class="card">
  <div style="font-size:22px;font-weight:bold;letter-spacing:.3px;margin-bottom:16px;">Neutral<span style="color:#f59e0b;">Wire</span></div>
  <h1>${ok ? "You're unsubscribed" : 'Link not recognised'}</h1>
  <p>${detail}</p>
  <a class="btn" href="https://neutralwire.org/subscribe">Manage preferences</a>
</div></body></html>`

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const email = (sp.get('email') || '').trim().toLowerCase()
  const token = (sp.get('token') || '').trim()

  if (!email || !token || token !== tokenFor(email)) {
    return new NextResponse(
      PAGE(
        false,
        'This unsubscribe link is incomplete or expired. You can turn the digest off from the manage-preferences page instead.',
      ),
      { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    )
  }

  // 1 · The subscriber index (the flag the sweep reads).
  let flippedIndex = false
  try {
    const subs =
      (await firebaseRead<Record<string, { email?: string; prefs?: { enabled?: boolean } }>>('digestSubscribers')) || {}
    for (const [accountId, sub] of Object.entries(subs)) {
      if (sub?.email?.toLowerCase() === email) {
        await firebasePatch(`digestSubscribers/${accountId}/prefs`, { enabled: false })
        await firebaseWrite(`digestSubscribers/${accountId}/unsubscribedAt`, Date.now()).catch(() => {})
        flippedIndex = true
      }
    }
  } catch (err) {
    console.warn('[digest/unsubscribe] index flip failed:', err)
  }

  // 2 · The account's own prefs (so the settings page agrees).
  let flippedAccount = false
  try {
    const { emailKey } = await import('@/lib/subscriptions')
    const idx = await firebaseRead<{ accountId?: string }>(`accountIndex/${emailKey(email)}`)
    if (idx?.accountId) {
      await firebasePatch(`accounts/${idx.accountId}/prefs/digest`, { enabled: false })
      flippedAccount = true
    }
  } catch (err) {
    console.warn('[digest/unsubscribe] account flip failed:', err)
  }

  const ok = flippedIndex || flippedAccount
  return new NextResponse(
    PAGE(
      ok,
      ok
        ? 'The email digest is off — no more digests will arrive. Your NeutralWire account and everything else are untouched.'
        : 'We could not find an active digest for this address — it may already be unsubscribed.',
    ),
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
}
