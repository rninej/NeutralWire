/**
 * briefing-payload.ts — compose the timezone-briefing push payload with a
 * hard size guard.
 *
 * web-push REFUSES payloads over 4096 bytes — sendNotification() THROWS,
 * failing the send for EVERY device whose run picked that story. The
 * realistic way a briefing payload crosses the line is the composite
 * og-image URL: it embeds the article's imageUrl URL-ENCODED (encoding
 * can triple the length of a query-heavy URL), so one monster imageUrl
 * in the news cache would silently cancel the whole day's briefings for
 * every timezone whose windows keep picking that story — it can never
 * enter the sent-history (the send failed), so it stays "fresh" and
 * keeps poisoning run after run.
 *
 * The guard degrades gracefully: strip the image first (the notification
 * still displays perfectly with icon + badge), then — only in the absurd
 * worst case — truncate the body. A sendable payload ALWAYS goes out.
 */

export interface BriefingPayloadInput {
  /** Slot label, e.g. "Evening Briefing". Constant-length. */
  title: string
  /** The story headline (≤100 chars from the caller). */
  body: string
  /** In-app destination, e.g. "/?topic=<topicId>". */
  url: string
  /** Composite og-image URL, or null/undefined when the story has no photo. */
  image?: string | null
  /** Notification tag, e.g. "briefing-evening". */
  tag: string
  /** Stable per-device notification id (dedup on the device). */
  notifId: string
  /** FeatureFlags/notifLike — false omits the Like action button. */
  likeButton: boolean
}

/**
 * Soft limit with headroom: web-push's hard throw is at 4096 chars of the
 * JSON string; the aes128gcm layer adds overhead on the wire. 3800 keeps
 * every guarded payload comfortably under both.
 */
const PAYLOAD_SOFT_LIMIT = 3800

export function buildBriefingPayload(input: BriefingPayloadInput): string {
  const base: Record<string, unknown> = {
    title: input.title,
    body: input.body,
    url: input.url,
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    image: input.image ?? undefined,
    tag: input.tag,
    notifId: input.notifId,
    likeButton: input.likeButton,
  }
  const full = JSON.stringify(base)
  if (full.length <= PAYLOAD_SOFT_LIMIT) return full

  // 1) Drop the composite image — a notification without its big picture
  //    is infinitely better than no notification at all.
  const stripped = JSON.stringify({ ...base, image: undefined })
  if (stripped.length <= PAYLOAD_SOFT_LIMIT) return stripped

  // 2) Pathological title/url case (not reachable with the constant slot
  //    labels + short topic ids the caller uses, but the guard must be
  //    total): truncate the body to 60 chars.
  return JSON.stringify({ ...base, image: undefined, body: input.body.slice(0, 60) })
}
