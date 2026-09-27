'use client'

/**
 * custom-topics-client.ts — the visitor's chosen custom subtopics.
 *
 * Storage: localStorage `neutralwire:custom-topics` = [{id, label}] (the
 * same philosophy as dock-picks / interests — no login needed to remember
 * a device's list). Logged-in Premium users also get the list mirrored to
 * their account by /api/subtopics/subscribe (cross-device).
 *
 * The cron keeps feeds warm for topics with followers (the server-side
 * customSubscriptions counter), so adding here is what turns a catalog
 * entry into a living feed.
 */

const KEY = 'neutralwire:custom-topics'
export const CUSTOM_TOPICS_EVENT = 'neutralwire:custom-topics-changed'

export interface CustomTopicRef {
  id: string
  label: string
}

export function getCustomTopics(): CustomTopicRef[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as CustomTopicRef[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (t) => t && typeof t.id === 'string' && typeof t.label === 'string',
    )
  } catch {
    return []
  }
}

export function hasCustomTopic(id: string): boolean {
  return getCustomTopics().some((t) => t.id === id)
}

export async function addCustomTopic(id: string, label: string): Promise<boolean> {
  const list = getCustomTopics()
  if (list.some((t) => t.id === id)) return true
  if (list.length >= 12) return false // keep the header row sane
  const next = [...list, { id, label }]
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {}
  window.dispatchEvent(new CustomEvent(CUSTOM_TOPICS_EVENT))
  // Fire-and-forget server sync (counter + account prefs). A 402 here
  // means the premium gate tripped — the caller checks entitlements
  // BEFORE calling, so this is just belt-and-suspenders.
  fetch('/api/subtopics/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topicId: id, action: 'add', label }),
  }).catch(() => {})
  return true
}

export function removeCustomTopic(id: string): void {
  const list = getCustomTopics().filter((t) => t.id !== id)
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {}
  window.dispatchEvent(new CustomEvent(CUSTOM_TOPICS_EVENT))
  fetch('/api/subtopics/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topicId: id, action: 'remove' }),
  }).catch(() => {})
}
