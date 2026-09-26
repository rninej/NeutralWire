'use client'

/**
 * add-topic-button.tsx — the "+" chip with the golden diamond corner.
 *
 * The Premium subtopic entry point, appended to every subtopic-header row
 * (cards / tabs variants). Golden diamond sits on the TOP-RIGHT corner of
 * the + chip (per the user spec) so the affordance reads "premium add".
 *
 • Everyone SEES it (discovery is free); tapping it as a free user opens
 • the upgrade dialog; premium users get the SubtopicPicker sheet.
 */

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PremiumDiamond } from '@/components/premium-ui'
import { useSubscription, openUpgradeDialog } from '@/lib/subscription-client'
import {
  getCustomTopics,
  CUSTOM_TOPICS_EVENT,
  type CustomTopicRef,
} from '@/lib/custom-topics-client'

export function AddTopicChip({ compact = false }: { compact?: boolean }) {
  const sub = useSubscription()
  const [pickerOpen, setPickerOpen] = React.useState(false)

  // Lazy-load the picker only when first opened (code-splitting).
  const SubtopicPicker = React.useMemo(
    () => React.lazy(() => import('@/components/subtopic-picker').then((m) => ({ default: m.SubtopicPicker }))),
    [],
  )

  const onClick = () => {
    if (sub.model === 'subscription' && !sub.entitlements.customSubtopics && !sub.loading) {
      openUpgradeDialog('customSubtopics')
      return
    }
    setPickerOpen(true)
  }

  return (
    <>
      <motion.button
        type="button"
        whileTap={{ scale: 0.94 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        onClick={onClick}
        aria-label="Add a subtopic (Premium)"
        title="Add custom subtopics"
        className={cn(
          'relative inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-amber-500/50 bg-amber-500/10 font-semibold text-amber-600 transition-colors hover:bg-amber-500/20 dark:text-amber-400',
          compact ? 'h-8 px-3 text-[13px]' : 'h-10 sm:h-9 lg:h-8 shrink-0 px-3.5 text-[13px] sm:text-sm',
        )}
      >
        <Plus className="h-[17px] w-[17px] shrink-0" />
        {!compact && <span className="hidden sm:inline">Topics</span>}
        {/* The golden diamond, pinned to the chip's top-right corner */}
        <span className="absolute -right-1 -top-1 flex h-[14px] w-[14px] items-center justify-center rounded-full bg-background">
          <PremiumDiamond className="h-3 w-3" />
        </span>
      </motion.button>

      <AnimatePresence>
        {pickerOpen && (
          <React.Suspense fallback={null}>
            <SubtopicPicker onClose={() => setPickerOpen(false)} />
          </React.Suspense>
        )}
      </AnimatePresence>
    </>
  )
}

/**
 * Custom topic chips for a header row: the user's pinned custom
 * subtopics, rendered like category chips (Gem icon + label, active pill
 * when selected). Re-renders live when topics are added/removed.
 */
export function CustomTopicChips({
  activeCategory,
  onSelect,
  chipClassName,
  activeChipClassName,
}: {
  activeCategory: string
  onSelect: (category: string) => void
  chipClassName?: string
  activeChipClassName?: string
}) {
  const [topics, setTopics] = React.useState<CustomTopicRef[]>([])

  React.useEffect(() => {
    setTopics(getCustomTopics())
    const onChanged = () => setTopics(getCustomTopics())
    window.addEventListener(CUSTOM_TOPICS_EVENT, onChanged)
    return () => window.removeEventListener(CUSTOM_TOPICS_EVENT, onChanged)
  }, [])

  if (topics.length === 0) return null

  return (
    <>
      {topics.map((t) => {
        const catId = `custom:${t.id}`
        const active = activeCategory === catId
        return (
          <motion.button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            whileTap={{ scale: 0.94 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            onClick={() => onSelect(catId)}
            className={cn(
              'relative inline-flex h-10 sm:h-9 lg:h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 lg:px-3 text-[13px] sm:text-sm lg:text-[13px] font-semibold transition-colors',
              chipClassName,
              active ? activeChipClassName : 'text-foreground/75 hover:bg-muted hover:text-foreground',
            )}
          >
            <PremiumDiamond className="h-[15px] w-[15px] shrink-0 opacity-80" />
            <span>{t.label}</span>
          </motion.button>
        )
      })}
    </>
  )
}
