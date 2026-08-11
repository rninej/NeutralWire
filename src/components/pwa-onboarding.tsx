'use client'

import * as React from 'react'
import { X, Heart, Check, ThumbsDown, Globe, Building2, FlaskConical, Stethoscope, Trophy, Cpu, Landmark, Newspaper, Languages, ChevronDown } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/button'
import {
  SECTORS,
  setInterestsLocal,
  syncInterestsWithFirebase,
  bumpEngagement,
} from '@/lib/user-interests'
import { getDeviceId } from '@/lib/referral'
import { getCountryLanguage, ALL_LANGUAGES, type LanguageInfo } from '@/lib/country-languages'

const ONBOARDED_KEY = 'neutralwire:onboarded'
const ONBOARDING_DISMISSED_KEY = 'neutralwire:onboarding-dismissed-at'
const ONBOARDING_DISMISS_DURATION = 1 * 60 * 60 * 1000 // 1 hour
const LANGUAGE_SELECTED_KEY = 'neutralwire:language-selected'
const SELECTED_LANGUAGE_KEY = 'neutralwire:language'
const ARTICLES_OPENED_KEY = 'neutralwire:articles-opened'
const DONATE_SHOWN_KEY = 'neutralwire:donate-shown-at'
const DONATE_NEXT_KEY = 'neutralwire:donate-next-threshold'
const DONATE_PRESSED_KEY = 'neutralwire:donate-pressed'
const INITIAL_THRESHOLD = 10

// ── Subtopic definitions ──
// All subtopics shown in the quiz (except 'relevant' which is customized
// based on these selections).
interface SubtopicDef {
  id: string
  label: string
  icon: React.ReactNode
  color: string
}

const SUBTOPICS: SubtopicDef[] = [
  { id: 'world', label: 'World News', icon: <Globe className="h-5 w-5" />, color: 'from-blue-500/20 to-cyan-500/20' },
  { id: 'politics', label: 'Politics', icon: <Landmark className="h-5 w-5" />, color: 'from-red-500/20 to-orange-500/20' },
  { id: 'business', label: 'Business', icon: <Building2 className="h-5 w-5" />, color: 'from-emerald-500/20 to-green-500/20' },
  { id: 'technology', label: 'Technology', icon: <Cpu className="h-5 w-5" />, color: 'from-purple-500/20 to-indigo-500/20' },
  { id: 'science', label: 'Science', icon: <FlaskConical className="h-5 w-5" />, color: 'from-teal-500/20 to-cyan-500/20' },
  { id: 'health', label: 'Health', icon: <Stethoscope className="h-5 w-5" />, color: 'from-rose-500/20 to-pink-500/20' },
  { id: 'sports', label: 'Sports', icon: <Trophy className="h-5 w-5" />, color: 'from-amber-500/20 to-yellow-500/20' },
  { id: 'top', label: 'Top Stories', icon: <Newspaper className="h-5 w-5" />, color: 'from-zinc-500/20 to-slate-500/20' },
]

/**
 * PWA Onboarding + Donation Trigger.
 *
 * Subtopic-based personalization quiz shown on first launch in the
 * installed PWA (standalone mode only):
 *
 *  Step 1 — "Select topics that interest you": user taps subtopic cards
 *    to mark liked topics. These are saved as the user's interests.
 *  Step 2 — "Select topics you don't want to see": user taps subtopic
 *    cards to mark disliked topics. Each disliked topic gets a negative
 *    engagement bump so those stories are demoted in the feed.
 *  On completion: interests saved to localStorage + Firebase,
 *    ONBOARDED_KEY set to 'true', and 'neutralwire:interests-changed'
 *    event dispatched.
 */
export function PwaOnboarding() {
  const [showOnboarding, setShowOnboarding] = React.useState(false)
  const [showLanguageSelect, setShowLanguageSelect] = React.useState(false)
  const [countryLanguage, setCountryLanguage] = React.useState<LanguageInfo | null>(null)
  const [selectedLanguage, setSelectedLanguage] = React.useState<string>('en')
  const [showDonate, setShowDonate] = React.useState(false)
  const [step, setStep] = React.useState<'likes' | 'dislikes'>('likes')
  const [likedIds, setLikedIds] = React.useState<Set<string>>(new Set())
  const [dislikedIds, setDislikedIds] = React.useState<Set<string>>(new Set())

  React.useEffect(() => {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    if (!isStandalone) return

    const onboarded = localStorage.getItem(ONBOARDED_KEY)
    const dismissedAt = localStorage.getItem(ONBOARDING_DISMISSED_KEY)
    const dismissedRecently = dismissedAt && (Date.now() - parseInt(dismissedAt, 10) < ONBOARDING_DISMISS_DURATION)
    if (!onboarded && !dismissedRecently) {
      // ── Language selection check ──
      // Before showing the personalization quiz, check if the user's
      // country speaks a non-English language. If so, show the language
      // selection popup FIRST.
      const languageAlreadySelected = localStorage.getItem(LANGUAGE_SELECTED_KEY) === 'true'

      if (!languageAlreadySelected) {
        // Check the detected country from localStorage (set by page-client)
        try {
          const countryRaw = localStorage.getItem('neutralwire:country')
          if (countryRaw) {
            const countryData = JSON.parse(countryRaw)
            const countryCode = countryData?.info?.code || ''
            const lang = getCountryLanguage(countryCode)
            if (lang) {
              // Non-English country — show language popup
              setCountryLanguage(lang)
              setSelectedLanguage(lang.code) // default to country's language
              setTimeout(() => setShowLanguageSelect(true), 1000)
              return // don't show onboarding yet
            }
          }
        } catch {
          // country not detected yet — skip language popup
        }
      }

      // English-speaking country or language already selected → show onboarding
      setTimeout(() => setShowOnboarding(true), 1500)
    }

    // Load saved interests
    try {
      const saved = localStorage.getItem('neutralwire:interests')
      if (saved) setLikedIds(new Set(JSON.parse(saved)))
    } catch { /* ignore */ }

    // Donation popup logic
    const checkDonationPopup = (articlesOpened: number) => {
      const pressed = localStorage.getItem(DONATE_PRESSED_KEY) === 'true'
      const shownAt = parseInt(localStorage.getItem(DONATE_SHOWN_KEY) || '0', 10)
      let nextThreshold = parseInt(localStorage.getItem(DONATE_NEXT_KEY) || '0', 10)
      if (pressed) {
        const threeMonths = 90 * 24 * 60 * 60 * 1000
        if (Date.now() - shownAt > threeMonths) {
          localStorage.setItem(DONATE_PRESSED_KEY, 'false')
          localStorage.setItem(DONATE_NEXT_KEY, '0')
          setShowDonate(true)
        }
        return
      }
      if (nextThreshold === 0) nextThreshold = INITIAL_THRESHOLD
      if (articlesOpened >= nextThreshold) {
        setShowDonate(true)
      }
    }

    const handleTopicOpened = () => {
      let count = parseInt(localStorage.getItem(ARTICLES_OPENED_KEY) || '0', 10)
      count += 1
      localStorage.setItem(ARTICLES_OPENED_KEY, String(count))
      checkDonationPopup(count)
    }

    window.addEventListener('neutralwire:topic-opened', handleTopicOpened)
    return () => window.removeEventListener('neutralwire:topic-opened', handleTopicOpened)
  }, [])

  const handleComplete = async () => {
    const interestsArray = Array.from(likedIds)
    localStorage.setItem(ONBOARDED_KEY, 'true')
    setInterestsLocal(interestsArray)
    setShowOnboarding(false)

    const deviceId = typeof window !== 'undefined' ? getDeviceId() : ''
    if (deviceId) {
      syncInterestsWithFirebase(deviceId, interestsArray).catch(() => {})
      // Apply dislikes as negative engagement
      for (const sectorId of dislikedIds) {
        if (!likedIds.has(sectorId)) {
          bumpEngagement(deviceId, sectorId, -30, 'dislike').catch(() => {})
        }
      }
    }

    window.dispatchEvent(new CustomEvent('neutralwire:interests-changed'))
  }

  const toggleLike = (id: string) => {
    setLikedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleDislike = (id: string) => {
    setDislikedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleDonatePress = () => {
    localStorage.setItem(DONATE_PRESSED_KEY, 'true')
    localStorage.setItem(DONATE_SHOWN_KEY, String(Date.now()))
    localStorage.setItem(DONATE_NEXT_KEY, '0')
    setShowDonate(false)
    window.open('https://ko-fi.com/neutralwire', '_blank')
  }

  // ── Language selection handler ──
  // Called when the user picks a language from the popup.
  // Saves the choice and proceeds to the personalization quiz.
  const handleLanguageSelect = (langCode: string) => {
    localStorage.setItem(LANGUAGE_SELECTED_KEY, 'true')
    localStorage.setItem(SELECTED_LANGUAGE_KEY, langCode)
    setShowLanguageSelect(false)
    // Now show the personalization quiz
    setTimeout(() => setShowOnboarding(true), 300)
  }

  const handleDonateDismiss = () => {
    const currentThreshold = parseInt(localStorage.getItem(DONATE_NEXT_KEY) || '0', 10)
    const newThreshold = currentThreshold === 0 ? INITIAL_THRESHOLD * 2 : currentThreshold * 2
    localStorage.setItem(DONATE_NEXT_KEY, String(newThreshold))
    localStorage.setItem(DONATE_SHOWN_KEY, String(Date.now()))
    setShowDonate(false)
  }

  // ── Language selection popup (PWA only, non-English countries) ──
  // Shows BEFORE the personalization quiz. Two options:
  //   1. English (top — default for the app)
  //   2. Country's language (bottom — with a dropdown to pick a different language)
  if (showLanguageSelect && countryLanguage) {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
          className="glass w-full max-w-md rounded-3xl bg-background/95 backdrop-blur-xl border border-border/50 shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="relative bg-gradient-to-br from-foreground/5 to-foreground/10 px-6 pt-6 pb-4">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-foreground text-background">
                <Languages className="h-6 w-6" />
              </div>
              <div>
                <h2 className="text-xl font-bold">Choose your language</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Select your preferred language for NeutralWire
                </p>
              </div>
            </div>
          </div>

          {/* Language options */}
          <div className="p-6 space-y-3">
            {/* Option 1: English (top) */}
            <button
              onClick={() => handleLanguageSelect('en')}
              className="w-full flex items-center gap-3 rounded-2xl border-2 border-border p-4 text-left hover:border-foreground/30 hover:bg-muted/50 transition-colors group"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10 text-2xl">
                🇬🇧
              </div>
              <div className="flex-1">
                <div className="font-semibold">English</div>
                <div className="text-sm text-muted-foreground">English</div>
              </div>
              <ChevronDown className="h-5 w-5 text-muted-foreground group-hover:text-foreground transition-colors -rotate-90" />
            </button>

            {/* Option 2: Country's language (bottom, with selector) */}
            <div className="rounded-2xl border-2 border-border p-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10 text-2xl">
                  🌐
                </div>
                <div className="flex-1">
                  <div className="font-semibold">{countryLanguage.nativeName}</div>
                  <div className="text-sm text-muted-foreground">{countryLanguage.name}</div>
                </div>
              </div>

              {/* Language selector dropdown */}
              <div className="relative">
                <select
                  value={selectedLanguage}
                  onChange={(e) => setSelectedLanguage(e.target.value)}
                  className="w-full appearance-none rounded-xl border border-border bg-background px-4 py-2.5 pr-10 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-foreground/20"
                >
                  {ALL_LANGUAGES.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.nativeName} ({lang.name})
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              </div>

              <Button
                onClick={() => handleLanguageSelect(selectedLanguage)}
                className="w-full mt-3"
                size="sm"
              >
                Continue in {ALL_LANGUAGES.find((l) => l.code === selectedLanguage)?.nativeName || selectedLanguage}
              </Button>
            </div>
          </div>

          {/* Footer note */}
          <div className="px-6 pb-6">
            <p className="text-xs text-muted-foreground text-center">
              You can change this later in settings
            </p>
          </div>
        </motion.div>
      </div>
    )
  }

  // ── Onboarding popup ──
  if (showOnboarding) {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
          // .glass activates the platform-specific backdrop blur + bg opacity
          // (frosted on Android, liquid on Apple, fallback to the inline
          // bg-background/95 backdrop-blur-xl on other platforms).
          className="glass w-full max-w-md rounded-3xl bg-background/95 backdrop-blur-xl border border-border/50 shadow-2xl overflow-hidden"
        >
          {/* Header with gradient */}
          <div className="relative bg-gradient-to-br from-foreground/5 to-foreground/10 px-6 pt-6 pb-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold">
                  {step === 'likes' ? 'Welcome to NeutralWire' : 'Almost there'}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {step === 'likes'
                    ? 'Select topics that interest you'
                    : 'Select topics you don\'t want to see'}
                </p>
              </div>
              <button
                onClick={() => {
                  setShowOnboarding(false)
                  localStorage.setItem(ONBOARDING_DISMISSED_KEY, String(Date.now()))
                }}
                className="text-muted-foreground hover:text-foreground p-1.5 rounded-lg hover:bg-muted/50 transition-colors"
                aria-label="Dismiss"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {/* Progress indicator */}
            <div className="mt-3 flex gap-1.5">
              <div className={`h-1 flex-1 rounded-full transition-colors ${step === 'likes' ? 'bg-foreground' : 'bg-foreground/60'}`} />
              <div className={`h-1 flex-1 rounded-full transition-colors ${step === 'dislikes' ? 'bg-foreground' : 'bg-foreground/20'}`} />
            </div>
          </div>

          {/* Subtopic grid */}
          <div className="p-6">
            <div className="grid grid-cols-2 gap-3">
              {SUBTOPICS.map((topic, i) => {
                const isSelected = step === 'likes'
                  ? likedIds.has(topic.id)
                  : dislikedIds.has(topic.id)
                const isExcluded = step === 'dislikes' && likedIds.has(topic.id)

                return (
                  <motion.button
                    key={topic.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.05, duration: 0.25 }}
                    whileHover={{ scale: isExcluded ? 1 : 1.03 }}
                    whileTap={{ scale: isExcluded ? 1 : 0.97 }}
                    onClick={() => isExcluded ? null : (step === 'likes' ? toggleLike(topic.id) : toggleDislike(topic.id))}
                    disabled={isExcluded}
                    className={`relative flex flex-col items-center gap-2 rounded-2xl border p-4 transition-all overflow-hidden ${
                      isSelected
                        ? step === 'likes'
                          ? 'border-emerald-500 bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 ring-1 ring-emerald-500/30'
                          : 'border-rose-500 bg-gradient-to-br from-rose-500/10 to-rose-500/5 ring-1 ring-rose-500/30'
                        : isExcluded
                          ? 'border-border/30 opacity-40 cursor-not-allowed'
                          : 'border-border hover:bg-muted/50'
                    }`}
                  >
                    {/* Background gradient when selected */}
                    {isSelected && (
                      <div className={`absolute inset-0 bg-gradient-to-br ${topic.color} pointer-events-none`} />
                    )}
                    <div className={`relative z-10 ${isSelected ? (step === 'likes' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400') : 'text-foreground/70'}`}>
                      {topic.icon}
                    </div>
                    <span className={`relative z-10 text-sm font-medium ${isSelected ? '' : 'text-foreground/80'}`}>
                      {topic.label}
                    </span>
                    {/* Check or thumbs-down badge */}
                    <AnimatePresence>
                      {isSelected && (
                        <motion.div
                          initial={{ scale: 0, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0, opacity: 0 }}
                          transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                          className={`absolute top-2 right-2 flex h-5 w-5 items-center justify-center rounded-full z-20 ${
                            step === 'likes' ? 'bg-emerald-500' : 'bg-rose-500'
                          }`}
                        >
                          {step === 'likes' ? <Check className="h-3 w-3 text-white" /> : <ThumbsDown className="h-3 w-3 text-white" />}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.button>
                )
              })}
            </div>

            {/* Action buttons */}
            <div className="mt-6 flex gap-2">
              {step === 'dislikes' && (
                <Button
                  variant="ghost"
                  onClick={() => setStep('likes')}
                  className="flex-shrink-0"
                >
                  Back
                </Button>
              )}
              {step === 'likes' ? (
                <Button
                  onClick={() => setStep('dislikes')}
                  className="flex-1"
                >
                  Next →
                </Button>
              ) : (
                <Button
                  onClick={handleComplete}
                  className="flex-1"
                >
                  Done — show me my news
                </Button>
              )}
            </div>

            {/* Selection count */}
            <div className="mt-2 text-center text-xs text-muted-foreground">
              {step === 'likes'
                ? `${likedIds.size} topic${likedIds.size === 1 ? '' : 's'} selected`
                : `${dislikedIds.size} topic${dislikedIds.size === 1 ? '' : 's'} selected`}
            </div>
          </div>
        </motion.div>
      </div>
    )
  }

  // ── Donation popup ──
  if (showDonate) {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="w-full max-w-sm rounded-2xl bg-background p-6 shadow-2xl text-center"
        >
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-r from-pink-500 to-red-500">
            <Heart className="h-7 w-7 fill-white text-white" />
          </div>
          <h2 className="mb-2 text-lg font-bold">Support NeutralWire</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            NeutralWire is built by a 15-year-old working alone, for free. If it's been useful, consider buying him a coffee. Every bit helps keep the servers running.
          </p>
          <div className="flex flex-col gap-2">
            <Button
              onClick={handleDonatePress}
              className="w-full bg-gradient-to-r from-pink-500 to-red-500 text-white hover:opacity-90"
            >
              <Heart className="mr-2 h-4 w-4 fill-white" /> Donate on Ko-fi
            </Button>
            <Button onClick={handleDonateDismiss} variant="ghost" className="w-full text-xs text-muted-foreground">
              Maybe later
            </Button>
          </div>
        </motion.div>
      </div>
    )
  }

  return null
}
