import { NextResponse } from 'next/server'
import { getProviderCatalog } from '@/lib/ai-providers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 15

/**
 * GET /api/debug/models — the live AI model catalog each API key sees.
 *
 * Answers the owner's "check available models / are we using the correct
 * ones" question with PRODUCTION truth instead of guesses: which models
 * the key's ListModels endpoints actually return, which of our preferred
 * IDs exist there, and the live health table (per-model ok/fail/429/404 +
 * cooldowns) the fallback chain is learning from.
 *
 * WHY PUBLIC (unlike the other /api/debug routes): the payload contains
 * model NAMES and aggregate counters only — no API keys, no prompts, no
 * user data. The /models endpoints it calls are free (no tokens spent) and
 * memoized per server instance, so it can't be abused to burn chat quota.
 * The debug status board (/api/debug/apis) stays password-protected
 * because it names key LOCATIONS.
 */
export async function GET() {
  try {
    const catalog = await getProviderCatalog()
    return NextResponse.json(
      {
        ok: true,
        note: 'Live provider catalogs as seen by THIS server instance. textRanked = ranked usable text models; preferencesLive = our preferred IDs the key can actually see; health = lifetime ok/fail + cooldowns.',
        ...catalog,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: 'catalog failed', detail: String(err).slice(0, 200) },
      { status: 500 },
    )
  }
}
