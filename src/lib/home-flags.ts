import { firebaseRead } from '@/lib/firebase-server'
import { normalizePopupMode, type PopupMode } from '@/lib/popup-mode'

/**
 * home-flags.ts — the server-side feature-flag readers shared by BOTH
 * home variants:
 *
 *   src/app/page.tsx    the dynamic '/' (force-dynamic — ?topic= OG
 *                      lookups + the per-user nw_nav cookie override)
 *   src/app/home/page.tsx  the ISR '/home' shell (Nov 17, 2026 CPU fix —
 *                      plain, query-less, cookie-less navigations to '/'
 *                      are rewritten there by middleware and served from
 *                      the ISR cache; see src/middleware.ts)
 *
 * Extracted verbatim from page.tsx when the ISR variant was added so the
 * two variants can NEVER drift: same flags, same defaults, same 5s
 * module-level memos (shared because this module is a singleton per
 * serverless instance — one Firebase read per flag per 5s per instance,
 * no matter which variant is rendering).
 *
 * ── BUILD PHASE (why readFlagAtBuild exists) ──
 * `next build` prerenders the ISR /home shell. During static generation
 * Next.js FORBIDS `cache: 'no-store'` fetches — firebaseRead uses them
 * (correctly, for live freshness), and a no-store fetch in prerender
 * throws "Dynamic server usage" and silently demotes the whole route to
 * fully-dynamic (no ISR, full render per crawl — the exact burn this
 * module exists to prevent). So while NEXT_PHASE === phase-production-
 * build we read each flag with an explicit `cache: 'force-cache'` fetch
 * (allowed in prerender) — the REAL current values get baked into the
 * prerendered shell. On any failure the default is served, same as the
 * runtime catch. At runtime (Vercel serving) the normal firebaseRead +
 * 5s-memo path runs — /story/[id] proves Firebase reads inside ISR
 * regens work fine there.
 */

const DB_URL =
  process.env.FB_DB_URL ||
  'https://neutralwire-aaedf-default-rtdb.europe-west1.firebasedatabase.app'

const IS_BUILD = process.env.NEXT_PHASE === 'phase-production-build'

async function readFlagAtBuild<T>(path: string): Promise<T | null> {
  // cache: 'force-cache' keeps the fetch legal inside static generation;
  // the value lands in the build-time data cache AND in the prerender.
  try {
    const res = await fetch(`${DB_URL}/${path}.json`, {
      cache: 'force-cache',
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** One read for one flag, through the right path for the current phase. */
async function readFlag<T>(path: string): Promise<T | null> {
  if (IS_BUILD) return readFlagAtBuild<T>(path)
  try {
    return await firebaseRead<T>(path)
  } catch {
    return null
  }
}

export type SubtopicNavMode =
  | 'cards' | 'classic' | 'tabs' | 'tiles' | 'sheet' | 'dock'
  | 'maxipills' | 'headerdock' | 'tabsarrow' | 'cardsarrow'

export const NAV_MODES: SubtopicNavMode[] = [
  'cards', 'classic', 'tabs', 'tiles', 'sheet', 'dock',
  'maxipills', 'headerdock', 'tabsarrow', 'cardsarrow',
]

// ── Server-rendered subtopic-nav flag ──────────────────────────────────
// The homepage category header has TEN selectable designs, switched for
// ALL users from /debug (stored in Firebase at featureFlags/subtopicNav).
// Server-side so the first paint already uses the right design (no flash)
// for both variants; the per-user nw_nav override is applied by the
// DYNAMIC variant only (the ISR shell renders the site-wide default).
let navFlagMemo: { value: SubtopicNavMode; ts: number } | null = null
const NAV_FLAG_TTL_MS = 5 * 1000

export async function getSubtopicNav(): Promise<SubtopicNavMode> {
  if (navFlagMemo && Date.now() - navFlagMemo.ts < NAV_FLAG_TTL_MS) {
    return navFlagMemo.value
  }
  try {
    const stored = await readFlag<string>('featureFlags/subtopicNav')
    const value = NAV_MODES.includes(stored as SubtopicNavMode)
      ? (stored as SubtopicNavMode)
      : 'cards'
    navFlagMemo = { value, ts: Date.now() }
    return value
  } catch {
    return 'cards'
  }
}

// ── Server-rendered popup-system flag ──────────────────────────────
let popupFlagMemo: { value: PopupMode; ts: number } | null = null
const POPUP_FLAG_TTL_MS = 5 * 1000

export async function getPopupSystem(): Promise<PopupMode> {
  if (popupFlagMemo && Date.now() - popupFlagMemo.ts < POPUP_FLAG_TTL_MS) {
    return popupFlagMemo.value
  }
  try {
    const stored = await readFlag<string>('featureFlags/popupSystem')
    const value = normalizePopupMode(stored)
    popupFlagMemo = { value, ts: Date.now() }
    return value
  } catch {
    return 'smart'
  }
}

// ── Server-rendered videoWatch flag (experimental Watch button) ──
let videoFlagMemo: { value: boolean; ts: number } | null = null
const VIDEO_FLAG_TTL_MS = 5 * 1000

export async function getVideoWatch(): Promise<boolean> {
  if (videoFlagMemo && Date.now() - videoFlagMemo.ts < VIDEO_FLAG_TTL_MS) {
    return videoFlagMemo.value
  }
  try {
    const stored = await readFlag<boolean | string>('featureFlags/videoWatch')
    const value = !(stored === false || stored === 'false')
    videoFlagMemo = { value, ts: Date.now() }
    return value
  } catch {
    return true
  }
}

// ── Server-rendered videoPreview flag (experimental top-story preview) ──
let videoPreviewFlagMemo: { value: boolean; ts: number } | null = null

export async function getVideoPreview(): Promise<boolean> {
  if (videoPreviewFlagMemo && Date.now() - videoPreviewFlagMemo.ts < 5 * 1000) {
    return videoPreviewFlagMemo.value
  }
  try {
    const stored = await readFlag<boolean | string>('featureFlags/videoPreview')
    const value = stored === true || stored === 'true'
    videoPreviewFlagMemo = { value, ts: Date.now() }
    return value
  } catch {
    return false
  }
}

// ── Server-rendered milestoneDonate flag (popup body version) ──
let milestoneDonateFlagMemo: { value: boolean; ts: number } | null = null

export async function getMilestoneDonate(): Promise<boolean> {
  if (milestoneDonateFlagMemo && Date.now() - milestoneDonateFlagMemo.ts < 5 * 1000) {
    return milestoneDonateFlagMemo.value
  }
  try {
    const stored = await readFlag<boolean | string>('featureFlags/milestoneDonate')
    const value = !(stored === false || stored === 'false')
    milestoneDonateFlagMemo = { value, ts: Date.now() }
    return value
  } catch {
    return true
  }
}

// ── Server-rendered mesh flags (P2P relay + user-powered cron) ──
let meshRelayFlagMemo: { value: boolean; ts: number } | null = null
let userCronFlagMemo: { value: boolean; ts: number } | null = null

export async function getMeshRelay(): Promise<boolean> {
  if (meshRelayFlagMemo && Date.now() - meshRelayFlagMemo.ts < 5 * 1000) {
    return meshRelayFlagMemo.value
  }
  try {
    const stored = await readFlag<boolean | string>('featureFlags/meshRelay')
    const value = !(stored === false || stored === 'false')
    meshRelayFlagMemo = { value, ts: Date.now() }
    return value
  } catch {
    return true
  }
}

export async function getUserCron(): Promise<boolean> {
  if (userCronFlagMemo && Date.now() - userCronFlagMemo.ts < 5 * 1000) {
    return userCronFlagMemo.value
  }
  try {
    const stored = await readFlag<boolean | string>('featureFlags/userCron')
    const value = !(stored === false || stored === 'false')
    userCronFlagMemo = { value, ts: Date.now() }
    return value
  } catch {
    return true
  }
}

// ── Server-rendered notification raise-fix flag ──
let notifRaiseFixFlagMemo: { value: boolean; ts: number } | null = null

export async function getNotifRaiseFix(): Promise<boolean> {
  if (notifRaiseFixFlagMemo && Date.now() - notifRaiseFixFlagMemo.ts < 5 * 1000) {
    return notifRaiseFixFlagMemo.value
  }
  try {
    const stored = await readFlag<boolean | string>('featureFlags/notifRaiseFix')
    const value = !(stored === false || stored === 'false')
    notifRaiseFixFlagMemo = { value, ts: Date.now() }
    return value
  } catch {
    return true
  }
}

// ── Server-rendered Interest Engine v2 flag (smartPersonalization) ──
let smartPersonalizationFlagMemo: { value: boolean; ts: number } | null = null

export async function getSmartPersonalization(): Promise<boolean> {
  if (smartPersonalizationFlagMemo && Date.now() - smartPersonalizationFlagMemo.ts < 5 * 1000) {
    return smartPersonalizationFlagMemo.value
  }
  try {
    const stored = await readFlag<boolean | string>('featureFlags/smartPersonalization')
    const value = !(stored === false || stored === 'false')
    smartPersonalizationFlagMemo = { value, ts: Date.now() }
    return value
  } catch {
    return true
  }
}

// ── Server-rendered monetization model flag ──
let monetizationModelFlagMemo: { value: 'subscription' | 'donation' | 'free'; ts: number } | null = null

export async function getMonetizationModel(): Promise<'subscription' | 'donation' | 'free'> {
  if (monetizationModelFlagMemo && Date.now() - monetizationModelFlagMemo.ts < 5 * 1000) {
    return monetizationModelFlagMemo.value
  }
  try {
    const stored = await readFlag<string>('featureFlags/monetizationModel')
    const value = stored === 'donation' ? 'donation' : stored === 'free' ? 'free' : 'subscription'
    monetizationModelFlagMemo = { value, ts: Date.now() }
    return value
  } catch {
    return 'subscription'
  }
}

/** One call: every flag the home shell needs, in one object. */
export async function readHomeFlags() {
  const [
    initialSubtopicNav,
    popupSystem,
    videoWatch,
    videoPreview,
    milestoneDonate,
    meshRelay,
    userCron,
    notifRaiseFix,
    smartPersonalization,
    monetizationModel,
  ] = await Promise.all([
    getSubtopicNav(),
    getPopupSystem(),
    getVideoWatch(),
    getVideoPreview(),
    getMilestoneDonate(),
    getMeshRelay(),
    getUserCron(),
    getNotifRaiseFix(),
    getSmartPersonalization(),
    getMonetizationModel(),
  ])
  return {
    initialSubtopicNav,
    popupSystem,
    videoWatch,
    videoPreview,
    milestoneDonate,
    meshRelay,
    userCron,
    notifRaiseFix,
    smartPersonalization,
    monetizationModel,
  }
}
