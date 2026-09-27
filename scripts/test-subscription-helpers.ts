/** Test helpers — thin re-exports so the script runs under bun without
 * the Next.js module context. */
import {
  adminSetTier as adminSetTierImpl,
  resolveGrantTarget as resolveGrantTargetImpl,
  getAccountByEmail as getAccountByEmailImpl,
} from '../src/lib/subscriptions'
import { firebaseRead as firebaseReadImpl } from '../src/lib/firebase-server'

export const adminSetTier = adminSetTierImpl
export const resolveGrantTarget = resolveGrantTargetImpl
export const getAccountByEmail = getAccountByEmailImpl

export async function firebaseReadSafe(path: string): Promise<unknown> {
  return firebaseReadImpl(path)
}
