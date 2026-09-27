import type { Metadata } from 'next'
import { DiscoverKit } from '@/components/debug/discover-kit'

/**
 * /debug/discover — the Google Discover Kit.
 *
 * Public (no analytics-password gate): everything here is public SEO
 * guidance + live checks against public routes. The entry card lives in
 * the password-gated /debug dashboard; deep-linking straight here is
 * also fine (nothing sensitive renders).
 */

export const metadata: Metadata = {
  title: 'Google Discover Kit — NeutralWire',
  description: 'The NeutralWire Google Discover programme: plan, resources, live readiness checks.',
  robots: { index: false, follow: false }, // an internal tool — keep it out of Google
}

export default function DiscoverKitPage() {
  return <DiscoverKit />
}
