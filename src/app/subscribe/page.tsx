import type { Metadata } from 'next'
import { SubscribePage } from '@/components/subscribe-page'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export const metadata: Metadata = {
  title: 'NeutralWire Premium — plans from $3/month',
  description:
    'Free stays free. Premium builds your own newsroom: 550+ custom subtopics, the full archive, the AI email newsletter, gradient themes and your own header style. Ultra adds API access and article export. Payments via Ko-fi — cancel anytime.',
}

/** The dedicated subscription page — the header Premium button's target. */
export default function Page() {
  return <SubscribePage />
}
