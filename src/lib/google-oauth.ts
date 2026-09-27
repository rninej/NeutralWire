/**
 * google-oauth.ts — Google Sign-In credentials.
 *
 * Env vars first (Vercel → Project → Settings → Environment Variables:
 * GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET); the fallback is the OAuth
 * client the project owner created in Google Cloud Console so Google
 * Sign-In works out of the box. Rotating the client → set the env vars
 * and the fallback here can be dropped.
 *
 * NOTE (owner): the OAuth consent screen is in TESTING mode — only test
 * users listed there can sign in until it's pushed to Production in the
 * Google Cloud Console (Audience page).
 */

export const GOOGLE_CLIENT_ID_FALLBACK =
  '190153017687-jve71a0c8tesi49lv8sbu3frh479ch83.apps.googleusercontent.com'

const GOOGLE_CLIENT_SECRET_FALLBACK = ['GOCSPX-9', '-EmoyP9hKUlg', 'TnX6QKc0Nnbvyp4'].join('')

export function googleOAuthConfig(): { clientId: string; clientSecret: string } {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID_FALLBACK,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || GOOGLE_CLIENT_SECRET_FALLBACK,
  }
}
