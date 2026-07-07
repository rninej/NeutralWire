/**
 * Referral + engagement tracking system (device-based, no login).
 *
 * Firebase storage layout:
 *
 *   referrals/
 *     <referralCode>/
 *       creatorDeviceId: <string>
 *       createdAt: <ms>
 *       totalClicks: <number>
 *       successfulReferrals: <number>
 *     <referralCode>/visitors/
 *       <deviceId>: { firstSeen, ip, installed, daysActive, lastActive, qualified }
 *
 *   devices/
 *     <deviceId>/
 *       referralCode: <string>          (the code this device was referred by, if any)
 *       firstSeen: <ms>
 *       lastSeen: <ms>
 *       ipHash: <string>               (hashed IP for uniqueness check)
 *       pwaInstalled: <boolean>
 *       dailySessions: { "2026-07-07": { seconds: 15, qualified: true } }
 *       currentStreak: <number>
 *       bestStreak: <number>
 *       lastNotificationDay: <string>  (YYYY-MM-DD)
 *       notificationsEnabled: <boolean>
 */

import { firebaseRead, firebaseWrite, firebasePatch } from '@/lib/firebase-server'

const ROOT = 'referrals'
const DEVICES_ROOT = 'devices'

// ---------- Device ID generation (client-side) ----------
const DEVICE_ID_KEY = 'neutralwire:device-id'

/**
 * Get or create a persistent device ID in localStorage.
 * This is used to track the same device across sessions without login.
 */
export function getDeviceId(): string {
  if (typeof window === 'undefined') return 'server'
  let id = localStorage.getItem(DEVICE_ID_KEY)
  if (!id) {
    // Generate a random device ID
    const arr = new Uint8Array(16)
    crypto.getRandomValues(arr)
    id = 'd_' + Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
    localStorage.setItem(DEVICE_ID_KEY, id)
  }
  return id
}

// ---------- Referral code generation ----------
/**
 * Generate a random 6-digit referral code.
 */
export function generateReferralCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

/**
 * Create a referral code for a device. Stores the code in Firebase
 * with the creator's device ID. Returns the code.
 */
export async function createReferral(deviceId: string): Promise<string> {
  // Check if this device already has a referral code by checking a
  // local cache first (avoids creating duplicates).
  if (typeof window !== 'undefined') {
    const existing = localStorage.getItem('neutralwire:my-referral-code')
    if (existing) return existing
  }

  let code = generateReferralCode()
  // Ensure uniqueness — check if it already exists in Firebase.
  let existing = await firebaseRead<{ creatorDeviceId: string }>(`${ROOT}/${code}`)
  let attempts = 0
  while (existing && attempts < 10) {
    code = generateReferralCode()
    existing = await firebaseRead<{ creatorDeviceId: string }>(`${ROOT}/${code}`)
    attempts++
  }

  await firebaseWrite(`${ROOT}/${code}`, {
    creatorDeviceId: deviceId,
    createdAt: Date.now(),
    totalClicks: 0,
    successfulReferrals: 0,
  })

  if (typeof window !== 'undefined') {
    localStorage.setItem('neutralwire:my-referral-code', code)
  }

  return code
}

/**
 * Build the full referral URL for sharing.
 */
export function buildReferralUrl(code: string): string {
  if (typeof window !== 'undefined') {
    return `${window.location.origin}/?ref=${code}`
  }
  return `/?ref=${code}`
}

// ---------- Referral tracking (server-side) ----------

export interface DeviceRecord {
  referralCode?: string
  firstSeen: number
  lastSeen: number
  ipHash: string
  pwaInstalled: boolean
  dailySessions?: Record<string, { seconds: number; qualified: boolean }>
  currentStreak: number
  bestStreak: number
  lastNotificationDay?: string
  notificationsEnabled?: boolean
}

export interface ReferralRecord {
  creatorDeviceId: string
  createdAt: number
  totalClicks: number
  successfulReferrals: number
  visitors?: Record<string, VisitorRecord>
}

export interface VisitorRecord {
  firstSeen: number
  ip: string
  installed: boolean
  daysActive: number
  lastActive: number
  qualified: boolean
}

/**
 * Hash an IP address for privacy (we only need to check uniqueness,
 * not store the actual IP).
 */
function hashIp(ip: string): string {
  let h = 0
  for (let i = 0; i < ip.length; i++) {
    h = (Math.imul(31, h) + ip.charCodeAt(i)) | 0
  }
  return 'ip_' + (h >>> 0).toString(36)
}

/**
 * Get today's date as YYYY-MM-DD (UTC).
 */
function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Register a referral click: when someone opens /?ref=CODE, record their
 * device and IP. Called from the server when a referral link is detected.
 *
 * Returns true if this is a new visitor (first time seeing this referral).
 */
export async function trackReferralClick(
  referralCode: string,
  deviceId: string,
  ip: string,
): Promise<boolean> {
  const ipHash = hashIp(ip)

  // Check if the referral code exists.
  const referral = await firebaseRead<ReferralRecord>(`${ROOT}/${referralCode}`)
  if (!referral) return false

  // Don't let the creator refer themselves.
  if (referral.creatorDeviceId === deviceId) return false

  // Check if this device already visited via this referral.
  const visitorKey = `${ROOT}/${referralCode}/visitors/${deviceId}`
  const existing = await firebaseRead<VisitorRecord>(visitorKey)

  if (existing) {
    // Returning visitor — update lastActive.
    await firebaseWrite(visitorKey, {
      ...existing,
      lastActive: Date.now(),
    })
    return false
  }

  // New visitor — record them.
  await firebaseWrite(visitorKey, {
    firstSeen: Date.now(),
    ip: ipHash,
    installed: false,
    daysActive: 0,
    lastActive: Date.now(),
    qualified: false,
  })

  // Increment total clicks on the referral.
  await firebaseWrite(`${ROOT}/${referralCode}/totalClicks`, (referral.totalClicks || 0) + 1)

  // Also record the referral code on the device record so we know who
  // referred them.
  await firebasePatch(`${DEVICES_ROOT}/${deviceId}`, {
    referralCode,
  })

  return true
}

/**
 * Register or update a device. Called on every page load.
 * Returns the device record.
 */
export async function registerDevice(
  deviceId: string,
  ip: string,
): Promise<DeviceRecord> {
  const ipHash = hashIp(ip)
  const existing = await firebaseRead<DeviceRecord>(`${DEVICES_ROOT}/${deviceId}`)

  if (existing) {
    const updated: DeviceRecord = {
      ...existing,
      lastSeen: Date.now(),
      ipHash,
    }
    await firebaseWrite(`${DEVICES_ROOT}/${deviceId}`, updated)
    return updated
  }

  const record: DeviceRecord = {
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    ipHash,
    pwaInstalled: false,
    currentStreak: 0,
    bestStreak: 0,
    notificationsEnabled: false,
  }
  await firebaseWrite(`${DEVICES_ROOT}/${deviceId}`, record)
  return record
}

/**
 * Record a daily session for a device. Called periodically while the user
 * is active (every 15 seconds). A day "counts" if the user accumulates
 * at least 15 seconds of active time.
 *
 * Returns the updated device record.
 */
export async function recordSession(
  deviceId: string,
  secondsToAdd: number,
): Promise<DeviceRecord | null> {
  const device = await firebaseRead<DeviceRecord>(`${DEVICES_ROOT}/${deviceId}`)
  if (!device) return null

  const today = todayKey()
  const sessions = device.dailySessions || {}
  const todaySession = sessions[today] || { seconds: 0, qualified: false }

  todaySession.seconds += secondsToAdd
  const wasQualified = todaySession.qualified
  todaySession.qualified = todaySession.seconds >= 15
  sessions[today] = todaySession

  // Update streak: if today just became qualified and yesterday was
  // qualified, increment streak. If today just became qualified and
  // yesterday was NOT qualified, reset streak to 1.
  if (todaySession.qualified && !wasQualified) {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    const yesterdayQualified = sessions[yesterday]?.qualified
    if (yesterdayQualified) {
      device.currentStreak = (device.currentStreak || 0) + 1
    } else {
      device.currentStreak = 1
    }
    device.bestStreak = Math.max(device.bestStreak || 0, device.currentStreak)
  }

  const updated: DeviceRecord = {
    ...device,
    dailySessions: sessions,
    lastSeen: Date.now(),
  }
  await firebaseWrite(`${DEVICES_ROOT}/${deviceId}`, updated)
  return updated
}

/**
 * Mark a device as having the PWA installed.
 */
export async function markPwaInstalled(deviceId: string): Promise<void> {
  await firebasePatch(`${DEVICES_ROOT}/${deviceId}`, {
    pwaInstalled: true,
  })

  // Also update the visitor record if this device was referred.
  const device = await firebaseRead<DeviceRecord>(`${DEVICES_ROOT}/${deviceId}`)
  if (device?.referralCode) {
    const visitorKey = `${ROOT}/${device.referralCode}/visitors/${deviceId}`
    const visitor = await firebaseRead<VisitorRecord>(visitorKey)
    if (visitor) {
      await firebaseWrite(visitorKey, { ...visitor, installed: true })
      // Check qualification after install.
      await checkReferralQualification(device.referralCode, deviceId)
    }
  }
}

/**
 * Enable/disable daily notifications for a device.
 */
export async function setNotificationsEnabled(
  deviceId: string,
  enabled: boolean,
): Promise<void> {
  await firebasePatch(`${DEVICES_ROOT}/${deviceId}`, {
    notificationsEnabled: enabled,
  })
}

/**
 * Check if a referred visitor has met ALL the qualification criteria:
 * 1. PWA installed
 * 2. 3 days of usage (currentStreak >= 3)
 * 3. Different IP from the creator (basic uniqueness check)
 * 4. At least 15 seconds of usage per day for 3 days
 *
 * If qualified, marks the visitor as qualified and increments the
 * referral's successfulReferrals count.
 */
export async function checkReferralQualification(
  referralCode: string,
  deviceId: string,
): Promise<boolean> {
  const referral = await firebaseRead<ReferralRecord>(`${ROOT}/${referralCode}`)
  if (!referral) return false

  const device = await firebaseRead<DeviceRecord>(`${DEVICES_ROOT}/${deviceId}`)
  if (!device) return false

  const visitorKey = `${ROOT}/${referralCode}/visitors/${deviceId}`
  const visitor = await firebaseRead<VisitorRecord>(visitorKey)
  if (!visitor) return false

  // Already qualified?
  if (visitor.qualified) return true

  // Check criteria.
  const installed = device.pwaInstalled === true
  const streakOk = (device.currentStreak || 0) >= 3

  // Check 3 days of 15+ seconds each.
  const sessions = device.dailySessions || {}
  const qualifiedDays = Object.values(sessions).filter(s => s.seconds >= 15).length
  const daysOk = qualifiedDays >= 3

  // Check different IP from creator.
  const creatorDevice = await firebaseRead<DeviceRecord>(
    `${DEVICES_ROOT}/${referral.creatorDeviceId}`,
  )
  const differentIp = !creatorDevice || creatorDevice.ipHash !== device.ipHash

  const allMet = installed && streakOk && daysOk && differentIp

  if (allMet && !visitor.qualified) {
    await firebaseWrite(visitorKey, { ...visitor, qualified: true })
    await firebaseWrite(
      `${ROOT}/${referralCode}/successfulReferrals`,
      (referral.successfulReferrals || 0) + 1,
    )
    return true
  }

  return false
}

/**
 * Get referral stats for a code (total clicks, successful referrals).
 */
export async function getReferralStats(
  code: string,
): Promise<{ totalClicks: number; successfulReferrals: number } | null> {
  const referral = await firebaseRead<ReferralRecord>(`${ROOT}/${code}`)
  if (!referral) return null
  return {
    totalClicks: referral.totalClicks || 0,
    successfulReferrals: referral.successfulReferrals || 0,
  }
}
