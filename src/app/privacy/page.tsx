import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft, ShieldCheck, Database, Cookie, Globe, Cpu, Server, Ban, Trash2, HeartHandshake } from 'lucide-react'
import { firebaseRead } from '@/lib/firebase-server'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export const metadata: Metadata = {
  title: 'Privacy Policy — NeutralWire',
  description:
    'Everything NeutralWire collects, where it is stored, who processes it, and how to delete it. Optional accounts, no ads, no data selling.',
  alternates: { canonical: '/privacy' },
}

const LAST_UPDATED = '28 September 2026'

/**
 * /privacy — the NeutralWire privacy policy.
 *
 * Model-aware: the page is server-rendered against the live
 * featureFlags/monetizationModel flag (the same flag /debug flips), so
 * switching the site to the donation model swaps in the donation-era
 * policy on the next load — one click changes everything subscription-
 * related, this page included.
 *
 * Both variants are written to match exactly what the app actually does
 * (every localStorage key and Firebase write in the codebase is covered).
 * Linked from the cookie consent banner and the Account page.
 */

const MONETIZATION_FLAG_TTL_MS = 10 * 1000
let monetizationMemo: { value: 'subscription' | 'donation'; ts: number } | null = null

async function getMonetizationModel(): Promise<'subscription' | 'donation'> {
  if (monetizationMemo && Date.now() - monetizationMemo.ts < MONETIZATION_FLAG_TTL_MS) {
    return monetizationMemo.value
  }
  try {
    const stored = await firebaseRead<string>('featureFlags/monetizationModel')
    const value: 'subscription' | 'donation' = stored === 'donation' ? 'donation' : 'subscription'
    monetizationMemo = { value, ts: Date.now() }
    return value
  } catch {
    return 'subscription'
  }
}

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

export default async function PrivacyPage() {
  const model = await getMonetizationModel()
  const donation = model === 'donation'

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
            NeutralWire works <b>without an account</b> — the whole app runs
            on a random <b>device ID</b> generated on your phone. If you
            {donation ? ' do create one (it syncs your feed across devices), all it holds is your email and a salted password hash' : ' want Premium or the email briefing, an account holds your email and a salted password hash — never a name, never plaintext'}{' '}
            . We store your settings on your device, and a small set of
            anonymous stats in our database so the app can personalize your
            feed and tell left, center, and right coverage apart. We{' '}
            <b>never sell or share</b> your data with advertisers, and we run{' '}
            <b>no ad or tracking networks</b>. You can reject all
            non-essential analytics with one tap — and wipe everything by
            clearing your browser&apos;s site data.
          </p>
        </div>

        <H2 icon={<Database className={SECTION_ICON} />}>
          1. What NeutralWire collects
        </H2>
        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
          When you use the app or website, the following information is
          processed. Everything below is either a random identifier, a
          setting you chose, or something you explicitly typed — nothing
          is bought from data brokers or sniffed from other sites.
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
            k="Country, city & timezone"
            v="Your country — and, when the lookup provides it, your city and region — are looked up from your IP address once per session (approximate, IP-derived — never GPS, Wi-Fi positioning, or your exact address). This powers the My Country and Relevant tabs and surfaces stories about your area. Your timezone is read from your device clock so briefings arrive at the right local time."
          />
          <Row
            k="Anonymous usage stats"
            v="If you accept analytics: pages viewed, session counts, referrer, approximate browser/device/OS, screen size, and how you engage with topics. Aggregated, and used only to improve the product. Rejecting non-necessary cookies disables this entirely."
          />
          <Row
            k="App installs & daily use"
            v="We count installs and daily active users by a one-way salted hash of your IP address (never the IP itself — the hash cannot be reversed to it). Each day is one anonymous tally mark used to see how the app grows. Install events are counted even if you rejected analytics (the app was demonstrably installed); daily-use tallies follow your analytics choice."
          />
          <Row
            k="Community hearts"
            v="If you tap “Love NeutralWire”: one tally mark is added to a public counter, keyed by your device ID so one device can only ever add one heart. No message, no name, nothing else."
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
          {/* ── Account-era rows (both models have accounts; only the paid
              tier row is subscription-specific) ── */}
          <Row
            k="Account (optional)"
            v="Only if you create one: your email address, a salted one-way hash of your password (we never see or store the password itself), and — if you use Google Sign-In — the Google account ID and email that Google hands us during the sign-in flow. An account syncs your feed and settings across devices; the app works fully without one."
          />
          <Row
            k="Sessions"
            v="When signed in, a random session token is stored in an httpOnly cookie (nw_session) and its server-side record — account, device, expiry. Sessions expire and can be ended by logging out."
          />
          {donation ? null : (
            <Row
              k="Subscription record"
              v="Only if you subscribe: your tier (Premium or Ultra), when it started and renews, whether it is set to cancel, the Ko-fi payments linked to your account (message and payment IDs), and one-shot claim codes (valid 48h) that connect a Ko-fi checkout to your account. Payments themselves run on Ko-fi — we never see card details."
            />
          )}
          <Row
            k="Email briefing"
            v="Only if you turn it on: the address to send your NeutralWire digest to, the frequency you picked (up to 3× daily), and delivery state (last sent, unsubscribed). One click on the unsubscribe link in any email removes you from the list."
          />
          {donation ? null : (
            <Row
              k="API key (Ultra)"
              v="Only if you generate one: a random key string (nwul_…) that grants feed API access tied to your account. You can see and revoke it any time in Account."
            />
          )}
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
          the public news cache, per-device records containing your
          settings, interests, engagement signals, timezone, country,
          analytics events (if accepted), notification subscription, and
          referral data — keyed by your random device ID. If you have an
          account: your email + password hash (or Google ID), session
          records{donation ? '' : ', subscription tier and renewal state, Ko-fi payment linkage'}, digest
          preferences and per-subscriber delivery state
          {donation ? '' : ', and API keys'}. Never your password itself.
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
          moment on. The sign-in cookie (<code className="rounded bg-muted/60 px-1">nw_session</code>)
          is strictly functional — it keeps you logged in and is not used
          for tracking. To change your cookie choice later, clear the
          site&apos;s data in your browser settings (the banner reappears
          on your next visit).
        </p>

        <H2 icon={<Cpu className={SECTION_ICON} />}>
          4. AI features
        </H2>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          Neutral summaries, “Ask AI” answers and the email briefing are
          generated by third-party AI providers (Groq, Google Gemini,
          OpenRouter). Only <b>news article text and your question about
          the story</b> are sent to them — never your device ID, email,
          location, or usage data. Nothing in your app settings is shared
          with AI providers.
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
          per-device and account records described above (servers in
          Europe).
        </Li>
        <Li>
          <b>Google (Sign-In)</b> — if you use Google Sign-In, Google
          verifies you and passes your email address and Google account ID
          to us. We use it only to create/log you into your NeutralWire
          account.
        </Li>
        <Li>
          <b>ipwho.is / ip-api.com</b> — convert your IP into a country,
          region, and city name once per session (approximate
          IP-based geolocation). The result is cached on your device; your
          IP itself is not stored in our database.
        </Li>
        <Li>
          <b>News providers</b> — GDELT, Google News, Guardian, and other
          public news APIs supply story data. They are fetched server-side;
          they receive nothing about you.
        </Li>
        <Li>
          <b>AI providers</b> (Groq, Google, OpenRouter) — see section 4.
        </Li>
        <Li>
          <b>Ko-fi</b> — {donation
            ? "only if you choose to donate; that transaction happens entirely on Ko-fi's platform (we receive a confirmation with your payment ID and, if you use the same email, nothing more)."
            : "payments and subscriptions happen entirely on Ko-fi's platform. Ko-fi tells us the payment amount, a payment/message ID, and (if you pay with the email your account uses or paste a claim code) which account to upgrade. We never see your card or bank details."}
        </Li>
        <Li>
          <b>Resend</b> — delivers the email briefing. If you subscribe to
          the digest, Resend processes your email address and the
          newsletter content to send it. No other personal data is
          included, and unsubscribing stops all sends immediately.
        </Li>

        <H2 icon={<Ban className={SECTION_ICON} />}>
          6. What we never do
        </H2>
        <Li>
          No required accounts — the full app works anonymously on a
          device ID; an account is your choice.
        </Li>
        <Li>
          We never ask for your real name, phone number, or address —
          not even with an account.
        </Li>
        <Li>No advertising, no ad networks, no cross-site tracking pixels.</Li>
        <Li>
          No precise location — only an approximate country and city,
          derived from your IP. Never GPS, Wi-Fi positioning, or your
          exact street address.
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
          <b>Your account and emails:</b> sign out, then email{' '}
          <a
            href="mailto:moneyisbroken@gmail.com"
            className="font-semibold underline underline-offset-2"
          >
            moneyisbroken@gmail.com
          </a>{' '}
          from the address on the account and we will delete the account
          record, its subscription and digest entries, and every session —
          usually within 72 hours.
        </Li>
        <Li>
          <b>Server-side records:</b> the remaining database entries are
          keyed only by your old random device ID with no way to contact
          or identify you, but if you want them explicitly wiped, email
          the address above (include the ID shown in Account → Profile)
          and we will delete the record.
        </Li>

        <H2 icon={<HeartHandshake className={SECTION_ICON} />}>
          8. Changes & contact
        </H2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          If this policy materially changes we will update the date at the
          top and, where relevant, show the cookie banner again. Questions
          or concerns? Email{' '}
          <a
            href="mailto:moneyisbroken@gmail.com"
            className="font-semibold underline underline-offset-2"
          >
            moneyisbroken@gmail.com
          </a>
          . NeutralWire is a small, independent project — your trust is
          the whole product.
        </p>
      </div>
    </div>
  )
}
