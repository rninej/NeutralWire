import { NextRequest, NextResponse } from 'next/server'
import { sendPushifyNotification } from '@/lib/pushify'
import type { TopicArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 60

/**
 * Broadcast a single news notification to ALL subscribers (Pushify + web-push).
 *
 * Body: { deviceId: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { deviceId?: string }
    if (!body.deviceId) {
      return NextResponse.json({ error: 'Missing deviceId' }, { status: 400 })
    }

    const origin = req.nextUrl.origin

    // Fetch the current top story.
    let topStory: TopicArticle | null = null
    try {
      const newsRes = await fetch(
        `${origin}/api/news?category=top&limit=1&minCoverage=3`,
        { cache: 'no-store' },
      )
      if (newsRes.ok) {
        const newsData = await newsRes.json()
        topStory = newsData.topics?.[0] || null
      }
    } catch {
      // continue without
    }

    const imageUrl = topStory?.imageUrl
      ? `${origin}/api/img?url=${encodeURIComponent(topStory.imageUrl)}`
      : `${origin}/icon-512.png`

    // Send via Pushify + web-push fallback (both in parallel).
    const result = await sendPushifyNotification({
      title: topStory ? 'News Update' : 'Test from NeutralWire',
      description: topStory
        ? topStory.title.slice(0, 100)
        : 'This is a broadcast test notification.',
      url: topStory ? `${origin}/?topic=${topStory.topicId}` : origin,
      image: imageUrl,
      origin,
    })

    return NextResponse.json({
      success: result.success,
      sent: result.sent,
      error: result.error,
      topStory: topStory?.title?.slice(0, 60) || null,
      message: result.success
        ? `Sent to ${result.sent} device(s)! Check your phone.`
        : `Failed: ${result.error}`,
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Broadcast failed', detail: String(err) },
      { status: 500 },
    )
  }
}
