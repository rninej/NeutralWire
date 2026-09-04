'use client'

/**
 * video-watch.tsx — context for the experimental Watch button feature.
 *
 * The videoWatch feature flag (flipped in /debug, stored in Firebase at
 * featureFlags/videoWatch, read server-side in page.tsx) decides whether
 * the Watch pill renders on article images (feed cards + article view).
 *
 * Why a context instead of prop drilling: TopicCard is rendered deep in
 * the tree (feed sections, search results, older-topics lists) — a
 * context lets every card read the flag without threading a prop through
 * half the component tree. The provider wraps the whole page in
 * page.tsx, so the FIRST paint already knows whether to render the
 * button (same zero-flash guarantee as the nav + popup flags).
 *
 * Flipping the flag OFF in /debug:
 *   - the buttons vanish on the next page load (SSR value)
 *   - /api/video refuses to resolve anything (returns { ok: false,
 *     reason: 'disabled' }) so no CPU is spent while off.
 */

import * as React from 'react'

const VideoWatchContext = React.createContext<boolean>(false)

export function VideoWatchProvider({
  enabled,
  children,
}: {
  enabled: boolean
  children: React.ReactNode
}) {
  return (
    <VideoWatchContext.Provider value={enabled}>{children}</VideoWatchContext.Provider>
  )
}

/** True when the experimental Watch button should render. */
export function useVideoWatch(): boolean {
  return React.useContext(VideoWatchContext)
}
