import { NextRequest, NextResponse } from 'next/server'
import { firebaseRead, firebaseWrite } from '@/lib/firebase-server'
import { createHash, timingSafeEqual } from 'crypto'
import {
  POPUP_MODES,
  DEFAULT_POPUP_MODE,
  normalizePopupMode,
  type PopupMode,
} from '@/lib/popup-mode'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 15

/**
 * Server-side feature flags (stored in Firebase under featureFlags/<name>).
 *
 * GET  /api/flags   → { subtopicNav, popupSystem }   (public)
 * POST /api/flags   → set flag(s) for ALL users (password-protected)
 *       body: { password, subtopicNav?, popupSystem? }  — send one or both.
 *
 * Managed flags:
 *   - subtopicNav: which category-header design every visitor sees.
 *       'cards'      → big icon chips in a scrollable row — DEFAULT
 *       'classic'    → the original small wrapping text pills
 *       'tabs'       → bold text tabs + animated underline
 *       'tiles'      → wrapping grid of icon tiles (all visible, no scroll)
 *       'sheet'      → one wide button that opens a sheet of 56px tiles
 *       'dock'       → floating bottom app dock (mobile tab-bar style)
 *       'maxipills'  → classic pills scaled as big as possible, wrapping
 *       'headerdock' → the app-dock item style inline in the header
 *       'tabsarrow'  → bold tabs + a scroll arrow at the end of the row
 *       'cardsarrow' → big chips + the same scroll arrow
 *
 *   - popupSystem: which popup system the whole site runs — flipped from
 *       /debug to A/B the behavioral rewrite against the original popups.
 *       'smart'            → research-timed install sheet + milestone
 *                            celebrations (no donate popup) — DEFAULT
 *       'original'         → the classic install banner (1h re-ask) +
 *                            the Ko-fi donation popup in the PWA
 *       'smart-firstvisit' → the smart system, but brand-new visitors
 *                            still see the classic install popup on
 *                            their very first visit
 *
 * Flags are flipped from /debug in one click; every client receives the
 * values server-side on load (page.tsx SSR) so a flip propagates on the
 * next page load with no wrong-design flash.
 *
 * AUTH for POST: same password gate as the analytics endpoints — SHA-256
 * hash comparison, timing-safe.
 */

// SHA-256 hash of the admin password (same one as /api/analytics/query).
const PASSWORD_HASH = '5c2113db1bd51e6e6fce4205d8eb36e41f5018d5d32d4c04b294fb02192f474a'

export type SubtopicNavMode =
  | 'cards' | 'classic' | 'tabs' | 'tiles' | 'sheet' | 'dock'
  | 'maxipills' | 'headerdock' | 'tabsarrow' | 'cardsarrow'

const VALID_MODES: SubtopicNavMode[] = [
  'cards', 'classic', 'tabs', 'tiles', 'sheet', 'dock',
  'maxipills', 'headerdock', 'tabsarrow', 'cardsarrow',
]
const NAV_FLAG_PATH = 'featureFlags/subtopicNav'
const POPUP_FLAG_PATH = 'featureFlags/popupSystem'

// Per-instance memos (10s) — bound Firebase reads when many clients hit
// this endpoint simultaneously on a warm serverless instance.
let navMemo: { value: SubtopicNavMode; ts: number } | null = null
let popupMemo: { value: PopupMode; ts: number } | null = null
const MEMO_TTL_MS = 10 * 1000

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function verifyPassword(input: string): boolean {
  const inputHash = sha256(input)
  if (inputHash.length !== PASSWORD_HASH.length) return false
  try {
    return timingSafeEqual(Buffer.from(inputHash), Buffer.from(PASSWORD_HASH))
  } catch {
    return false
  }
}

function normalizeMode(v: unknown): SubtopicNavMode {
  // Anything unknown (including values written by a FUTURE variant list)
  // safely degrades to the default 'cards' design.
  return VALID_MODES.includes(v as SubtopicNavMode) ? (v as SubtopicNavMode) : 'cards'
}

export async function GET() {
  // Both flags are fetched in parallel — one cold instance pays two RTDB
  // reads at most, then both answers are memoized together.
  const [navResult, popupResult] = await Promise.allSettled([
    (async () => {
      if (navMemo && Date.now() - navMemo.ts < MEMO_TTL_MS) return navMemo.value
      const stored = await firebaseRead<string>(NAV_FLAG_PATH)
      const value = normalizeMode(stored)
      navMemo = { value, ts: Date.now() }
      return value
    })(),
    (async () => {
      if (popupMemo && Date.now() - popupMemo.ts < MEMO_TTL_MS) return popupMemo.value
      const stored = await firebaseRead<string>(POPUP_FLAG_PATH)
      // A missing/unknown value safely degrades to the live smart system —
      // a bad flag must never resurrect the old popups.
      const value = normalizePopupMode(stored)
      popupMemo = { value, ts: Date.now() }
      return value
    })(),
  ])

  return NextResponse.json(
    {
      subtopicNav: navResult.status === 'fulfilled' ? navResult.value : 'cards',
      popupSystem:
        popupResult.status === 'fulfilled' ? popupResult.value : DEFAULT_POPUP_MODE,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function POST(req: NextRequest) {
  let body: { password?: string; subtopicNav?: string; popupSystem?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.password || !verifyPassword(body.password)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const wantsNav = body.subtopicNav !== undefined
  const wantsPopup = body.popupSystem !== undefined
  if (!wantsNav && !wantsPopup) {
    return NextResponse.json(
      { error: 'Provide subtopicNav and/or popupSystem to set' },
      { status: 400 },
    )
  }

  if (wantsNav && (!body.subtopicNav || !VALID_MODES.includes(body.subtopicNav as SubtopicNavMode))) {
    return NextResponse.json(
      { error: `subtopicNav must be one of: ${VALID_MODES.join(', ')}` },
      { status: 400 },
    )
  }
  if (wantsPopup && (!body.popupSystem || !POPUP_MODES.includes(body.popupSystem as PopupMode))) {
    return NextResponse.json(
      { error: `popupSystem must be one of: ${POPUP_MODES.join(', ')}` },
      { status: 400 },
    )
  }

  // Write whichever flags were provided (independent failures).
  if (wantsNav) {
    const ok = await firebaseWrite(NAV_FLAG_PATH, body.subtopicNav!)
    if (!ok) {
      return NextResponse.json({ error: 'Firebase write failed (subtopicNav)' }, { status: 500 })
    }
    navMemo = { value: body.subtopicNav as SubtopicNavMode, ts: Date.now() }
    console.log(`[flags] subtopicNav set to '${body.subtopicNav}' (applies to ALL users)`)
  }

  if (wantsPopup) {
    const ok = await firebaseWrite(POPUP_FLAG_PATH, body.popupSystem!)
    if (!ok) {
      return NextResponse.json({ error: 'Firebase write failed (popupSystem)' }, { status: 500 })
    }
    popupMemo = { value: body.popupSystem as PopupMode, ts: Date.now() }
    console.log(`[flags] popupSystem set to '${body.popupSystem}' (applies to ALL users)`)
  }

  return NextResponse.json({
    ok: true,
    ...(wantsNav ? { subtopicNav: body.subtopicNav } : {}),
    ...(wantsPopup ? { popupSystem: body.popupSystem } : {}),
  })
}
