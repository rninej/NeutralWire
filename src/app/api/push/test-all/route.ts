import { NextRequest, NextResponse } from 'next/server'
import { sendPushifyNotification } from '@/lib/pushify'
import type { TopicArticle } from '@/lib/news-aggregator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 60

/**
 * Send 3 daily news notifications to all subscribers.
 * Body: { deviceId: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { deviceId?: string }
    if (!body.deviceId) {
      return NextResponse.json({ error: 'Missing deviceId' }, { status: 400 })
    }

    const origin = req.nextUrl.origin

    // Fetch top 3 different stories.
    let topStories: TopicArticle[] = []
    try {
      const newsRes = await fetch(
        `${origin}/api/news?category=top&limit=3&minCoverage=3`,
        { cache: 'no-store' },
      )
      if (newsRes.ok) {
        const newsData = await newsRes.json()
        topStories = newsData.topics?.slice(0, 3) || []
      }
    } catch {
      // continue without
    }

    const slots = [
      { slot: 'morning', title: 'Morning News — Top Story' },
      { slot: 'lunch', title: 'Lunch Update — Do Not Miss' },
      { slot: 'evening', title: 'Evening Briefing — Daily Recap' },
    ]

    let totalSent = 0

    for (let i = 0; i < slots.length; i++) {
      const slotInfo = slots[i]
      const story = topStories[i] || topStories[0]

      const imageUrl = story?.imageUrl
        ? `${origin}/api/img?url=${encodeURIComponent(story.imageUrl)}`
        : `${origin}/icon-512.png`

      const result = await sendPushifyNotification({
        title: slotInfo.title,
        description: story ? story.title : 'Tap to read the latest neutral news.',
        url: story ? `${origin}/?topic=${story.topicId}` : origin,
        image: imageUrl,
        origin,
      })

      totalSent += result.sent
    }

    return NextResponse.json({
      sent: totalSent,
      topStory: topStories[0]?.title?.slice(0, 60) || null,
      message:
        totalSent > 0
          ? `${totalSent} notifications sent! Check your phone.`
          : 'Failed to send. Make sure you enabled notifications.',
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to send', detail: String(err) },
      { status: 500 },
    )
  }
}
