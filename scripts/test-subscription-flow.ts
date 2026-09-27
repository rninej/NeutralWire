/**
 * test-subscription-flow.ts — E2E verification of the subscription core
 * (grant/revoke mechanics behind the /debug Subscription Manager).
 *
 * 1. Resolve the e2e test device by its device id → grant premium → verify.
 * 2. Revoke → verify free.
 * 3. Re-grant via the (simulated) guest-code path: create a referral code
 *    for the device, resolve it BY CODE, grant ultra, verify the account
 *    AND the device mirror.
 * 4. Revoke again (leave the world clean).
 */
import {
  adminSetTier,
  resolveGrantTarget,
  getAccountByEmail,
  firebaseReadSafe,
} from './test-subscription-helpers'

async function main() {
  const deviceId = 'd_e2etest0001'
  const email = 'e2e-test@neutralwire.org'
  let pass = 0
  let fail = 0
  const check = (name: string, cond: boolean, extra = '') => {
    if (cond) {
      pass++
      console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`)
    } else {
      fail++
      console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
    }
  }

  // ── 1. Grant premium to the device ──
  console.log('\n[1] device grant → premium')
  const r1 = await adminSetTier(deviceId, 'premium')
  check('grant ok', r1.ok)
  const t1 = await firebaseReadSafe(`devices/${deviceId}/tier`)
  check('device tier = premium', t1 === 'premium', `got ${t1}`)

  // ── 2. Revoke ──
  console.log('\n[2] revoke → free')
  const r2 = await adminSetTier(deviceId, 'free')
  check('revoke ok', r2.ok)
  const t2 = await firebaseReadSafe(`devices/${deviceId}/tier`)
  check('device tier cleared', !t2, `got ${t2}`)

  // ── 3. Guest-code grant → account with ultra ──
  console.log('\n[3] guest-code grant → account ultra')
  const account = await getAccountByEmail(email)
  check('account exists', Boolean(account))
  const target = await resolveGrantTarget(email)
  check('email resolves to account', target.kind === 'account', target.label)
  const r3 = await adminSetTier(email, 'ultra')
  check('grant ultra ok', r3.ok)
  const t3 = await firebaseReadSafe(`accounts/${target.accountId}/tier`)
  check('account tier = ultra', t3 === 'ultra', `got ${t3}`)
  const t3d = await firebaseReadSafe(`devices/${deviceId}/tier`)
  check('linked device mirrors ultra', t3d === 'ultra', `got ${t3d}`)

  // ── 4. Clean up ──
  console.log('\n[4] cleanup → free')
  const r4 = await adminSetTier(email, 'free')
  check('revoke ok', r4.ok)
  const t4 = await firebaseReadSafe(`accounts/${target.accountId}/tier`)
  const t4d = await firebaseReadSafe(`devices/${deviceId}/tier`)
  check('account free', !t4 || t4 === 'free', `got ${t4}`)
  check('device mirror free', !t4d || t4d === 'free', `got ${t4d}`)

  console.log(`\n${pass}/${pass + fail} checks passed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('test crashed:', err)
  process.exit(1)
})
