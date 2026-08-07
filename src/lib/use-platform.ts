'use client'

/**
 * usePlatform — detect Android vs Apple vs Other and set a body class.
 *
 * Adds one of these classes to <body> on mount so CSS rules can target the
 * user's platform and apply the appropriate glass effect:
 *
 *   - `platform-android`  → Android phones (frosted glass: blur-xl + 80% bg)
 *   - `platform-apple`    → iPhone / iPad / iPod / Mac (liquid glass:
 *                           blur-2xl + 70% bg + saturation + subtle border)
 *   - `platform-other`    → Windows / Linux / desktop (no glass override —
 *                           the default sticky styles already include a
 *                           backdrop-blur + bg-background/95 fallback)
 *
 * Detection is CLIENT-SIDE only (navigator.userAgent). The hook runs after
 * mount, so SSR renders the page without any platform class — the class is
 * added by a `useEffect` once the JS bundle hydrates. This avoids hydration
 * mismatches because the server and client initial markup are identical.
 *
 * Usage:
 *   import { usePlatform } from '@/lib/use-platform'
 *   const platform = usePlatform()  // 'android' | 'apple' | 'other'
 *
 * The hook also writes the class to <body> automatically, so most code never
 * needs to read the return value — the CSS in globals.css takes care of
 * applying the right glass variant.
 */

import * as React from 'react'

export type Platform = 'android' | 'apple' | 'other'

/** Stable class names so consumers can use them without recomputing. */
export const PLATFORM_CLASS: Record<Platform, string> = {
  android: 'platform-android',
  apple: 'platform-apple',
  other: 'platform-other',
}

/**
 * Detect the user's platform from the user-agent string.
 *
 * - Android: explicit /Android/ in UA (covers Chrome, Samsung Internet,
 *   Firefox, Edge on Android).
 * - Apple: iPhone / iPad / iPod / Mac in UA, AND not Android (some browsers
 *   spoof iPad UA strings with "Android" inside, so we exclude Android first).
 * - Other: everything else (Windows, Linux, ChromeOS, etc.).
 *
 * Safe to call on the server — returns 'other' if `navigator` is undefined
 * (server-side rendering) or if the UA can't be parsed.
 */
export function detectPlatform(): Platform {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return 'other'
  }
  const ua = navigator.userAgent || ''
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod|Mac/i.test(ua)) return 'apple'
  return 'other'
}

/**
 * React hook that returns the current platform AND sets a body class on mount.
 *
 * Returns 'other' on the very first render (SSR + initial client render) so
 * the markup is identical between server and client — no hydration mismatch.
 * After mount, the hook reads navigator.userAgent and re-renders with the
 * detected platform.
 *
 * The body class is set in a useEffect so the platform class doesn't appear
 * in the server-rendered HTML (it would if we set it during render, because
 * React would render once on the client with the platform class BEFORE
 * hydrating, causing a mismatch warning).
 */
export function usePlatform(): Platform {
  const [platform, setPlatform] = React.useState<Platform>('other')

  React.useEffect(() => {
    const detected = detectPlatform()
    setPlatform(detected)
    if (typeof document !== 'undefined' && document.body) {
      // Remove any stale platform class from a previous mount, then add the
      // current one. This is safe to call repeatedly — the second call is a
      // no-op because the class already exists.
      document.body.classList.remove(
        PLATFORM_CLASS.android,
        PLATFORM_CLASS.apple,
        PLATFORM_CLASS.other,
      )
      document.body.classList.add(PLATFORM_CLASS[detected])
    }
  }, [])

  return platform
}
