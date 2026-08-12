/**
 * Guest name generation.
 *
 * On first visit, every user gets a random "Guest XXXX" name (4 random
 * digits) so they have a stable identity in the user page + analytics
 * without needing to log in. Stored in localStorage so it persists across
 * sessions + devices (per browser).
 *
 * The name is read synchronously on mount (no flicker), and created
 * lazily on the first call to getOrCreateGuestName().
 */

const GUEST_NAME_KEY = 'neutralwire:guest-name'

/**
 * Get the existing guest name from localStorage, or null if not yet set.
 * Safe to call on the server (returns null).
 */
export function getGuestName(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return localStorage.getItem(GUEST_NAME_KEY)
  } catch {
    return null
  }
}

/**
 * Get the guest name, creating one on first call.
 * Returns "Guest XXXX" where XXXX is a 4-digit random number.
 *
 * Once created, the name is persisted in localStorage so it stays stable
 * across sessions.
 */
export function getOrCreateGuestName(): string {
  if (typeof window === 'undefined') return 'Guest 0000'
  try {
    const existing = localStorage.getItem(GUEST_NAME_KEY)
    if (existing) return existing
    // 4 random digits (1000..9999) — gives 9000 possible names.
    // Good enough to distinguish users in the analytics dashboard without
    // being so long it overflows the UI.
    const digits = String(Math.floor(1000 + Math.random() * 9000))
    const name = `Guest ${digits}`
    localStorage.setItem(GUEST_NAME_KEY, name)
    return name
  } catch {
    return 'Guest 0000'
  }
}

/**
 * Regenerate the guest name (used by a "regenerate" button if we ever
 * add one). Returns the new name.
 */
export function regenerateGuestName(): string {
  if (typeof window === 'undefined') return 'Guest 0000'
  try {
    const digits = String(Math.floor(1000 + Math.random() * 9000))
    const name = `Guest ${digits}`
    localStorage.setItem(GUEST_NAME_KEY, name)
    return name
  } catch {
    return 'Guest 0000'
  }
}
