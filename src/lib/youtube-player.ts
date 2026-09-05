'use client'

/**
 * youtube-player.ts — the official YouTube IFrame Player API, loaded
 * once per page and shared by every embedded player (the home-feed
 * video preview and the article's inline player).
 *
 * WHY the JS API instead of a bare <iframe src="...autoplay=1">:
 *   1. PLAY-STATE VISIBILITY. A bare iframe shows YouTube's own black
 *      loading frame while the player spins up — exactly the "black
 *      screen with loading animation" the user rejected. With the API
 *      we get onStateChange(PLAYING) and can keep the player INVISIBLE
 *      (opacity 0, over the news photo) until it is genuinely rolling,
 *      then fade it in — the image is never replaced by a spinner.
 *   2. VOLUME CONTROL. The preview must play at HALF volume (user
 *      spec) — setVolume(50) is only available through the API.
 *   3. UNMUTED AUTOPLAY with a graceful fallback. The preview wants
 *      sound (half volume); when the browser's autoplay policy blocks
 *      it, onAutoplayBlocked / a short timeout lets us retry muted so
 *      the preview still plays (chip switches to the muted mark).
 *
 * The API script (youtube.com/iframe_api) is appended once; the global
 * onYouTubeIframeAPIReady hook resolves every concurrent caller.
 */

/** The subset of the player we actually drive. */
export interface YTPlayer {
  playVideo(): void
  pauseVideo(): void
  mute(): void
  unMute(): void
  setVolume(volume: number): void
  destroy(): void
}

export interface YTPlayerOptions {
  videoId: string
  host?: string
  width?: string | number
  height?: string | number
  playerVars?: Record<string, unknown>
  events?: {
    onReady?: (event: { target: YTPlayer }) => void
    onStateChange?: (event: { data: number; target: YTPlayer }) => void
    onAutoplayBlocked?: () => void
    onError?: (event: { data: number }) => void
  }
}

export interface YTNamespace {
  Player: new (el: HTMLElement | string, options: YTPlayerOptions) => YTPlayer
  PlayerState: {
    UNSTARTED: number
    ENDED: number
    PLAYING: number
    PAUSED: number
    BUFFERING: number
    CUED: number
  }
}

declare global {
  interface Window {
    YT?: YTNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

let apiPromise: Promise<YTNamespace> | null = null

/** True once window.YT.Player exists (the API script finished). */
function apiReady(): boolean {
  return typeof window !== 'undefined' && !!window.YT?.Player
}

/**
 * Load (once) and resolve the YT namespace. Rejects on script failure
 * or a 10s timeout — callers fall back to a bare iframe when that
 * happens (rare; the API script is extremely reliable in practice).
 */
export function loadYouTubeIframeApi(): Promise<YTNamespace> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('SSR'))
  }
  if (apiReady()) return Promise.resolve(window.YT as YTNamespace)
  if (apiPromise) return apiPromise

  apiPromise = new Promise<YTNamespace>((resolve, reject) => {
    // The API may already be mid-flight (another component's load) —
    // poll briefly before declaring failure.
    const failTimer = setTimeout(() => {
      apiPromise = null
      if (apiReady()) resolve(window.YT as YTNamespace)
      else reject(new Error('YouTube API load timeout'))
    }, 10_000)

    const done = () => {
      if (apiReady()) {
        clearTimeout(failTimer)
        resolve(window.YT as YTNamespace)
      }
    }

    // The API calls this global when it finishes initializing. Preserve
    // any previous hook (multiple loaders chaining).
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      try {
        previous?.()
      } catch {
        // never let a foreign hook break the chain
      }
      done()
    }

    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    script.async = true
    script.onerror = () => {
      clearTimeout(failTimer)
      apiPromise = null
      reject(new Error('YouTube API script failed'))
    }
    // Some browsers fire no error for a blocked script — the poll above
    // catches that case.
    document.head.appendChild(script)

    // Immediate re-check (script may have been cached + executed
    // synchronously between our apiReady() and the append).
    setTimeout(done, 0)
    setTimeout(done, 400)
    setTimeout(done, 1500)
  })

  return apiPromise
}
