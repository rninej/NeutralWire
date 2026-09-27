/**
 * subscriptions.ts — the subscription tier model (server-side core).
 *
 * ── TIERS ──
 *   'free'     — the classic NeutralWire experience: news aggregation, bias
 *                bar, full articles, sources, PWA. (In the 'donation'
 *                monetization model EVERY visitor effectively has this —
 *                all premium gates stand down, exactly the pre-subscription
 *                site.)
 *   'premium'  — £3 / $3 / €3 per month (currency by country):
 *                custom subtopics (300+ catalog + AI-created), archive
 *                search older than 3 months, AI email digest, gradient
 *                themes, personal feature flags.
 *   'ultra'    — £20 / $20 / €20 per month: everything in premium + API
 *                access to the NeutralWire feed + article export/download.
 *
 * ── IDENTITY ──
 * The site is device-first (no login). A subscription is attached to an
 * ACCOUNT (email+password / Google / Apple), and the account links the
 * visitor's device(s). Tier resolution order:
 *   1. If monetization model is 'donation' → everyone is effectively
 *      unrestricted (the gates read the model, not just the tier).
 *   2. Session cookie `nw_session` → account → account.tier.
 *   3. No session → device record tier (`devices/<id>.tier`) — this is how
 *      the /debug guest-code grant works for logged-out users.
 *   4. Default free.
 *
 * ── FIREBASE LAYOUT (RTDB, same REST client as everything else) ──
 *   accounts/<accountId>          { email, passSalt, passHash, provider,
 *                                   providerSub, tier, tierSince, tierRenewsAt,
 *                                   tierSource ('stripe'|'manual'|'test'),
 *                                   tierCancelAtEnd, stripeCustomerId,
 *                                   createdAt, timezone,
 *                                   devices: { <deviceId>: true },
 *                                   prefs: { digest: {…}, customSubtopics: [...] } }
 *   accountIndex/<emailKey>       { accountId }        (login lookup)
 *   sessions/<token>              { accountId, createdAt, expiresAt }
 *   apiKeys/<sha256(key)>         { accountId, createdAt, label }  (ultra)
 *   devices/<deviceId>.tier       'premium' | 'ultra' | (absent = free)
 *   subscriptionsLog/<pushId>     { at, what, accountId|deviceId, tier } audit
 *
 * ⚠ SECURITY NOTE: this database is the SAME public-read RTDB the whole
 * site runs on. Passwords are stored as scrypt hashes + per-user salts
 * (offline brute-force required per account), sessions are 192-bit random
 * tokens, and API keys are stored hashed — nothing reversible at rest.
 * Tightening the RTDB rules with Firebase Auth/AppCheck is the right
 * long-term move and is flagged in the owner report.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { firebaseRead, firebaseWrite, firebasePatch } from '@/lib/firebase-server'

export type Tier = 'free' | 'premium' | 'ultra'
export type MonetizationModel = 'donation' | 'subscription'

export const TIER_PRICES: Record<'premium' | 'ultra', { gbp: number; usd: number; eur: number }> = {
  premium: { gbp: 3, usd: 3, eur: 3 },
  ultra: { gbp: 20, usd: 20, eur: 20 },
}

const EURO_COUNTRIES = new Set([
  'AT', 'BE', 'HR', 'CY', 'EE', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT', 'LV',
  'LT', 'LU', 'MT', 'NL', 'PT', 'SK', 'SI', 'ES', 'BG', 'CZ', 'DK', 'HU',
  'PL', 'RO', 'SE', 'IS', 'NO', 'LI', 'MC', 'SM', 'AD', 'VA',
])

export type Currency = 'GBP' | 'USD' | 'EUR'

export interface PriceQuote {
  currency: Currency
  symbol: '£' | '$' | '€'
  amount: number
  display: string // "£3" / "$3" / "€3"
}

/** Localised monthly price for a tier given the visitor's ISO country. */
export function quoteForCountry(tier: 'premium' | 'ultra', country: string): PriceQuote {
  const c = (country || '').toUpperCase()
  const currency: Currency = c === 'GB' ? 'GBP' : EURO_COUNTRIES.has(c) ? 'EUR' : 'USD'
  const amount = TIER_PRICES[tier][currency.toLowerCase() as 'gbp' | 'usd' | 'eur']
  const symbol = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '$'
  return { currency, symbol, amount, display: `${symbol}${amount}` }
}

// ── Accounts ────────────────────────────────────────────────────────────

export interface DigestPrefs {
  enabled: boolean
  /** weekly | daily | 2x | 3x (times per day). */
  freq: 'weekly' | 'daily' | '2x' | '3x'
  /** Base send hour (visitor-local, 0-23) for daily/weekly. */
  hour: number
  /** Custom delivery address for the newsletter. When set, the digest is
   *  sent HERE instead of the account email (mirrored into
   *  digestSubscribers/<accountId>.email so the cron needs no changes). */
  email?: string
}

export interface Account {
  email: string
  passSalt?: string
  passHash?: string
  provider: 'email' | 'google' | 'apple'
  providerSub?: string
  tier?: Tier
  tierSince?: number
  tierRenewsAt?: number
  tierSource?: 'stripe' | 'kofi' | 'manual' | 'test'
  tierCancelAtEnd?: boolean
  stripeCustomerId?: string
  stripeSubscriptionId?: string
  /** The Ko-fi supporter email this account's membership is linked to
   *  (set by the Ko-fi webhook when a payment is claimed). Renewals match
   *  on it. */
  kofiEmail?: string
  createdAt: number
  timezone?: string
  devices?: Record<string, boolean>
  prefs?: {
    digest?: Partial<DigestPrefs>
    customSubtopics?: string[]
  }
}

export interface SessionRecord {
  accountId: string
  createdAt: number
  expiresAt: number
}

const SESSION_COOKIE = 'nw_session'
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

/** RTDB-safe lookup key for an email.
 *
 * Firebase RTDB REJECTS '.', '#', '$', '[', ']' in path segments — and
 * encodeURIComponent does NOT escape '.', so a raw-encoded email key
 * ("user%40example.com") fails with "Invalid token in path" (verified live
 * against this database). Instead we key the index by a truncated SHA-256
 * of the normalized email: deterministic, path-safe, and no PII in keys.
 * The accountId itself is the full 20-char sha256 prefix, so the index is
 * technically redundant — but it keeps the door open for future
 * multi-account-per-email flows and makes lookups explicit.
 */
export function emailKey(email: string): string {
  return 'e_' + createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 24)
}

export function accountIdForEmail(email: string): string {
  // Stable id from the email hash — deterministic so re-registering the
  // same email maps to the same path (guarded by the index anyway).
  return 'a_' + createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 20)
}

// ── Password hashing (scrypt + per-user salt) ───────────────────────────

export function hashPassword(password: string, salt?: string): { salt: string; hash: string } {
  const s = salt || randomBytes(16).toString('hex')
  const hash = scryptSync(password, s, 64).toString('hex')
  return { salt: s, hash }
}

export function verifyPassword(password: string, salt: string, expectedHex: string): boolean {
  try {
    const actual = scryptSync(password, salt, 64)
    const expected = Buffer.from(expectedHex, 'hex')
    if (actual.length !== expected.length) return false
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

// ── Sessions ────────────────────────────────────────────────────────────

export function newSessionToken(): string {
  return randomBytes(24).toString('hex') // 192-bit
}

export async function createSession(accountId: string): Promise<string> {
  const token = newSessionToken()
  await firebaseWrite(`sessions/${token}`, {
    accountId,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  })
  return token
}

export async function readSession(request: NextRequest): Promise<SessionRecord | null> {
  const token = request.cookies.get(SESSION_COOKIE)?.value
  if (!token) return null
  const rec = await firebaseRead<SessionRecord>(`sessions/${token}`)
  if (!rec || rec.expiresAt < Date.now()) return null
  return rec
}

/** Attach the session cookie to a response (login / register). */
export function setSessionCookie(res: NextResponse, token: string): NextResponse {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_MS / 1000,
    path: '/',
  })
  return res
}

export function clearSessionCookie(res: NextResponse): NextResponse {
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 })
  return res
}

export async function destroySession(request: NextRequest): Promise<void> {
  const token = request.cookies.get(SESSION_COOKIE)?.value
  if (token) {
    const { firebaseDelete } = await import('@/lib/firebase-server')
    await firebaseDelete(`sessions/${token}`).catch(() => {})
  }
}

// ── Account CRUD ────────────────────────────────────────────────────────

export async function getAccountById(accountId: string): Promise<Account | null> {
  return firebaseRead<Account>(`accounts/${accountId}`)
}

export async function getAccountByEmail(email: string): Promise<Account | null> {
  const idx = await firebaseRead<{ accountId: string }>(`accountIndex/${emailKey(email)}`)
  if (!idx?.accountId) return null
  return getAccountById(idx.accountId)
}

export interface RegisterResult {
  ok: boolean
  error?: string
  accountId?: string
  account?: Account
}

export async function registerEmailAccount(
  email: string,
  password: string,
  deviceId?: string,
  timezone?: string,
): Promise<RegisterResult> {
  const norm = email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm)) return { ok: false, error: 'Enter a valid email address.' }
  if (password.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' }

  const existing = await getAccountByEmail(norm)
  if (existing) return { ok: false, error: 'An account with this email already exists — try signing in.' }

  const { salt, hash } = hashPassword(password)
  const accountId = accountIdForEmail(norm)
  const account: Account = {
    email: norm,
    passSalt: salt,
    passHash: hash,
    provider: 'email',
    createdAt: Date.now(),
    ...(timezone ? { timezone } : {}),
    ...(deviceId ? { devices: { [deviceId]: true } } : {}),
  }
  await firebaseWrite(`accounts/${accountId}`, account)
  await firebaseWrite(`accountIndex/${emailKey(norm)}`, { accountId })
  if (deviceId) {
    await firebasePatch(`devices/${deviceId}`, { accountId }).catch(() => {})
    // A device-granted tier (the /debug guest grant) transfers to the
    // first account created from that device — signing up must never
    // read as "my Premium vanished".
    const inherited = await inheritDeviceTier(accountId, deviceId)
    if (inherited) account.tier = inherited
  }
  return { ok: true, accountId, account }
}

export interface LoginResult {
  ok: boolean
  error?: string
  accountId?: string
  account?: Account
}

export async function loginEmailAccount(
  email: string,
  password: string,
  deviceId?: string,
): Promise<LoginResult> {
  const norm = email.trim().toLowerCase()
  const account = await getAccountByEmail(norm)
  if (!account || !account.passSalt || !account.passHash) {
    return { ok: false, error: 'No account found for this email — create one instead.' }
  }
  if (!verifyPassword(password, account.passSalt, account.passHash)) {
    return { ok: false, error: 'Incorrect password.' }
  }
  const accountId = accountIdForEmail(norm)
  // Opportunistically link the current device to the account.
  if (deviceId) {
    await firebasePatch(`accounts/${accountId}/devices`, { [deviceId]: true }).catch(() => {})
    await firebasePatch(`devices/${deviceId}`, { accountId }).catch(() => {})
    // A device-granted tier transfers to a FREE account on sign-in (never
    // the other way — a paid account tier is authoritative).
    if (!account.tier || account.tier === 'free') {
      const inherited = await inheritDeviceTier(accountId, deviceId)
      if (inherited) account.tier = inherited
    }
  }
  return { ok: true, accountId, account: { ...account, devices: { ...(account.devices || {}), ...(deviceId ? { [deviceId]: true } : {}) } } }
}

/** Find-or-create an account for a social (Google/Apple) identity. */
export async function upsertSocialAccount(
  provider: 'google' | 'apple',
  email: string,
  providerSub: string,
  deviceId?: string,
): Promise<{ accountId: string; account: Account }> {
  const norm = email.trim().toLowerCase()
  const accountId = accountIdForEmail(norm)
  const existing = await getAccountById(accountId)
  if (existing) {
    if (deviceId) {
      await firebasePatch(`accounts/${accountId}/devices`, { [deviceId]: true }).catch(() => {})
      await firebasePatch(`devices/${deviceId}`, { accountId }).catch(() => {})
    }
    return { accountId, account: existing }
  }
  const account: Account = {
    email: norm,
    provider,
    providerSub,
    createdAt: Date.now(),
    ...(deviceId ? { devices: { [deviceId]: true } } : {}),
  }
  await firebaseWrite(`accounts/${accountId}`, account)
  await firebaseWrite(`accountIndex/${emailKey(norm)}`, { accountId })
  if (deviceId) {
    await firebasePatch(`devices/${deviceId}`, { accountId }).catch(() => {})
  }
  return { accountId, account }
}

// ── Tier resolution for a request ───────────────────────────────────────

export interface RequesterTier {
  tier: Tier
  model: MonetizationModel
  /** True when every premium gate stands down (donation model). */
  allUnlocked: boolean
  accountId: string | null
  email: string | null
  renewsAt: number | null
  via: 'account' | 'device' | 'none'
}

let modelMemo: { value: MonetizationModel; ts: number } | null = null
const MODEL_MEMO_MS = 10 * 1000

export async function getMonetizationModel(): Promise<MonetizationModel> {
  if (modelMemo && Date.now() - modelMemo.ts < MODEL_MEMO_MS) return modelMemo.value
  const stored = await firebaseRead<string>('featureFlags/monetizationModel')
  const value: MonetizationModel = stored === 'donation' ? 'donation' : 'subscription'
  modelMemo = { value, ts: Date.now() }
  return value
}

export function invalidateModelMemo(): void {
  modelMemo = null
}

/**
 * Resolve the visitor's tier for ANY request:
 *   session cookie → account.tier; else ?deviceId= / body deviceId →
 *   devices/<id>.tier (the /debug guest grant); else free.
 */
export async function getRequesterTier(req: NextRequest): Promise<RequesterTier> {
  const model = await getMonetizationModel()
  const allUnlocked = model === 'donation'

  const session = await readSession(req)
  if (session?.accountId) {
    const account = await getAccountById(session.accountId)
    if (account) {
      const tier: Tier = account.tier === 'ultra' ? 'ultra' : account.tier === 'premium' ? 'premium' : 'free'
      return {
        tier,
        model,
        allUnlocked,
        accountId: session.accountId,
        email: account.email,
        renewsAt: account.tierRenewsAt ?? null,
        via: 'account',
      }
    }
  }

  const deviceId = req.nextUrl.searchParams.get('deviceId')
  if (deviceId) {
    const t = await firebaseRead<Tier>(`devices/${deviceId}/tier`)
    if (t === 'premium' || t === 'ultra') {
      return { tier: t, model, allUnlocked, accountId: null, email: null, renewsAt: null, via: 'device' }
    }
  }

  return { tier: 'free', model, allUnlocked, accountId: null, email: null, renewsAt: null, via: 'none' }
}

// ── Tier mutation (checkout, webhook, /debug grant, cancel) ───────────

/** A device-granted tier (the /debug guest-code grant) transfers to the
 *  first account created or signed-in from that device — registering must
 *  never read as "my Premium vanished" (session wins over ?deviceId=, so
 *  without this a fresh account silently downgraded the visitor).
 *  Returns the inherited tier, or null when the device has none. Never
 *  overrides an existing paid tier on the account. */
export async function inheritDeviceTier(
  accountId: string,
  deviceId: string,
): Promise<Tier | null> {
  try {
    const dev = await firebaseRead<{ tier?: Tier; tierRenewsAt?: number; tierSource?: string }>(
      `devices/${deviceId}`,
    )
    const t = dev?.tier
    if (t === 'premium' || t === 'ultra') {
      const existing = await getAccountById(accountId)
      if (existing?.tier === 'premium' || existing?.tier === 'ultra') {
        return existing.tier // account already holds a tier — authoritative
      }
      await firebasePatch(`accounts/${accountId}`, {
        tier: t,
        tierSince: Date.now(),
        tierSource: dev?.tierSource || 'manual',
        tierRenewsAt: dev?.tierRenewsAt ?? null,
      })
      return t
    }
  } catch {}
  return null
}

export interface TierChange {
  tier: Tier
  renewsAt: number | null
  source: 'stripe' | 'kofi' | 'manual' | 'test'
  cancelAtEnd?: boolean
  stripeCustomerId?: string
  stripeSubscriptionId?: string
}

/** Apply a tier to an ACCOUNT (and mirror it onto linked devices). */
export async function setAccountTier(accountId: string, change: TierChange): Promise<boolean> {
  const patch: Record<string, unknown> = {
    tier: change.tier,
    tierSince: Date.now(),
    tierSource: change.source,
    tierCancelAtEnd: change.cancelAtEnd === true,
    tierRenewsAt: change.renewsAt ?? null,
  }
  if (change.stripeCustomerId) patch.stripeCustomerId = change.stripeCustomerId
  if (change.stripeSubscriptionId) patch.stripeSubscriptionId = change.stripeSubscriptionId
  const ok = await firebasePatch(`accounts/${accountId}`, patch)
  if (ok) {
    // Mirror onto linked devices so logged-out sessions on this browser
    // still resolve the tier via ?deviceId=.
    const account = await getAccountById(accountId)
    const devices = Object.keys(account?.devices || {})
    await Promise.all(
      devices.map((d) => firebasePatch(`devices/${d}`, { tier: change.tier }).catch(() => {})),
    )
    await logTierChange(`account:${accountId}`, change.tier)
  }
  return ok
}

/**
 * Grant/remove a tier by ADMIN IDENTIFIER — accepts (in order):
 *   1. A 6-digit (or alphanumeric) guest/referral code → referrals/<code>.creatorDeviceId
 *   2. A device id (d_…)                       → devices/<id>
 *   3. An email                                 → accounts/<accountId>
 */
export interface GrantTarget {
  kind: 'referral' | 'device' | 'account' | 'unknown'
  deviceId?: string
  accountId?: string
  email?: string
  label: string
}

export async function resolveGrantTarget(identifier: string): Promise<GrantTarget> {
  const id = identifier.trim()
  if (!id) return { kind: 'unknown', label: '' }

  // Device id?
  if (id.startsWith('d_')) {
    return { kind: 'device', deviceId: id, label: `device ${id.slice(0, 12)}…` }
  }

  // Referral/guest code? (6 digits, or 5-6 alphanumeric after overflow)
  const isCodeish = /^[0-9]{6}$/.test(id) || /^[0-9a-z]{5,6}$/i.test(id)
  if (isCodeish) {
    const referral = await firebaseRead<{ creatorDeviceId?: string }>(`referrals/${id}`)
    if (referral?.creatorDeviceId) {
      // Does this device have an account? Then grant to the account.
      const device = await firebaseRead<{ accountId?: string }>(`devices/${referral.creatorDeviceId}`)
      if (device?.accountId) {
        return { kind: 'account', accountId: device.accountId, label: `guest code ${id} → account` }
      }
      return { kind: 'device', deviceId: referral.creatorDeviceId, label: `guest code ${id} → device` }
    }
  }

  // Email?
  if (id.includes('@')) {
    const account = await getAccountByEmail(id)
    if (account) {
      return { kind: 'account', accountId: accountIdForEmail(id), email: account.email, label: `account ${account.email}` }
    }
  }

  return { kind: 'unknown', label: id }
}

export interface GrantResult {
  ok: boolean
  error?: string
  target?: GrantTarget
  tier?: Tier
}

export async function adminSetTier(identifier: string, tier: Tier): Promise<GrantResult> {
  const target = await resolveGrantTarget(identifier)
  if (target.kind === 'unknown') {
    return { ok: false, error: 'No device, guest code, or account matches that identifier.' }
  }
  if (target.kind === 'device' && target.deviceId) {
    const patch: Record<string, unknown> = { tier }
    if (tier === 'free') {
      patch.tier = null
      patch.tierSince = null
      patch.tierSource = null
    }
    const ok = await firebasePatch(`devices/${target.deviceId}`, patch)
    await logTierChange(`device:${target.deviceId}`, tier)
    return { ok, target, tier }
  }
  if (target.kind === 'account' && target.accountId) {
    const ok = await setAccountTier(target.accountId, {
      tier,
      renewsAt: tier === 'free' ? null : Date.now() + 30 * 24 * 3600 * 1000,
      source: 'manual',
    })
    return { ok, target, tier }
  }
  return { ok: false, error: 'Unsupported target' }
}

async function logTierChange(who: string, tier: Tier): Promise<void> {
  try {
    const { firebasePush } = await import('@/lib/firebase-server')
    await firebasePush('subscriptionsLog', { at: Date.now(), who, tier })
  } catch {}
}

// ── Ko-fi payments (the live checkout provider) ──────────────────────────

/** The Ko-fi page supporters pay on — the MEMBERSHIP TIERS page, so the
 *  “Continue to Ko-fi” button lands supporters directly on the tier
 *  picker (Premium / Ultra) instead of the general page. */
export const KOFI_PAGE_URL = 'https://ko-fi.com/neutralwire/tiers'

/** The Ko-fi webhook verification token. Env var first (Vercel → Project →
 *  Settings → Environment Variables); the fallback is the token from the
 *  project owner's Ko-fi dashboard so fulfilment works out of the box.
 *  Rotating the token in Ko-fi → update KOFI_VERIFICATION_TOKEN. */
export function kofiVerificationToken(): string {
  return process.env.KOFI_VERIFICATION_TOKEN || '70adb04c-199c-4151-8637-f06541ff696f'
}

/** A human-typeable claim code (NW-XXXXXX, no ambiguous chars) — shown to
 *  the supporter at checkout; pasting it into the Ko-fi message links the
 *  incoming payment to their NeutralWire account instantly. */
const CLAIM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export function newKofiClaimCode(): string {
  const bytes = randomBytes(6)
  let c = ''
  for (let i = 0; i < 6; i++) c += CLAIM_ALPHABET[bytes[i] % CLAIM_ALPHABET.length]
  return `NW-${c}`
}

/** Normalise a claim code found in a Ko-fi message (case/spacing lax).
 *  SEARCHES the raw message — supporters wrap the code in prose ("my code
 *  is NW-ABC123 thanks!") so a whole-string match would never fire. */
export function normalizeKofiClaimCode(text: string): string | null {
  const m = String(text || '')
    .toUpperCase()
    .match(/\bNW-?([A-HJKMNP-Z2-9]{6})\b/)
  return m ? `NW-${m[1]}` : null
}

/** Map a Ko-fi payment payload to a paid tier. Membership tier names win
 *  (create tiers named "Premium" / "Ultra" on Ko-fi); the amount is the
 *  fallback net ($/£/€ 3 → premium, ≥15 → ultra). Donations map to null —
 *  they never change the tier in the subscription model. */
export function kofiTierForEvent(data: {
  type?: string
  tier_name?: string | null
  amount?: string | number
  is_subscription_payment?: boolean
}): 'premium' | 'ultra' | null {
  const isSub =
    data.type === 'Subscription' || data.is_subscription_payment === true
  if (!isSub) return null
  const t = String(data.tier_name || '').toLowerCase()
  if (t.includes('ultra')) return 'ultra'
  if (t.includes('premium')) return 'premium'
  const amount = parseFloat(String(data.amount ?? '0')) || 0
  if (amount >= 15) return 'ultra'
  if (amount >= 3) return 'premium'
  return null
}

/** Find the NeutralWire account a Ko-fi payment belongs to:
 *  1. a claim code pasted into the Ko-fi message (instant, exact),
 *  2. the supporter's email matching an account email,
 *  3. the supporter's email matching a PREVIOUSLY linked Ko-fi email
 *     (renewals). Returns null when nobody matches yet (the event is
 *  stored unclaimed; the in-app "I already paid" claim picks it up). */
export async function resolveKofiAccountId(
  message: string,
  email: string,
): Promise<{ accountId: string; via: 'code' | 'email' | 'kofiEmail'; code?: string } | null> {
  const code = normalizeKofiClaimCode(message)
  if (code) {
    const claim = await firebaseRead<{ accountId?: string; usedAt?: number; expiresAt?: number }>(
      `kofiClaims/${code}`,
    )
    if (claim?.accountId && !claim.usedAt && (claim.expiresAt || 0) > Date.now()) {
      return { accountId: claim.accountId, via: 'code', code }
    }
  }
  const norm = (email || '').trim().toLowerCase()
  if (!norm) return null
  const idx = await firebaseRead<{ accountId?: string }>(`accountIndex/${emailKey(norm)}`)
  if (idx?.accountId) return { accountId: idx.accountId, via: 'email' }
  const kofi = await firebaseRead<{ accountId?: string }>(`kofiEmailIndex/${emailKey(norm)}`)
  if (kofi?.accountId) return { accountId: kofi.accountId, via: 'kofiEmail' }
  return null
}

/** Apply a claimed Ko-fi payment to an account: first payment sets the
 *  tier for 31 days; a renewal EXTENDS the horizon from whenever it
 *  currently runs to. Also links the supporter's Ko-fi email so future
 *  renewals auto-match without a claim code. */
export async function applyKofiPayment(
  accountId: string,
  tier: 'premium' | 'ultra',
  opts: { renewal: boolean; kofiEmail?: string; code?: string },
): Promise<boolean> {
  const account = await getAccountById(accountId)
  const current = account?.tierRenewsAt ?? 0
  const base = opts.renewal && current > Date.now() ? current : Date.now()
  const renewsAt = base + 31 * 24 * 3600 * 1000
  const ok = await setAccountTier(accountId, { tier, renewsAt, source: 'kofi' })
  if (!ok) return false
  if (opts.kofiEmail) {
    const norm = opts.kofiEmail.trim().toLowerCase()
    await firebasePatch(`accounts/${accountId}`, { kofiEmail: norm }).catch(() => {})
    await firebaseWrite(`kofiEmailIndex/${emailKey(norm)}`, { accountId }).catch(() => {})
  }
  if (opts.code) {
    await firebasePatch(`kofiClaims/${opts.code}`, {
      usedAt: Date.now(),
      accountId,
      tier,
    }).catch(() => {})
  }
  return true
}

// ── Ultra API keys ──────────────────────────────────────────────────────

export function generateUltraApiKey(): string {
  return 'nwul_' + randomBytes(20).toString('hex')
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/** Create + return a fresh API key for an account (ultra tier). */
export async function issueUltraApiKey(accountId: string): Promise<string | null> {
  const key = generateUltraApiKey()
  const ok = await firebaseWrite(`apiKeys/${hashApiKey(key)}`, {
    accountId,
    createdAt: Date.now(),
  })
  return ok ? key : null
}

export async function revokeUltraApiKeys(accountId: string): Promise<number> {
  // We cannot enumerate by account cheaply on RTDB without an index —
  // maintain a per-account list of key hashes at issue time.
  const hashes = await firebaseRead<string[]>(`accounts/${accountId}/apiKeyHashes`)
  let n = 0
  for (const h of hashes || []) {
    const { firebaseDelete } = await import('@/lib/firebase-server')
    if (await firebaseDelete(`apiKeys/${h}`).catch(() => false)) n++
  }
  await firebasePatch(`accounts/${accountId}`, { apiKeyHashes: null }).catch(() => {})
  return n
}

export async function issueAndRecordUltraApiKey(accountId: string): Promise<string | null> {
  const key = await issueUltraApiKey(accountId)
  if (!key) return null
  const existing = (await firebaseRead<string[]>(`accounts/${accountId}/apiKeyHashes`)) || []
  existing.push(hashApiKey(key))
  await firebasePatch(`accounts/${accountId}`, { apiKeyHashes: existing.slice(-10) }).catch(() => {})
  return key
}

/** Resolve an API key to an account (for /api/v1/feed). */
export async function accountForApiKey(key: string): Promise<Account | null> {
  if (!key) return null
  const entry = await firebaseRead<{ accountId: string }>(`apiKeys/${hashApiKey(key)}`)
  if (!entry?.accountId) return null
  const account = await getAccountById(entry.accountId)
  if (!account || (account.tier !== 'ultra')) return null
  return account
}

// ── Entitlements (single source of truth for every gate) ────────────────

export interface Entitlements {
  model: MonetizationModel
  tier: Tier
  customSubtopics: boolean
  archiveSearchOld: boolean
  emailDigest: boolean
  gradientThemes: boolean
  personalFlags: boolean
  apiAccess: boolean
  articleExport: boolean
}

export function entitlementsFor(tier: Tier, model: MonetizationModel): Entitlements {
  const premium = model === 'donation' ? true : tier === 'premium' || tier === 'ultra'
  const ultra = model === 'donation' ? true : tier === 'ultra'
  return {
    model,
    tier,
    customSubtopics: premium,
    archiveSearchOld: premium,
    emailDigest: premium,
    gradientThemes: premium,
    personalFlags: premium,
    apiAccess: ultra,
    articleExport: ultra,
  }
}
