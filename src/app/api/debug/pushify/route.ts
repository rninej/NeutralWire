import { NextResponse } from 'next/server'
import { getPushifyWebsites, getPushifySubscriberCount } from '@/lib/pushify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Debug endpoint that checks Pushify integration status.
 * Returns: API key configured, websites registered, subscriber count.
 */
export async function GET() {
  const apiKey = process.env.PUSHIFY_API_KEY || ''
  const pixelKey = process.env.NEXT_PUBLIC_PUSHIFY_PIXEL_KEY || ''

  const websites = await getPushifyWebsites()
  const subscriberCount = await getPushifySubscriberCount()

  return NextResponse.json({
    apiKeyConfigured: !!apiKey,
    pixelKeyConfigured: !!pixelKey,
    pixelKey: pixelKey ? pixelKey.slice(0, 8) + '...' : 'NOT SET',
    websites: websites.map((w) => ({
      id: w.id,
      domain: w.domain,
      pixelKey: w.pixel_key?.slice(0, 8) + '...' || 'N/A',
    })),
    subscriberCount,
    instructions: websites.length === 0
      ? 'No websites registered on Pushify. Go to pushify.com dashboard → Add Website → enter neutralwire.vercel.app. Then copy the pixel key and set NEXT_PUBLIC_PUSHIFY_PIXEL_KEY env var on Vercel.'
      : 'Pushify website found. Make sure the pixel key is set as NEXT_PUBLIC_PUSHIFY_PIXEL_KEY on Vercel.',
  })
}
