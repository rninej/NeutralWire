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
 * GET  /api/flags   → { subtopicNav, popupSystem, notifLike, videoWatch, videoPreview, milestoneDonate }   (public)
 * POST /api/flags   → set flag(s) for ALL users (password-protected)
 *       body: { password, subtopicNav?, popupSystem?, notifLike?, videoWatch?, videoPreview?, milestoneDonate? }
 *       — send one or more.
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
 *   - notifLike (boolean, default TRUE): the Like action button on push
 *       notifications. When on, every news notification carries a
 *       [Like | Not Interested] pair — tapping Like opens the article,
 *       auto-presses its like button and nudges the story up the
 *       rankings for that user (strong) and everyone else (a bit).
 *       Flipped off in /debug → new notifications ship without the
 *       button (the SW reads the flag from the payload at push time).
 *
 *   - videoWatch (boolean, default TRUE): the experimental Watch button
 *       on article images. Tapping it resolves a video for the story (the
 *       source's own video via RSS enclosures, else a YouTube search match)
 *       and plays it INLINE inside the news image. Flipped off in /debug
 *       → the buttons vanish on the next page load AND the /api/video
 *       endpoint refuses to resolve (no CPU spent).
 *
 *   - videoPreview (boolean, default FALSE): the experimental top-story
 *       video preview on the home feed — the top news card (the big hero
 *       card with the NW icon) starts playing a MUTED video preview
 *       inside its image ~0.8s after it has been on screen. Flipped on
 *       from /debug → live for every visitor on the next page load.
 *
 *   - milestoneDonate (boolean, default TRUE): which body the PWA's
 *       milestone popup carries after "N stories read" — the user-facing
 *       ask "If you love NeutralWire's free mission, Please Donate" + a
 *       real Donate-on-Ko-fi button (true, the default), or the ORIGINAL
 *       celebration-only version (progress bar + community love +
 *       share; false). Only affects the smart popup modes — the
 *       'original' popupSystem already brings back the classic Ko-fi
 *       donate popup.
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
const NOTIF_LIKE_FLAG_PATH = 'featureFlags/notifLike'
const VIDEO_FLAG_PATH = 'featureFlags/videoWatch'
const VIDEO_PREVIEW_FLAG_PATH = 'featureFlags/videoPreview'
const MILESTONE_DONATE_FLAG_PATH = 'featureFlags/milestoneDonate'

// Per-instance memos (10s) — bound Firebase reads when many clients hit
// this endpoint simultaneously on a warm serverless instance.
let navMemo: { value: SubtopicNavMode; ts: number } | null = null
let popupMemo: { value: PopupMode; ts: number } | null = null
let notifLikeMemo: { value: boolean; ts: number } | null = null
let videoMemo: { value: boolean; ts: number } | null = null
let videoPreviewMemo: { value: boolean; ts: number } | null = null
let milestoneDonateMemo: { value: boolean; ts: number } | null = null
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

function normalizeBooleanFlag(v: unknown, fallback: boolean): boolean {
  // Firebase RTDB stores booleans natively; treat null/undefined (never
  // set) as the DEFAULT so a fresh install behaves like the intended live
  // experience, and legacy strings ('true'/'false') as their booleans.
  if (v === null || v === undefined || v === '') return fallback
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

export async function GET() {
  // All flags are fetched in parallel — one cold instance pays the
  // RTDB reads at most, then all answers are memoized together.
  const [navResult, popupResult, notifLikeResult, videoResult, videoPreviewResult, milestoneDonateResult] = await Promise.allSettled([
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
    (async () => {
      if (notifLikeMemo && Date.now() - notifLikeMemo.ts < MEMO_TTL_MS) return notifLikeMemo.value
      const stored = await firebaseRead<boolean>(NOTIF_LIKE_FLAG_PATH)
      const value = normalizeBooleanFlag(stored, true)
      notifLikeMemo = { value, ts: Date.now() }
      return value
    })(),
    (async () => {
      if (videoMemo && Date.now() - videoMemo.ts < MEMO_TTL_MS) return videoMemo.value
      const stored = await firebaseRead<boolean>(VIDEO_FLAG_PATH)
      const value = normalizeBooleanFlag(stored, true)
      videoMemo = { value, ts: Date.now() }
      return value
    })(),
    (async () => {
      if (videoPreviewMemo && Date.now() - videoPreviewMemo.ts < MEMO_TTL_MS) return videoPreviewMemo.value
      const stored = await firebaseRead<boolean>(VIDEO_PREVIEW_FLAG_PATH)
      // DEFAULT OFF — a pure experiment; only an explicit true turns it on.
      const value = normalizeBooleanFlag(stored, false)
      videoPreviewMemo = { value, ts: Date.now() }
      return value
    })(),
    (async () => {
      if (milestoneDonateMemo && Date.now() - milestoneDonateMemo.ts < MEMO_TTL_MS) return milestoneDonateMemo.value
      const stored = await firebaseRead<boolean>(MILESTONE_DONATE_FLAG_PATH)
      // DEFAULT ON — the donate message is the live version (user spec);
      // an explicit false restores the original celebration-only popup.
      const value = normalizeBooleanFlag(stored, true)
      milestoneDonateMemo = { value, ts: Date.now() }
      return value
    })(),
  ])

  // ── CDN cache (Fluid CPU) ──
  // The memo above already dedupes Firebase reads per warm instance;
  // this header lets the Vercel edge cache serve the (rarely-changing)
  // flag payload for 60s WITHOUT invoking the function at all, and serve
  // it stale for up to 2 min while one background revalidation runs.
  // The value the user actually SEES still comes from the page's SSR
  // (page.tsx reads Firebase directly, 5s memo) — so a flag flip from
  // /debug is live on the next page load exactly as before; only this
  // mount-time safety-net fetch can lag ≤60s, which it already could
  // (the old 10s per-instance memo). The POST path is never cached —
  // a flip still propagates to every warm instance's memo instantly.
  return NextResponse.json(
    {
      subtopicNav: navResult.status === 'fulfilled' ? navResult.value : 'cards',
      popupSystem:
        popupResult.status === 'fulfilled' ? popupResult.value : DEFAULT_POPUP_MODE,
      notifLike:
        notifLikeResult.status === 'fulfilled' ? notifLikeResult.value : true,
      videoWatch: videoResult.status === 'fulfilled' ? videoResult.value : true,
      videoPreview:
        videoPreviewResult.status === 'fulfilled' ? videoPreviewResult.value : false,
      milestoneDonate:
        milestoneDonateResult.status === 'fulfilled' ? milestoneDonateResult.value : true,
    },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
      },
    },
  )
}

export async function POST(req: NextRequest) {
  let body: {
    password?: string
    subtopicNav?: string
    popupSystem?: string
    notifLike?: boolean | string
    videoWatch?: boolean | string
    videoPreview?: boolean | string
    milestoneDonate?: boolean | string
  }
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
  const wantsNotifLike = body.notifLike !== undefined
  const wantsVideo = body.videoWatch !== undefined
  const wantsVideoPreview = body.videoPreview !== undefined
  const wantsMilestoneDonate = body.milestoneDonate !== undefined
  if (!wantsNav && !wantsPopup && !wantsNotifLike && !wantsVideo && !wantsVideoPreview && !wantsMilestoneDonate) {
    return NextResponse.json(
      {
        error:
          'Provide subtopicNav, popupSystem, notifLike, videoWatch, videoPreview and/or milestoneDonate to set',
      },
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

  if (wantsNotifLike) {
    const notifLike = normalizeBooleanFlag(body.notifLike, true)
    const ok = await firebaseWrite(NOTIF_LIKE_FLAG_PATH, notifLike)
    if (!ok) {
      return NextResponse.json({ error: 'Firebase write failed (notifLike)' }, { status: 500 })
    }
    notifLikeMemo = { value: notifLike, ts: Date.now() }
    console.log(`[flags] notifLike set to '${notifLike}' (applies to ALL users)`)
  }

  if (wantsVideo) {
    const videoWatch = normalizeBooleanFlag(body.videoWatch, true)
    const ok = await firebaseWrite(VIDEO_FLAG_PATH, videoWatch)
    if (!ok) {
      return NextResponse.json({ error: 'Firebase write failed (videoWatch)' }, { status: 500 })
    }
    videoMemo = { value: videoWatch, ts: Date.now() }
    console.log(`[flags] videoWatch set to '${videoWatch}' (applies to ALL users)`)
  }

  if (wantsVideoPreview) {
    const videoPreview = normalizeBooleanFlag(body.videoPreview, false)
    const ok = await firebaseWrite(VIDEO_PREVIEW_FLAG_PATH, videoPreview)
    if (!ok) {
      return NextResponse.json({ error: 'Firebase write failed (videoPreview)' }, { status: 500 })
    }
    videoPreviewMemo = { value: videoPreview, ts: Date.now() }
    console.log(`[flags] videoPreview set to '${videoPreview}' (applies to ALL users)`)
  }

  if (wantsMilestoneDonate) {
    const milestoneDonate = normalizeBooleanFlag(body.milestoneDonate, true)
    const ok = await firebaseWrite(MILESTONE_DONATE_FLAG_PATH, milestoneDonate)
    if (!ok) {
      return NextResponse.json({ error: 'Firebase write failed (milestoneDonate)' }, { status: 500 })
    }
    milestoneDonateMemo = { value: milestoneDonate, ts: Date.now() }
    console.log(`[flags] milestoneDonate set to '${milestoneDonate}' (applies to ALL users)`)
  }

  return NextResponse.json({
    ok: true,
    ...(wantsNav ? { subtopicNav: body.subtopicNav } : {}),
    ...(wantsPopup ? { popupSystem: body.popupSystem } : {}),
    ...(wantsNotifLike ? { notifLike: normalizeBooleanFlag(body.notifLike, true) } : {}),
    ...(wantsVideo ? { videoWatch: normalizeBooleanFlag(body.videoWatch, true) } : {}),
    ...(wantsVideoPreview ? { videoPreview: normalizeBooleanFlag(body.videoPreview, false) } : {}),
    ...(wantsMilestoneDonate ? { milestoneDonate: normalizeBooleanFlag(body.milestoneDonate, true) } : {}),
  })
}
