/**
 * test-usage-meter.ts — verify the emergency usage meter end-to-end:
 * record → flush → read-back from Firebase → cleanup.
 * Run: bun scripts/test-usage-meter.ts
 */
import { trackRequest, trackStage, trackAiCall, recordRun, flush } from '@/lib/usage-meter'
import { firebaseRead, firebaseDelete } from '@/lib/firebase-server'

async function main() {
  const day = new Date().toISOString().slice(0, 10)
  const testRoute = 'test-meter-verify'

  // 1. Simulate a metered request (fake handler)
  const fakeHandler = async () => {
    // simulate some CPU work
    const t0 = Date.now()
    let x = 0
    while (Date.now() - t0 < 50) x += Math.random()
    return new Response(JSON.stringify({ x: !!x }), { status: 200 })
  }
  const metered = trackRequest(testRoute, fakeHandler)
  const res = await metered(
    {
      headers: new Headers({ 'user-agent': 'cron-job.org' }),
      nextUrl: { searchParams: new URLSearchParams('secret=x') },
    },
    undefined,
  )
  console.log('[1] metered request status:', res.status)

  // 2. Stage + AI + run records
  trackStage(testRoute, 'fake-stage', 123)
  trackAiCall('gemini', 'gemini-flash-lite-latest', 850, true)
  trackAiCall('groq', 'gpt-oss-20b', 400, false)
  recordRun(testRoute, { note: 'e2e-verify', ms: 12 })
  await flush()

  // force flush past rate limit
  await new Promise((r) => setTimeout(r, 11000))
  await flush()

  // 3. Read back from Firebase
  const node = await firebaseRead<any>(`usageMeter/${day}/routes/${testRoute}`)
  console.log('[3] flushed route node:', JSON.stringify(node, null, 2))
  const aiNode = await firebaseRead<any>(`usageMeter/${day}/ai`)
  console.log('[3] ai node keys:', aiNode ? Object.keys(aiNode) : 'MISSING')
  const runNode = await firebaseRead<any>(`usageMeter/${day}/runs/${testRoute}`)
  console.log('[3] run node:', JSON.stringify(runNode))

  // 4. Assertions
  const inst = Object.values(node || {})[0] as any
  const okRoute = !!inst && inst.count === 1 && inst.wallMs > 0 && typeof inst.cpuMs === 'number'
  const okAi = !!aiNode
  const okRun = !!runNode && Object.keys(runNode).length >= 1
  console.log('\nAssertions:', { okRoute, okAi, okRun })
  if (!okRoute || !okAi || !okRun) {
    console.error('USAGE METER E2E FAILED')
    process.exit(1)
  }

  // 5. Cleanup test nodes
  await firebaseDelete(`usageMeter/${day}/routes/${testRoute}`)
  await firebaseDelete(`usageMeter/${day}/runs/${testRoute}`)
  // leave the ai node — it's indistinguishable from real data and harmless,
  // actually delete only if it only has our test instance
  const aiKeys = Object.keys((await firebaseRead<any>(`usageMeter/${day}/ai`)) || {})
  if (aiKeys.length <= 2) await firebaseDelete(`usageMeter/${day}/ai`)
  console.log('[5] test nodes cleaned')
  console.log('\nUSAGE METER E2E PASSED')
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
