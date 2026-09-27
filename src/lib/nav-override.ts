/**
 * nav-override.ts — per-user subtopic-header style override.
 *
 * The homepage category header has TEN selectable designs. Two layers:
 *
 *   1. SITE-WIDE DEFAULT (admin): Firebase flag at featureFlags/subtopicNav,
 *      flipped from Account → Feature Flags (password-protected) or /debug.
 *      Applies to everyone within seconds (5s server memo).
 *   2. PERSONAL OVERRIDE (any user): a cookie picked in Account → Feature
 *      Flags → "Your header style". No login needed — it's stored on the
 *      visitor's own device and beats the site default for THEM only.
 *
 * WHY A COOKIE (not localStorage): the homepage is server-rendered, and the
 * server can read cookies but NOT localStorage. page.tsx reads `nw_nav`
 * during SSR, so a returning visitor's own design is in the FIRST paint —
 * the same zero-flash guarantee the global flag has. localStorage would
 * force a default-then-swap flash on every refresh.
 *
 * Live changes (picked while the homepage is open behind the Account
 * overlay) travel via a CustomEvent — see NAV_STYLE_EVENT.
 */

export const NAV_OVERRIDE_COOKIE = 'nw_nav'
export const NAV_STYLE_EVENT = 'nw:navstyle'

export type NavMode =
  | 'cards' | 'classic' | 'tabs' | 'tiles' | 'sheet' | 'dock'
  | 'maxipills' | 'headerdock' | 'tabsarrow' | 'cardsarrow'

export const NAV_MODES: NavMode[] = [
  'cards', 'classic', 'tabs', 'tiles', 'sheet', 'dock',
  'maxipills', 'headerdock', 'tabsarrow', 'cardsarrow',
]

function parseCookieValue(name: string): string | null {
  if (typeof document === 'undefined') return null
  try {
    const prefix = name + '='
    for (const part of document.cookie.split(';')) {
      const p = part.trim()
      if (p.startsWith(prefix)) {
        return decodeURIComponent(p.slice(prefix.length))
      }
    }
  } catch {}
  return null
}

/** The visitor's personal override, or null when following the site default. */
export function readNavOverride(): NavMode | null {
  const v = parseCookieValue(NAV_OVERRIDE_COOKIE)
  return v && (NAV_MODES as string[]).includes(v) ? (v as NavMode) : null
}

/**
 * Save (or clear, when mode is null) the personal override. One year,
 * device-local, SameSite=Lax, path=/ so every page load sends it to the
 * server for SSR.
 */
export function writeNavOverride(mode: NavMode | null): void {
  if (typeof document === 'undefined') return
  try {
    if (mode === null) {
      document.cookie = `${NAV_OVERRIDE_COOKIE}=; Max-Age=0; path=/; SameSite=Lax`
    } else {
      document.cookie = `${NAV_OVERRIDE_COOKIE}=${mode}; Max-Age=31536000; path=/; SameSite=Lax`
    }
  } catch {}
}

/**
 * Tell the (already-mounted) homepage to switch header design right now —
 * no refresh needed. `mode` is the EFFECTIVE design (the personal pick, or
 * the site default when the user chose "Follow site default").
 */
export function announceNavStyle(mode: NavMode): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(NAV_STYLE_EVENT, { detail: mode }))
}
