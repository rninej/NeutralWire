/**
 * VAPID keys for web push notifications.
 *
 * These were generated with `node scripts/generate-vapid.js`.
 *
 * The PUBLIC key is safe to expose to the client (it's used to subscribe
 * to push notifications). The PRIVATE key is used server-side to sign
 * push messages and should NOT be exposed to the client.
 *
 * In production, move the private key to an environment variable:
 *   VAPID_PRIVATE_KEY=...
 * and read it with process.env.VAPID_PRIVATE_KEY.
 *
 * For now it's hardcoded since this is a personal project with a public
 * Firebase database.
 */

export const VAPID_PUBLIC_KEY =
  'BLSgm_q5Qnq63ptW423oMjq8Jn7IL0reC5umBM1_hEIXSBvPGv2jBhgmtn7X5KQLrGJ5RurmGiQ4JIQWbDeLtUk'

export const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY ||
  ''

export const VAPID_SUBJECT = 'mailto:contact@neutralwire.app'
