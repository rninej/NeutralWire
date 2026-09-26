'use client'

/**
 * subtopic-picker.tsx — the Premium subtopic browser (the + button's sheet).
 *
 * • Searchable catalog of 550+ NeutralWire subtopics + every AI-created
 *   runtime topic, grouped for browsing.
 * • Add/remove chips (max 12 custom topics on the header row).
 * • No match? The AI factory creates it: POST /api/subtopics/create
 *   generates keywords, VALIDATES the topic against GDELT (quantity +
 *   relevance) and fills a first feed. Friendly failures explain why an
 *   idea is too narrow for a daily news feed.
 * • Free users get the upgrade dialog instead (the golden-diamond +
 *   button is visible to everyone — discovery is free, subscribing is
 *   premium).
 */

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Search, Loader2, Plus, Check, Sparkles, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { PremiumDiamond } from '@/components/premium-ui'
import {
  useSubscription,
  openUpgradeDialog,
} from '@/lib/subscription-client'
import {
  getCustomTopics,
  addCustomTopic,
  removeCustomTopic,
  CUSTOM_TOPICS_EVENT,
  type CustomTopicRef,
} from '@/lib/custom-topics-client'

interface CatalogTopic {
  id: string
  label: string
  keywords?: string[]
  group?: string
}

interface BrowseResponse {
  catalogSize: number
  runtimeCount?: number
  groups?: Record<string, CatalogTopic[]>
}

export function SubtopicPicker({ onClose }: { onClose: () => void }) {
  const sub = useSubscription()
  const [query, setQuery] = React.useState('')
  const [hits, setHits] = React.useState<CatalogTopic[] | null>(null)
  const [browse, setBrowse] = React.useState<BrowseResponse | null>(null)
  const [searching, setSearching] = React.useState(false)
  const [mine, setMine] = React.useState<CustomTopicRef[]>([])
  const [creating, setCreating] = React.useState(false)
  const [createMsg, setCreateMsg] = React.useState<{ ok: boolean; text: string } | null>(null)

  const unlocked = sub.model === 'donation' || sub.entitlements.customSubtopics

  // Load my topics + browse catalog on open.
  React.useEffect(() => {
    setMine(getCustomTopics())
    fetch('/api/subtopics?limit=60')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: BrowseResponse | null) => d && setBrowse(d))
      .catch(() => {})
    const onChanged = () => setMine(getCustomTopics())
    window.addEventListener(CUSTOM_TOPICS_EVENT, onChanged)
    return () => window.removeEventListener(CUSTOM_TOPICS_EVENT, onChanged)
  }, [])

  // Debounced search.
  React.useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setHits(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const t = setTimeout(() => {
      fetch(`/api/subtopics?q=${encodeURIComponent(q)}&limit=60`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { hits?: CatalogTopic[] } | null) => {
          setHits(d?.hits || [])
        })
        .catch(() => setHits([]))
        .finally(() => setSearching(false))
    }, 250)
    return () => clearTimeout(t)
  }, [query])

  // Lock body scroll while open.
  React.useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  const addedIds = new Set(mine.map((t) => t.id))

  const toggleTopic = async (topic: CatalogTopic) => {
    if (!unlocked) {
      openUpgradeDialog('customSubtopics')
      return
    }
    if (addedIds.has(topic.id)) {
      removeCustomTopic(topic.id)
      setMine(getCustomTopics())
    } else {
      const ok = await addCustomTopic(topic.id, topic.label)
      if (!ok) {
        setCreateMsg({ ok: false, text: 'You can pin up to 12 custom subtopics — remove one first.' })
        return
      }
      setMine(getCustomTopics())
    }
  }

  const createWithAI = async () => {
    const name = query.trim()
    if (!name || name.length < 2 || creating) return
    if (!unlocked) {
      openUpgradeDialog('customSubtopics')
      return
    }
    setCreating(true)
    setCreateMsg(null)
    try {
      const res = await fetch('/api/subtopics/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const data = (await res.json()) as {
        ok?: boolean
        existing?: boolean
        topic?: CatalogTopic
        topics?: number
        error?: string
        needUpgrade?: boolean
        hint?: string
      }
      if (res.status === 402 || data.needUpgrade) {
        openUpgradeDialog('customSubtopics')
        return
      }
      if (!res.ok || !data.topic) {
        setCreateMsg({ ok: false, text: data.error || 'Creation failed — try again.' })
        return
      }
      await addCustomTopic(data.topic.id, data.topic.label)
      setMine(getCustomTopics())
      setQuery('')
      setHits(null)
      setCreateMsg({
        ok: true,
        text: data.existing
          ? `“${data.topic.label}” was already in the catalog — added to your header.`
          : `AI created “${data.topic.label}”${data.topics ? ` with ${data.topics} stories ready` : ''} — added to your header.`,
      })
    } catch {
      setCreateMsg({ ok: false, text: 'Network error — try again.' })
    } finally {
      setCreating(false)
    }
  }

  const groupsToList: Array<[string, CatalogTopic[]]> = Object.entries(browse?.groups || {})

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[75] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Add subtopics"
    >
      <motion.div
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92vh] w-full max-w-xl flex-col rounded-t-2xl border bg-background shadow-2xl sm:rounded-2xl"
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b p-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/15">
            <PremiumDiamond className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold leading-tight">Add subtopics</h2>
            <p className="text-xs text-muted-foreground">
              {browse?.catalogSize
                ? `${browse.catalogSize}+ topics — or let AI create one`
                : 'Search or create any subtopic'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1.5 text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Search */}
        <div className="border-b p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search 550+ subtopics — chess, AI, Mars…"
              className="pl-9"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && hits && hits.length === 0) void createWithAI()
              }}
            />
            {searching ? (
              <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            ) : null}
          </div>
          {/* My topics (removable) */}
          {mine.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {mine.map((t) => (
                <span
                  key={t.id}
                  className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 py-1 pl-2.5 pr-1 text-xs font-medium"
                >
                  {t.label}
                  <button
                    type="button"
                    aria-label={`Remove ${t.label}`}
                    onClick={() => {
                      removeCustomTopic(t.id)
                      setMine(getCustomTopics())
                    }}
                    className="rounded-full p-0.5 hover:bg-amber-500/20"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {/* Create-with-AI row */}
          {query.trim().length >= 2 && hits && hits.length === 0 ? (
            <div className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles className="h-4 w-4 text-amber-500" />
                No “{query.trim()}” yet
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                AI will create it: generate search keywords, check there&apos;s enough real news,
                then add it to your header.
              </p>
              <Button
                size="sm"
                className="mt-2"
                onClick={createWithAI}
                disabled={creating || !unlocked}
              >
                {creating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                Create “{query.trim().slice(0, 24)}” with AI
              </Button>
            </div>
          ) : null}

          {/* Search results */}
          {hits ? (
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {hits.map((t) => (
                <TopicChip
                  key={t.id}
                  topic={t}
                  added={addedIds.has(t.id)}
                  onToggle={() => void toggleTopic(t)}
                />
              ))}
            </div>
          ) : groupsToList.length > 0 ? (
            // Browse mode
            <div className="space-y-4">
              {groupsToList.map(([group, topics]) => (
                <div key={group}>
                  <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                    {group}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                    {topics.map((t) => (
                      <TopicChip
                        key={t.id}
                        topic={t}
                        added={addedIds.has(t.id)}
                        onToggle={() => void toggleTopic(t)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading the catalog…
            </div>
          )}
        </div>

        {/* Messages + footer */}
        {(createMsg || !unlocked) && (
          <div className="border-t p-3">
            {createMsg ? (
              <div
                className={cn(
                  'flex items-start gap-2 rounded-md px-3 py-2 text-xs',
                  createMsg.ok
                    ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                    : 'border border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
                )}
              >
                {createMsg.ok ? (
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                ) : (
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                )}
                {createMsg.text}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => openUpgradeDialog('customSubtopics')}
                className="flex w-full items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-left text-xs"
              >
                <PremiumDiamond className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1">
                  Custom subtopics are Premium — browse is free, adding needs{' '}
                  <b>{sub.pricing.premium.display}/month</b>.
                </span>
              </button>
            )}
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}

function TopicChip({
  topic,
  added,
  onToggle,
}: {
  topic: CatalogTopic
  added: boolean
  onToggle: () => void
}) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.97 }}
      onClick={onToggle}
      aria-pressed={added}
      className={cn(
        'flex items-center justify-between gap-1.5 rounded-lg border px-2.5 py-2 text-left text-[13px] font-medium transition-all',
        added
          ? 'border-amber-500/50 bg-amber-500/10 ring-1 ring-amber-500/30'
          : 'border-border hover:bg-muted/40',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{topic.label}</span>
      {added ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-amber-500" />
      ) : (
        <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
    </motion.button>
  )
}
