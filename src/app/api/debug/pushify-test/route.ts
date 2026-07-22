import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const API_KEY = process.env.PUSHIFY_API_KEY || ''

export async function GET() {
  const results = []

  const tests = [
    // Maybe it needs 'action_url' instead of 'url'
    { name: 'action_url', body: { title: 'Test', body: 'Hello', action_url: 'https://neutralwire.vercel.app', website_id: '294' } },
    // Maybe 'notification_title' + 'notification_body'
    { name: 'notification_title+body', body: { notification_title: 'Test', notification_body: 'Hello', url: 'https://neutralwire.vercel.app', website_id: '294' } },
    // Maybe it needs 'cta_url' + 'cta_text'
    { name: 'cta_url+cta_text', body: { title: 'Test', body: 'Hello', cta_url: 'https://neutralwire.vercel.app', cta_text: 'Read', website_id: '294' } },
    // Maybe 'link' instead of 'url'
    { name: 'link', body: { title: 'Test', body: 'Hello', link: 'https://neutralwire.vercel.app', website_id: '294' } },
    // Maybe 'target_url'
    { name: 'target_url', body: { title: 'Test', body: 'Hello', target_url: 'https://neutralwire.vercel.app', website_id: '294' } },
    // Maybe 'click_url'
    { name: 'click_url', body: { title: 'Test', body: 'Hello', click_url: 'https://neutralwire.vercel.app', website_id: '294' } },
    // Maybe it needs 'segment_id' or 'audience'
    { name: 'segment_id', body: { title: 'Test', body: 'Hello', url: 'https://neutralwire.vercel.app', website_id: '294', segment_id: 'all' } },
    // Maybe 'is_scheduled' + 'scheduled_at'
    { name: 'is_scheduled', body: { title: 'Test', body: 'Hello', url: 'https://neutralwire.vercel.app', website_id: '294', is_scheduled: false } },
    // Maybe 'type' field
    { name: 'type', body: { title: 'Test', body: 'Hello', url: 'https://neutralwire.vercel.app', website_id: '294', type: 'all' } },
    // Maybe 'send_type'
    { name: 'send_type', body: { title: 'Test', body: 'Hello', url: 'https://neutralwire.vercel.app', website_id: '294', send_type: 'all' } },
  ]

  for (const test of tests) {
    try {
      const res = await fetch('https://pushify.com/api/personal-notifications', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'NeutralWire/1.0',
        },
        body: JSON.stringify(test.body),
        cache: 'no-store',
      })
      const text = await res.text()
      results.push({ fields: test.name, status: res.status, response: text.slice(0, 200) })
      if (res.ok) break
    } catch (e) {
      results.push({ fields: test.name, error: String(e) })
    }
  }

  return NextResponse.json({ results })
}
