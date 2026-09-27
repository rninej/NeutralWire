import { createHash, timingSafeEqual } from 'crypto'

/**
 * Shared admin password verification for the /debug + analytics endpoints.
 *
 * The password is only stored as a SHA-256 hash — it cannot be derived
 * from the source code. Verification uses timing-safe comparison to
 * prevent byte-by-byte timing attacks.
 */

// SHA-256 hash of the admin password (same one as /api/analytics/query
// and /api/flags — one password for all admin surfaces).
const PASSWORD_HASH =
  '5c2113db1bd51e6e6fce4205d8eb36e41f5018d5d32d4c04b294fb02192f474a'

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export function verifyAdminPassword(input: string): boolean {
  const inputHash = sha256(input)
  if (inputHash.length !== PASSWORD_HASH.length) return false
  try {
    return timingSafeEqual(Buffer.from(inputHash), Buffer.from(PASSWORD_HASH))
  } catch {
    return false
  }
}
