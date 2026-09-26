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
 * GET  /api/flags   → { subtopicNav, popupSystem, notifLike, notifRaiseFix, videoWatch, videoPreview, milestoneDonate, meshRelay, userCron, monetizationModel }   (public)
 * POST /api/flags   → set flag(s) for ALL users (password-protected)
 *       body: { password, subtopicNav?, popupSystem?, notifLike?, notifRaiseFix?, videoWatch?, videoPreview?, milestoneDonate?, meshRelay?, userCron?, monetizationModel? }
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
 *   - notifRaiseFix (boolean, default TRUE): the v27 notification
 *       RAISE VERIFICATION in sw.js. On Android Chrome, tapping a
 *       notification while the installed app idles in the background
 *       opened the story INSIDE the hidden app without ever bringing
 *       the window to the foreground (WindowClient.focus() resolves
 *       without raising) — and the notification's Like button looked
 *       dead for the same reason. With the fix ON, the SW verifies the
 *       window actually became visible after focus() and, when it
 *       didn't, re-raises it via clients.openWindow() (the cold-start
 *       path, which always works). Flipped OFF in /debug → the SW's
 *       click handler returns to the previous focus-trusting logic
 *       (next notification tap, after the flag mirror propagates).
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
 *   - meshRelay (boolean, default TRUE): the experimental P2P news
 *       relay. Visitors in the same feed room (same category + country)
 *       serve each other the news over WebRTC data channels — one relay
 *       per room reads Firebase directly and pushes verified snapshots
 *       to everyone else, cutting /api/news invocations and Firebase
 *       bandwidth from O(users) to O(rooms). Integrity is enforced by
 *       server-signed manifests (ECDSA) + 3-peer consensus at scale;
 *       any verification failure fails CLOSED to the normal server
 *       path. Flip off in /debug → every visitor loads the classic way
 *       on their next page load.
 *
 *   - userCron (boolean, default TRUE): the experimental user-powered
 *       cron. The oldest live visitor checks job staleness every minute
 *       and triggers the RSS refresh + timezone-aware notification send
 *       through one-time Firebase leases (server-enforced interval
 *       floors). Server invocations happen only while visitors are
 *       actually online; an external cron service still works as a
 *       backstop (both paths dedupe). Flip off in /debug → the schedule
 *       pauses until an external cron hits the endpoints.
 *
 * Flags are flipped from /debug in one click; every client receives the
 * values server-side on load (page.tsx SSR) so a flip propagates on the
 * next page load with no wrong-design flash.
 *
 *   - monetizationModel: 'subscription' | 'donation' — THE MONETIZATION
 *       SWITCH. 'subscription' (default) runs the tier model: free tier
 *       keeps the full classic experience (aggregation, bias bar, full
 *       articles, sources, PWA) while premium/ultra gates (custom
 *       subtopics, archive search >3mo, email digest, gradient themes,
 *       personal flags, API/export) are enforced. 'donation' flips the
 *       whole site back to the ORIGINAL Ko-fi donation model — every
 *       premium gate stands down and the classic donate popups return.
 *       Flipped from /debug → next page load is the old site again.
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
const NOTIF_RAISE_FIX_FLAG_PATH = 'featureFlags/notifRaiseFix'
const VIDEO_FLAG_PATH = 'featureFlags/videoWatch'
const VIDEO_PREVIEW_FLAG_PATH = 'featureFlags/videoPreview'
const MILESTONE_DONATE_FLAG_PATH = 'featureFlags/milestoneDonate'
const MESH_RELAY_FLAG_PATH = 'featureFlags/meshRelay'
const USER_CRON_FLAG_PATH = 'featureFlags/userCron'
const MONETIZATION_MODEL_FLAG_PATH = 'featureFlags/monetizationModel'

// Per-instance memos (10s) — bound Firebase reads when many clients hit
// this endpoint simultaneously on a warm serverless instance.
let navMemo: { value: SubtopicNavMode; ts: number } | null = null
let popupMemo: { value: PopupMode; ts: number } | null = null
let notifLikeMemo: { value: boolean; ts: number } | null = null
let notifRaiseFixMemo: { value: boolean; ts: number } | null = null
let videoMemo: { value: boolean; ts: number } | null = null
let videoPreviewMemo: { value: boolean; ts: number } | null = null
let milestoneDonateMemo: { value: boolean; ts: number } | null = null
let meshRelayMemo: { value: boolean; ts: number } | null = null
let userCronMemo: { value: boolean; ts: number } | null = null
let monetizationMemo: { value: 'subscription' | 'donation'; ts: number } | null = null
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
  const [navResult, popupResult, notifLikeResult, notifRaiseFixResult, videoResult, videoPreviewResult, milestoneDonateResult, meshRelayResult, userCronResult, monetizationResult] = await Promise.allSettled([
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
      if (notifRaiseFixMemo && Date.now() - notifRaiseFixMemo.ts < MEMO_TTL_MS) return notifRaiseFixMemo.value
      const stored = await firebaseRead<boolean>(NOTIF_RAISE_FIX_FLAG_PATH)
      const value = normalizeBooleanFlag(stored, true)
      notifRaiseFixMemo = { value, ts: Date.now() }
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
    (async () => {
      if (meshRelayMemo && Date.now() - meshRelayMemo.ts < MEMO_TTL_MS) return meshRelayMemo.value
      const stored = await firebaseRead<boolean>(MESH_RELAY_FLAG_PATH)
      // DEFAULT ON — the user asked for the experiment live by default;
      // an explicit false turns the P2P relay off for everyone.
      const value = normalizeBooleanFlag(stored, true)
      meshRelayMemo = { value, ts: Date.now() }
      return value
    })(),
    (async () => {
      if (userCronMemo && Date.now() - userCronMemo.ts < MEMO_TTL_MS) return userCronMemo.value
      const stored = await firebaseRead<boolean>(USER_CRON_FLAG_PATH)
      // DEFAULT ON — visitors drive the cron schedule while online;
      // an explicit false pauses client-driven triggering.
      const value = normalizeBooleanFlag(stored, true)
      userCronMemo = { value, ts: Date.now() }
      return value
    })(),
    (async () => {
      if (monetizationMemo && Date.now() - monetizationMemo.ts < MEMO_TTL_MS) return monetizationMemo.value
      const stored = await firebaseRead<string>(MONETIZATION_MODEL_FLAG_PATH)
      // DEFAULT SUBSCRIPTION — the tier model is the live experience;
      // an explicit 'donation' flips the whole site back.
      const value = stored === 'donation' ? 'donation' : 'subscription'
      monetizationMemo = { value, ts: Date.now() }
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
      notifRaiseFix:
        notifRaiseFixResult.status === 'fulfilled' ? notifRaiseFixResult.value : true,
      videoWatch: videoResult.status === 'fulfilled' ? videoResult.value : true,
      videoPreview:
        videoPreviewResult.status === 'fulfilled' ? videoPreviewResult.value : false,
      milestoneDonate:
        milestoneDonateResult.status === 'fulfilled' ? milestoneDonateResult.value : true,
      meshRelay:
        meshRelayResult.status === 'fulfilled' ? meshRelayResult.value : true,
      userCron:
        userCronResult.status === 'fulfilled' ? userCronResult.value : true,
      monetizationModel:
        monetizationResult.status === 'fulfilled'
          ? monetizationResult.value
          : 'subscription',
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
    notifRaiseFix?: boolean | string
    videoWatch?: boolean | string
    videoPreview?: boolean | string
    milestoneDonate?: boolean | string
    meshRelay?: boolean | string
    userCron?: boolean | string
    monetizationModel?: string
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
  const wantsNotifRaiseFix = body.notifRaiseFix !== undefined
  const wantsVideo = body.videoWatch !== undefined
  const wantsVideoPreview = body.videoPreview !== undefined
  const wantsMilestoneDonate = body.milestoneDonate !== undefined
  const wantsMeshRelay = body.meshRelay !== undefined
  const wantsUserCron = body.userCron !== undefined
  const wantsMonetization = body.monetizationModel !== undefined
  if (!wantsNav && !wantsPopup && !wantsNotifLike && !wantsNotifRaiseFix && !wantsVideo && !wantsVideoPreview && !wantsMilestoneDonate && !wantsMeshRelay && !wantsUserCron && !wantsMonetization) {
    return NextResponse.json(
      {
        error:
          'Provide subtopicNav, popupSystem, notifLike, notifRaiseFix, videoWatch, videoPreview, milestoneDonate, meshRelay, userCron and/or monetizationModel to set',
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
  if (wantsMonetization && body.monetizationModel !== 'donation' && body.monetizationModel !== 'subscription') {
    return NextResponse.json(
      { error: 'monetizationModel must be donation or subscription' },
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

  if (wantsNotifRaiseFix) {
    const notifRaiseFix = normalizeBooleanFlag(body.notifRaiseFix, true)
    const ok = await firebaseWrite(NOTIF_RAISE_FIX_FLAG_PATH, notifRaiseFix)
    if (!ok) {
      return NextResponse.json({ error: 'Firebase write failed (notifRaiseFix)' }, { status: 500 })
    }
    notifRaiseFixMemo = { value: notifRaiseFix, ts: Date.now() }
    console.log(`[flags] notifRaiseFix set to '${notifRaiseFix}' (applies to ALL users)`)
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

  if (wantsMeshRelay) {
    const meshRelay = normalizeBooleanFlag(body.meshRelay, true)
    const ok = await firebaseWrite(MESH_RELAY_FLAG_PATH, meshRelay)
    if (!ok) {
      return NextResponse.json({ error: 'Firebase write failed (meshRelay)' }, { status: 500 })
    }
    meshRelayMemo = { value: meshRelay, ts: Date.now() }
    console.log(`[flags] meshRelay set to '${meshRelay}' (applies to ALL users)`)
  }

  if (wantsUserCron) {
    const userCron = normalizeBooleanFlag(body.userCron, true)
    const ok = await firebaseWrite(USER_CRON_FLAG_PATH, userCron)
    if (!ok) {
      return NextResponse.json({ error: 'Firebase write failed (userCron)' }, { status: 500 })
    }
    userCronMemo = { value: userCron, ts: Date.now() }
    console.log(`[flags] userCron set to '${userCron}' (applies to ALL users)`)
  }

  if (wantsMonetization) {
    const monetizationModel = body.monetizationModel === 'donation' ? 'donation' : 'subscription'
    const ok = await firebaseWrite(MONETIZATION_MODEL_FLAG_PATH, monetizationModel)
    if (!ok) {
      return NextResponse.json({ error: 'Firebase write failed (monetizationModel)' }, { status: 500 })
    }
    monetizationMemo = { value: monetizationModel, ts: Date.now() }
    console.log(`[flags] monetizationModel set to '${monetizationModel}' (applies to ALL users)`)
  }

  return NextResponse.json({
    ok: true,
    ...(wantsNav ? { subtopicNav: body.subtopicNav } : {}),
    ...(wantsPopup ? { popupSystem: body.popupSystem } : {}),
    ...(wantsNotifLike ? { notifLike: normalizeBooleanFlag(body.notifLike, true) } : {}),
    ...(wantsNotifRaiseFix ? { notifRaiseFix: normalizeBooleanFlag(body.notifRaiseFix, true) } : {}),
    ...(wantsVideo ? { videoWatch: normalizeBooleanFlag(body.videoWatch, true) } : {}),
    ...(wantsVideoPreview ? { videoPreview: normalizeBooleanFlag(body.videoPreview, false) } : {}),
    ...(wantsMilestoneDonate ? { milestoneDonate: normalizeBooleanFlag(body.milestoneDonate, true) } : {}),
    ...(wantsMeshRelay ? { meshRelay: normalizeBooleanFlag(body.meshRelay, true) } : {}),
    ...(wantsUserCron ? { userCron: normalizeBooleanFlag(body.userCron, true) } : {}),
    ...(wantsMonetization ? { monetizationModel: body.monetizationModel } : {}),
  })
}
