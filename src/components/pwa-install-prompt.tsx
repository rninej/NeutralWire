'use client'

import * as React from 'react'
import { Download, X, Share, Plus, Bell, CheckCircle2, Menu } from 'lucide-react'
import { Button } from '@/components/ui/button'

const DISMISS_KEY = 'neutralwire:pwa-install-dismissed'
const INSTALLED_KEY = 'neutralwire:pwa-installed-flag'
// 24h dismiss cooldown. Applied to both the "Maybe later" button AND the
// native prompt's "dismissed" outcome (so a user who dismisses the Chrome
// install dialog won't be re-prompted for 24h).
const DISMISS_DURATION = 24 * 60 * 60 * 1000

// Scroll threshold (px) — after the user scrolls this far down the feed,
// we consider them "engaged" and show the install prompt (high-conversion
// moment). 400px ≈ 2–3 topic cards.
const SCROLL_THRESHOLD = 400

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type InstallMode = 'native' | 'samsung' | 'ios' | 'none'

/**
 * PWA install prompt — cross-browser reliable install flow.
 *
 * ── Browser detection (the core of this component) ──
 *
 * 1. **Samsung Internet** (`SamsungBrowser` in UA):
 *    Samsung Internet's `beforeinstallprompt` implementation is unreliable
 *    and calling `deferredPrompt.prompt()` can trigger an "unsafe app"
 *    security warning. We therefore IGNORE `beforeinstallprompt` entirely
 *    on Samsung Internet and show a step-by-step instruction modal:
 *      Menu (☰) → "Add to Home screen" → Install
 *
 * 2. **iOS Safari** (`iPhone`/`iPad` in UA, excluding `CriOS`):
 *    iOS does not fire `beforeinstallprompt` at all. We show an instruction
 *    modal:
 *      Share (⎋) → "Add to Home Screen" → Add
 *
 * 3. **Chrome / Edge / Firefox on Android** (native mode):
 *    Listen for `beforeinstallprompt`, store the event (do NOT call
 *    `prompt()` immediately — that would waste the one-shot event).
 *    Show a banner with an "Install" button. Only when the user TAPS the
 *    button do we call `deferredPrompt.prompt()` — this is the user
 *    gesture that satisfies the browser's "require user activation" rule
 *    and avoids "unsafe app" / popup-blocked warnings.
 *
 * ── High-conversion triggers ──
 * The banner/modal is shown at moments when the user is most likely to
 * install:
 *   • `?topic=` URL param (user opened a shared story link — highest intent)
 *   • `neutralwire:topic-opened` event (user tapped a story card)
 *   • Scroll past 400px (user is engaged with the feed)
 *   • 3s delay on Samsung/iOS home page (gentle nudge)
 *
 * ── After install ──
 * On `appinstalled` (or when the user accepts the native prompt), we:
 *   • Hide the banner/modal
 *   • Set `INSTALLED_KEY` in localStorage (prevents re-showing on reload
 *     even if the standalone check hasn't kicked in yet)
 *   • Show a brief "Installed!" confirmation toast
 *
 * Note: `page-client.tsx` also listens for `appinstalled` to report the
 * install to the server and reload the page into standalone mode. Both
 * listeners coexist fine.
 */
export function PwaInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] =
    React.useState<BeforeInstallPromptEvent | null>(null)
  const [showBanner, setShowBanner] = React.useState(false)
  const [mode, setMode] = React.useState<InstallMode>('none')
  const [showInstalledToast, setShowInstalledToast] = React.useState(false)

  // Refs mirror the state above so async callbacks (setTimeout, event
  // listeners) can read the latest value without re-subscribing.
  const deferredPromptRef = React.useRef<BeforeInstallPromptEvent | null>(null)
  const modeRef = React.useRef<InstallMode>('none')
  const installedRef = React.useRef(false)
  // Prevents the banner from being shown multiple times in one session
  // (e.g., scroll + topic-opened firing close together).
  const shownRef = React.useRef(false)

  React.useEffect(() => {
    const ua = window.navigator.userAgent

    // ── Browser detection ──
    // Samsung Internet (Android): UA contains "SamsungBrowser".
    // Has its own install flow via the menu button. We must NOT call
    // deferredPrompt.prompt() here — it triggers an "unsafe app" warning.
    const isSamsungInternet = ua.includes('SamsungBrowser')

    // iOS Safari (per spec): iPhone/iPad AND NOT Chrome iOS (CriOS).
    // iOS doesn't support beforeinstallprompt — must use the Share menu.
    const isSafariIOS =
      (ua.includes('iPhone') || ua.includes('iPad')) &&
      !ua.includes('CriOS')

    // Determine install mode.
    let installMode: InstallMode = 'native'
    if (isSamsungInternet) installMode = 'samsung'
    else if (isSafariIOS) installMode = 'ios'

    // Desktop detection — don't show install prompt on desktop browsers.
    // Only applies to 'native' mode (Samsung/iOS are inherently mobile).
    if (installMode === 'native') {
      const isDesktop =
        window.innerWidth >= 1024 &&
        !/android|mobile|iphone|ipad|ipod|windows phone/i.test(ua) &&
        !('ontouchstart' in window)
      if (isDesktop) installMode = 'none'
    }

    if (installMode === 'none') return

    // Check if already in standalone mode (PWA is installed & launched).
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone ===
        true
    if (standalone) {
      installedRef.current = true
      return
    }

    // Check the localStorage "installed" flag (set when the user accepted
    // the native prompt or when appinstalled fired). This catches the race
    // where the user installs but hasn't reopened the PWA yet.
    if (localStorage.getItem(INSTALLED_KEY) === 'true') {
      installedRef.current = true
      return
    }

    setMode(installMode)
    modeRef.current = installMode

    // ── Dismiss cooldown check ──
    // Returns true if the user recently dismissed the prompt (within 24h).
    const isDismissed = () => {
      const dismissedAt = localStorage.getItem(DISMISS_KEY)
      if (!dismissedAt) return false
      const age = Date.now() - parseInt(dismissedAt, 10)
      return age < DISMISS_DURATION
    }

    // ── Core show logic ──
    // Only shows the banner if ALL of these are true:
    //   1. Not already shown in this session (shownRef)
    //   2. Not dismissed within 24h (isDismissed)
    //   3. Not already installed (installedRef)
    //   4. For 'native' mode: deferredPrompt is available (beforeinstallprompt
    //      has fired). Without this, the Install button would be disabled
    //      ("Loading…") which is bad UX.
    const showIfAllowed = () => {
      if (shownRef.current) return
      if (isDismissed()) return
      if (installedRef.current) return
      // Native mode requires the beforeinstallprompt event to have fired.
      // Samsung/iOS don't use beforeinstallprompt, so they can show anytime.
      if (modeRef.current === 'native' && !deferredPromptRef.current) return
      shownRef.current = true
      setShowBanner(true)
    }

    // ── Trigger 1: ?topic= URL param (shared story link) ──
    // Highest-conversion moment — user came from a share link and is
    // engaged with a specific story.
    const urlParams = new URLSearchParams(window.location.search)
    const hasTopicParam = urlParams.has('topic')

    if (hasTopicParam) {
      // Small delay so the topic detail renders first
      setTimeout(showIfAllowed, 800)
    } else if (installMode !== 'native') {
      // Trigger 2: Samsung/iOS home page — gentle nudge after 3s.
      // (Native mode waits for beforeinstallprompt instead.)
      setTimeout(showIfAllowed, 3000)
    }

    // ── Trigger 3: scroll past 400px (engagement signal) ──
    let scrollTriggered = false
    const scrollHandler = () => {
      if (scrollTriggered) return
      if (window.scrollY > SCROLL_THRESHOLD) {
        scrollTriggered = true
        showIfAllowed()
        window.removeEventListener('scroll', scrollHandler)
      }
    }
    window.addEventListener('scroll', scrollHandler, { passive: true })

    // ── beforeinstallprompt listener (native mode only) ──
    // Samsung Internet + iOS: IGNORE this event entirely. Samsung's
    // implementation can trigger "unsafe app" warnings when prompt() is
    // called; iOS simply never fires it.
    const beforeInstallHandler = (e: Event) => {
      if (modeRef.current !== 'native') return
      e.preventDefault()
      deferredPromptRef.current = e as BeforeInstallPromptEvent
      setDeferredPrompt(e as BeforeInstallPromptEvent)
      showIfAllowed()
    }
    window.addEventListener('beforeinstallprompt', beforeInstallHandler)

    // ── Trigger 4: topic-opened event (user tapped a story card) ──
    // Dispatched by TopicDetail when the detail overlay opens.
    const topicOpenedHandler = () => {
      // Slightly longer delay so the detail view is fully visible first
      setTimeout(showIfAllowed, 1500)
    }
    window.addEventListener('neutralwire:topic-opened', topicOpenedHandler)

    // ── appinstalled listener — cleanup after install ──
    const installedHandler = () => {
      localStorage.setItem(INSTALLED_KEY, 'true')
      installedRef.current = true
      setShowBanner(false)
      setDeferredPrompt(null)
      deferredPromptRef.current = null
      // Show a brief "Installed!" toast. On Android Chrome the PWA
      // auto-opens after install (and page-client.tsx reloads the tab),
      // so this toast is mainly visible on desktop / when the auto-open
      // is delayed.
      setShowInstalledToast(true)
      setTimeout(() => setShowInstalledToast(false), 6000)
    }
    window.addEventListener('appinstalled', installedHandler)

    return () => {
      window.removeEventListener('beforeinstallprompt', beforeInstallHandler)
      window.removeEventListener('neutralwire:topic-opened', topicOpenedHandler)
      window.removeEventListener('appinstalled', installedHandler)
      window.removeEventListener('scroll', scrollHandler)
    }
  }, [])

  const handleDismiss = () => {
    // Set the 24h dismiss cooldown.
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
    setShowBanner(false)
  }

  // ── Native install handler (Chrome/Edge/Firefox Android) ──
  // CRITICAL: This is called from a button onClick — it IS a user gesture.
  // Calling deferredPrompt.prompt() here is safe and will NOT trigger the
  // "unsafe app" warning (which only happens when prompt() is called
  // programmatically without a user gesture, e.g., in a setTimeout).
  const handleNativeInstall = async () => {
    const prompt = deferredPromptRef.current
    if (!prompt) return
    try {
      await prompt.prompt()
      const choice = await prompt.userChoice
      if (choice.outcome === 'accepted') {
        // Mark as installed immediately — the appinstalled event will
        // also fire, but this prevents re-showing the banner in the
        // gap between the user accepting and the event firing.
        localStorage.setItem(INSTALLED_KEY, 'true')
        installedRef.current = true
      } else {
        // User dismissed the native prompt — set 24h cooldown.
        localStorage.setItem(DISMISS_KEY, String(Date.now()))
      }
      setShowBanner(false)
      setDeferredPrompt(null)
      deferredPromptRef.current = null
    } catch (err) {
      // If prompt() fails (e.g., already installed, or called twice),
      // dismiss the banner to avoid a stuck "Loading…" state.
      console.warn('[PWA] install prompt failed:', err)
      setShowBanner(false)
    }
  }

  // ── "Installed!" confirmation toast ──
  if (showInstalledToast) {
    return (
      <div className="fixed bottom-4 left-4 right-4 z-[70] mx-auto max-w-sm rounded-xl border-2 border-emerald-400 bg-background p-4 shadow-lg">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
            <CheckCircle2 className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <div className="font-semibold text-sm">NeutralWire installed!</div>
            <div className="mt-1 text-xs text-muted-foreground">
              The app is opening now. Look for the NeutralWire icon on your
              home screen to launch it anytime.
            </div>
          </div>
          <button
            onClick={() => setShowInstalledToast(false)}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    )
  }

  if (!showBanner || mode === 'none') return null

  // ── Samsung Internet: instruction modal ──
  // Menu (☰) → "Add to Home screen" → Install
  if (mode === 'samsung') {
    return (
      <InstallInstructionsModal
        title="Install NeutralWire"
        onDismiss={handleDismiss}
        steps={[
          {
            number: 1,
            content: (
              <>
                Tap the{' '}
                <span className="inline-flex items-center gap-1">
                  <Menu className="inline h-3.5 w-3.5" />
                  <strong>menu</strong>
                </span>{' '}
                button (☰) at the top or bottom of Samsung Internet
              </>
            ),
          },
          {
            number: 2,
            content: (
              <>
                Tap{' '}
                <span className="inline-flex items-center gap-1">
                  <Plus className="inline h-3.5 w-3.5" />
                  <strong>Add to Home screen</strong>
                </span>{' '}
                (or &ldquo;Install app&rdquo;)
              </>
            ),
          },
          {
            number: 3,
            content: (
              <>
                Tap <strong>Install</strong> — then open the app from your
                home screen
              </>
            ),
          },
        ]}
        note="You&rsquo;ll get fast access to neutral news and daily notifications."
      />
    )
  }

  // ── iOS Safari: instruction modal ──
  // Share (⎋) → "Add to Home Screen" → Add
  if (mode === 'ios') {
    return (
      <InstallInstructionsModal
        title="Install NeutralWire"
        onDismiss={handleDismiss}
        steps={[
          {
            number: 1,
            content: (
              <>
                Tap the{' '}
                <span className="inline-flex items-center gap-1">
                  <Share className="inline h-3.5 w-3.5" />
                  <strong>Share</strong>
                </span>{' '}
                button at the bottom of Safari
              </>
            ),
          },
          {
            number: 2,
            content: (
              <>
                Scroll down and tap{' '}
                <span className="inline-flex items-center gap-1">
                  <Plus className="inline h-3.5 w-3.5" />
                  <strong>Add to Home Screen</strong>
                </span>
              </>
            ),
          },
          {
            number: 3,
            content: (
              <>
                Tap <strong>Add</strong> — then open the app from your home
                screen
              </>
            ),
          },
        ]}
        note={
          <span className="flex items-start gap-1.5">
            <Bell className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              You&rsquo;ll be asked to allow notifications when you open the
              app
            </span>
          </span>
        }
      />
    )
  }

  // ── Native install banner (Chrome / Edge / Firefox on Android) ──
  // The "Install" button calls deferredPrompt.prompt() inside the onClick
  // handler — this is the user gesture that satisfies the browser's
  // activation requirement and avoids "unsafe app" warnings.
  return (
    <div className="fixed bottom-4 left-4 right-4 z-[60] mx-auto max-w-sm rounded-xl border-2 border-transparent bg-gradient-to-r from-purple-500 via-pink-500 to-orange-400 p-[2px] shadow-lg">
      <div className="rounded-[10px] bg-background p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
            <Download className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <div className="font-semibold text-sm">Install NeutralWire</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              Add to your home screen for quick access to neutral news and
              daily notifications.
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                size="sm"
                className="h-8 text-xs"
                onClick={handleNativeInstall}
                disabled={!deferredPrompt}
              >
                {deferredPrompt ? 'Install' : 'Loading…'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-xs"
                onClick={handleDismiss}
              >
                Not now
              </Button>
            </div>
          </div>
          <button
            onClick={handleDismiss}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Reusable instruction modal (used for Samsung Internet + iOS Safari) ──
// A centered overlay with step-by-step instructions. Tapping the backdrop
// or the X dismisses it (with a 24h cooldown).
interface InstructionStep {
  number: number
  content: React.ReactNode
}

function InstallInstructionsModal({
  title,
  steps,
  note,
  onDismiss,
}: {
  title: string
  steps: InstructionStep[]
  note?: React.ReactNode
  onDismiss: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
      onClick={onDismiss}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-background p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-foreground text-background">
              <Download className="h-4 w-4" />
            </div>
            <h2 className="text-base font-bold">{title}</h2>
          </div>
          <button
            onClick={onDismiss}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Dismiss"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mb-3 text-sm text-muted-foreground">
          Follow these steps to install the app:
        </p>

        <div className="space-y-2">
          {steps.map((step) => (
            <div
              key={step.number}
              className="flex items-start gap-2 rounded-md bg-muted/50 p-2"
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-foreground text-[10px] font-bold text-background">
                {step.number}
              </span>
              <div className="flex-1 text-xs leading-relaxed">
                {step.content}
              </div>
            </div>
          ))}
        </div>

        {note && (
          <div className="mt-3 rounded-md bg-blue-500/10 p-2 text-xs text-blue-600 dark:text-blue-400">
            {note}
          </div>
        )}

        <Button
          size="sm"
          variant="ghost"
          className="mt-4 h-8 w-full text-xs"
          onClick={onDismiss}
        >
          Maybe later
        </Button>
      </div>
    </div>
  )
}
