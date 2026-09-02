import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft, ShieldCheck, Database, Cookie, Globe, Cpu, Server, Ban, Trash2, HeartHandshake } from 'lucide-react'

export const metadata: Metadata = {
  title: 'Privacy Policy — NeutralWire',
  description:
    'Everything NeutralWire collects, where it is stored, who processes it, and how to delete it. No accounts, no ads, no data selling.',
  alternates: { canonical: '/privacy' },
}

export const dynamic = 'force-static'

const LAST_UPDATED = '3 September 2026'

/**
 * /privacy — the NeutralWire privacy policy.
 *
 * Written to match exactly what the app actually does (every localStorage
 * key and Firebase write in the codebase is covered). Linked from the
 * cookie consent banner and the Account page.
 */

const SECTION_ICON = 'mt-1 h-5 w-5 shrink-0 text-foreground/70'

function H2({
  icon,
  children,
}: {
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <h2 className="mb-3 mt-10 flex items-center gap-2.5 text-lg font-bold">
      {icon}
      {children}
    </h2>
  )
}

function Li({ children }: { children: React.ReactNode }) {
  return (
    <li className="mb-2 ml-4 list-disc pl-1 text-sm leading-relaxed text-muted-foreground">
      {children}
    </li>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-[1fr,1.4fr] gap-3 border-b py-2.5 last:border-0 sm:grid-cols-[minmax(160px,1fr),2fr]">
      <div className="text-sm font-semibold">{k}</div>
      <div className="text-sm leading-relaxed text-muted-foreground">{v}</div>
    </div>
  )
}

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-2xl px-4 pb-20 pt-6">
        {/* Back link */}
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to NeutralWire
        </Link>

        <h1 className="mt-6 text-3xl font-extrabold tracking-tight">
          Privacy Policy
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Last updated {LAST_UPDATED}
        </p>

        {/* Short version */}
        <div className="mt-6 rounded-xl border bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-bold">
            <ShieldCheck className="h-4 w-4" />
            The short version
          </div>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            NeutralWire has <b>no accounts</b> — you never give us a name,
            email, or phone number. Everything is tied to a random{' '}
            <b>device ID</b> generated on your phone. We store your settings
            on your device, and a small set of anonymous stats in our
            database so the app can personalize your feed and tell left,
            center, and right coverage apart. We <b>never sell or share</b>{' '}
            your data with advertisers, and we run <b>no ad or tracking
            networks</b>. You can reject all non-essential analytics with one
            tap — and wipe everything by clearing your browser&apos;s site
            data.
          </p>
        </div>

        <H2 icon={<Database className={SECTION_ICON} />}>
          1. What NeutralWire collects
        </H2>
        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
          When you use the app or website, the following information is
          processed. Nothing in this list identifies you personally — there
          is no login, and the ID below is random.
        </p>
        <div className="rounded-xl border">
          <Row
            k="Device ID"
            v="A random ID created in your browser (e.g. d_a8f3…). It keeps your settings, interests, streaks, and referral credit attached to your device — it contains no personal information."
          />
          <Row
            k="Guest name"
            v="A randomly generated nickname (e.g. 'Curious Otter') shown in the app. You can edit it; it is never used to contact you."
          />
          <Row
            k="Your settings"
            v="Theme, light/dark mode, header style, interests, language, and notification frequency — so the app looks and behaves the way you left it."
          />
          <Row
            k="Country & timezone"
            v="Your country is looked up from your IP address once per session (country level only — never your city, street, or GPS position), and your timezone is read from your device clock so briefings arrive at the right local time."
          />
          <Row
            k="Anonymous usage stats"
            v="If you accept analytics: pages viewed, session counts, referrer, approximate browser/device/OS, screen size, and how you engage with topics. Aggregated, and used only to improve the product. Rejecting non-necessary cookies disables this entirely."
          />
          <Row
            k="Notification subscription"
            v="Only if you enable notifications: a push token from your browser, so we can deliver the news briefings you asked for."
          />
          <Row
            k="Referral activity"
            v="If you share your referral link: click counts and successful referrals, credited to your device ID."
          />
          <Row
            k="News content"
            v="Public news stories are fetched from external providers and cached in our database — this is content data, not data about you."
          />
        </div>

        <H2 icon={<Cookie className={SECTION_ICON} />}>
          2. Where it is stored
        </H2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          Two places — your device and our database:
        </p>
        <Li>
          <b>On your device (browser localStorage):</b> device ID, guest
          name, interests, theme family + mode, custom gradient, header
          style preference (a small <code className="rounded bg-muted/60 px-1">nw_nav</code> cookie),
          language, onboarding status, notification frequency, install
          state, your cookie choice, and a short history of which pages
          were counted for analytics. Clearing your browser&apos;s site
          data removes all of it instantly.
        </Li>
        <Li>
          <b>In our Firebase Realtime Database (Google, Europe region):</b>{' '}
          the public news cache, and per-device records containing your
          settings, interests, engagement signals, timezone, country,
          analytics events (if accepted), notification subscription, and
          referral data. These records are keyed by your random device ID.
        </Li>
        <Li>
          <b>On Vercel (our host):</b> standard server logs (IP address,
          timestamps, user agent) retained briefly for security and abuse
          prevention, plus aggregate Web Analytics if you accepted them.
        </Li>

        <H2 icon={<Globe className={SECTION_ICON} />}>
          3. Cookies & your choice
        </H2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          On your first visit we show a cookie banner with exactly two
          options:
        </p>
        <Li>
          <b>Accept all</b> — everything above runs, including anonymous
          analytics that help us understand which features are used.
        </Li>
        <Li>
          <b>Reject non-necessary</b> — the app works fully: news feed,
          personalization, themes, notifications, referrals. Only the
          non-essential analytics are switched off, and nothing is sent
          before you decide — the app waits for your answer.
        </Li>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Your choice is stored on your device and applies from that
          moment on. To change it later, clear the site&apos;s data in
          your browser settings (the banner reappears on your next
          visit).
        </p>

        <H2 icon={<Cpu className={SECTION_ICON} />}>
          4. AI features
        </H2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          Neutral summaries and &quot;Ask AI&quot; answers are generated by
          third-party AI providers (Groq, Google Gemini, OpenRouter). Only{' '}
          <b>news article text and your question about the story</b> are
          sent to them — never your device ID, name, location, or usage
          data. Nothing in your app settings is shared with AI providers.
        </p>

        <H2 icon={<Server className={SECTION_ICON} />}>
          5. Third parties we rely on
        </H2>
        <Li>
          <b>Vercel</b> — hosts the app and (if accepted) aggregate Web
          Analytics. Their handling follows Vercel&apos;s privacy policy.
        </Li>
        <Li>
          <b>Google Firebase</b> — stores the news cache and the
          per-device records described above (servers in Europe).
        </Li>
        <Li>
          <b>ipwho.is</b> — converts your IP into a country name once per
          session. Your IP itself is not stored in our database.
        </Li>
        <Li>
          <b>News providers</b> — GDELT, Guardian, and other public news
          APIs supply story data. They are fetched server-side; they
          receive nothing about you.
        </Li>
        <Li>
          <b>AI providers</b> (Groq, Google, OpenRouter) — see section 4.
        </Li>
        <Li>
          <b>Ko-fi</b> — only if you choose to donate; that transaction
          happens entirely on Ko-fi&apos;s platform.
        </Li>

        <H2 icon={<Ban className={SECTION_ICON} />}>
          6. What we never do
        </H2>
        <Li>No accounts, emails, or phone numbers are ever collected.</Li>
        <Li>No advertising, no ad networks, no cross-site tracking pixels.</Li>
        <Li>
          No precise location — country-level detection only, from your IP.
        </Li>
        <Li>
          No selling, renting, or sharing of your data with anyone for
          marketing or any other purpose.
        </Li>
        <Li>
          No reading of anything outside this app — we only see what the
          app itself sends.
        </Li>

        <H2 icon={<Trash2 className={SECTION_ICON} />}>
          7. Deleting your data
        </H2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          You hold the keys. To erase everything tied to your device:
        </p>
        <Li>
          <b>On the spot:</b> open your browser&apos;s site settings for
          neutralwire.org and choose &quot;Clear site data&quot; (or
          uninstall the app + clear data). This removes the device ID and
          every stored preference immediately — your device becomes a
          brand-new anonymous visitor.
        </Li>
        <Li>
          <b>Server-side records:</b> the remaining database entries are
          keyed only by your old random device ID with no way to contact
          or identify you, but if you want them explicitly wiped, email{' '}
          <a
            href="mailto:privacy@neutralwire.org"
            className="font-semibold underline underline-offset-2"
          >
            privacy@neutralwire.org
          </a>{' '}
          from the device (include the ID shown in Account → Profile) and
          we will delete the record.
        </Li>

        <H2 icon={<HeartHandshake className={SECTION_ICON} />}>
          8. Changes & contact
        </H2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          If this policy materially changes we will update the date at the
          top and, where relevant, show the cookie banner again. Questions
          or concerns? Email{' '}
          <a
            href="mailto:privacy@neutralwire.org"
            className="font-semibold underline underline-offset-2"
          >
            privacy@neutralwire.org
          </a>
          . NeutralWire is a small, independent project — your trust is
          the whole product.
        </p>
      </div>
    </div>
  )
}
