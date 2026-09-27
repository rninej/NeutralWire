'use client'

/**
 * video-watch.tsx — contexts for the experimental video features.
 *
 * Two boolean flags, both flipped in /debug, stored in Firebase under
 * featureFlags/<name>, and read SERVER-SIDE in page.tsx so the first
 * paint already knows the answer (zero-flash guarantee):
 *
 *   1. videoWatch — the Watch pill INSIDE the article view (hero image's
 *      bottom-LEFT corner). Tapping it plays the story's video INLINE in
 *      the news image. Home-screen cards never show the pill.
 *      Default ON.
 *
 *   2. videoPreview — the "top story video preview" on the home feed:
 *      the top news card (the big hero card with the NW icon) starts
 *      playing a MUTED video preview inside its image ~0.8s after the
 *      image has been on screen. Default OFF (pure experiment — enable
 *      from /debug).
 *
 * Why contexts instead of prop drilling: TopicDetail / TopicCard are
 * rendered deep in the tree (feed sections, search results, auto-opened
 * topics) — a context lets any component read the flag without threading
 * a prop through half the component tree. The providers wrap the whole
 * page in page.tsx.
 *
 * Flipping the flags OFF in /debug:
 *   - videoWatch: the pill vanishes on the next page load (SSR value) and
 *     /api/video refuses to resolve anything ({ ok: false, reason:
 *     'disabled' }) so no CPU is spent while off.
 *   - videoPreview: the home-feed preview stops on the next page load.
 */

import * as React from 'react'

const VideoWatchContext = React.createContext<boolean>(false)
const VideoPreviewContext = React.createContext<boolean>(false)

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

export function VideoPreviewProvider({
  enabled,
  children,
}: {
  enabled: boolean
  children: React.ReactNode
}) {
  return (
    <VideoPreviewContext.Provider value={enabled}>{children}</VideoPreviewContext.Provider>
  )
}

/** True when the experimental top-story video preview should play. */
export function useVideoPreview(): boolean {
  return React.useContext(VideoPreviewContext)
}
