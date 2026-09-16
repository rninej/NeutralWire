'use client'

/**
 * CardContextBar — the bottom "app bar" shown when a user HOLDS a news
 * card (long-press). One row of quick actions on the held story:
 *
 *   [ Share ] [ Open ] [ Like ] [ Dislike ] [ Report a bug ]
 *
 * Report expands into the 7 bug reasons (incorrect photo / title /
 * summary / sources / video, summary missing, other) + an optional note.
 * The report (with the full article snapshot) is POSTed to /api/report
 * and lands in /debug, where "Make AI Fix" lets the AI repair it.
 *
 * Portaled to document.body (no transformed-ancestor trapping), bottom
 * sheet style — matches the app's SourcesPopup / detail-sheet language.
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Share2,
  Check,
  ThumbsUp,
  ThumbsDown,
  ExternalLink,
  Flag,
  X,
  Loader2,
  Send,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { TopicArticle } from '@/lib/news-aggregator'
import { getDeviceId } from '@/lib/referral'
import { bumpEngagementForTopic } from '@/lib/user-interests'

export const REPORT_REASONS: Array<{ type: string; label: string; hint: string }> = [
  { type: 'photo', label: 'Incorrect photo', hint: 'Image doesn’t match the story' },
  { type: 'title', label: 'Incorrect title', hint: 'Headline is wrong or broken' },
  { type: 'summary', label: 'Incorrect summary', hint: 'Summary doesn’t match the story' },
  { type: 'sources', label: 'Incorrect sources', hint: 'Wrong / unrelated articles listed' },
  { type: 'video', label: 'Incorrect video', hint: 'Video doesn’t match the story' },
  { type: 'summary-missing', label: 'Summary missing', hint: 'No neutral summary shown' },
  { type: 'other', label: 'Other', hint: 'Something else — tell us below' },
]

interface CardContextBarProps {
  topic: TopicArticle
  onOpen: (topic: TopicArticle) => void
  onClose: () => void
}

type VoteState = 'liked' | 'disliked' | null

export function CardContextBar({ topic, onOpen, onClose }: CardContextBarProps) {
  const [vote, setVote] = React.useState<VoteState>(null)
  const [shared, setShared] = React.useState(false)
  // 'actions' → main app bar; 'report' → bug reason picker.
  const [stage, setStage] = React.useState<'actions' | 'report'>('actions')
  const [reportType, setReportType] = React.useState<string | null>(null)
  const [reportNote, setReportNote] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const [sent, setSent] = React.useState(false)
  const [error, setError] = React.useState('')

  // Existing vote for this topic (same storage as the article view).
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem(`neutralwire:vote:${topic.topicId}`)
      if (saved === 'liked' || saved === 'disliked') setVote(saved)
    } catch {}
  }, [topic.topicId])

  // Escape closes. (No body scroll lock — this is a quick action bar, and
  // skipping the lock removes the entire stuck-scroll failure class.)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleShare = async () => {
    const shareUrl = `${window.location.origin}/?topic=${topic.topicId}`
    const deviceId = getDeviceId()
    if (deviceId) {
      bumpEngagementForTopic(deviceId, topic.title, topic.summary || '', 'share').catch(() => {})
    }
    try {
      if (navigator.share) {
        await navigator.share({ title: 'NeutralWire', url: shareUrl })
      } else {
        await navigator.clipboard.writeText(shareUrl)
        setShared(true)
        setTimeout(() => setShared(false), 2000)
      }
    } catch {
      // user cancelled the share sheet — silent
    }
  }

  const handleVote = (next: Exclude<VoteState, null>) => {
    const newVote: VoteState = vote === next ? null : next
    setVote(newVote)
    try {
      if (newVote === null) {
        localStorage.removeItem(`neutralwire:vote:${topic.topicId}`)
      } else {
        localStorage.setItem(`neutralwire:vote:${topic.topicId}`, newVote)
      }
    } catch {}
    const deviceId = getDeviceId()
    if (deviceId) {
      fetch('/api/engagement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'topicVote',
          deviceId,
          topicId: topic.topicId,
          vote: newVote,
        }),
      }).catch(() => {})
      if (newVote) {
        bumpEngagementForTopic(
          deviceId,
          topic.title,
          topic.summary || '',
          newVote === 'liked' ? 'like' : 'dislike',
        ).catch(() => {})
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('neutralwire:engagement-changed'))
        }, 300)
      }
    }
  }

  const handleOpen = () => {
    onClose()
    onOpen(topic)
  }

  const handleSendReport = async () => {
    if (!reportType || sending) return
    setSending(true)
    setError('')
    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: reportType,
          note: reportNote.trim(),
          topic,
          deviceId: getDeviceId() || '',
        }),
      })
      if (!res.ok) throw new Error('failed')
      setSent(true)
      // Brief confirmation, then close the bar.
      setTimeout(() => onClose(), 1800)
    } catch {
      setError('Could not send — please try again.')
    } finally {
      setSending(false)
    }
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <motion.div
      className="fixed inset-0 z-[95] flex items-end justify-center bg-black/30 backdrop-blur-[2px] sm:items-center sm:p-6"
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      <motion.div
        className="w-full max-w-2xl overflow-hidden rounded-t-2xl border-t border-border/60 bg-background/95 shadow-2xl backdrop-blur-2xl sm:rounded-2xl sm:border"
        onClick={(e) => e.stopPropagation()}
        initial={{ y: 90, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 90, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 400, damping: 34 }}
        role="dialog"
        aria-modal="true"
        aria-label="Story actions"
      >
        {/* Drag handle (mobile) + header */}
        <div className="sm:hidden flex justify-center pt-2 pb-1">
          <div className="h-1 w-10 rounded-full bg-foreground/20" />
        </div>
        <div className="flex items-center gap-2 px-4 pb-2 pt-1 sm:pt-4">
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {topic.coverage} {topic.coverage === 1 ? 'source' : 'sources'}
          </Badge>
          <h3 className="min-w-0 flex-1 truncate text-sm font-bold">{topic.title}</h3>
          <button
            onClick={onClose}
            className="shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        </div>

        {sent ? (
          <div className="flex items-center gap-2 px-4 pb-6 pt-3 text-sm font-medium text-emerald-600 dark:text-emerald-400">
            <Check className="h-5 w-5" />
            Report sent — thanks for making NeutralWire better.
          </div>
        ) : stage === 'actions' ? (
          /* ── Main app bar: the 5 quick actions ── */
          <div
            className="grid grid-cols-5 gap-1 px-3 pb-4 pt-2 sm:px-4"
            style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
          >
            <BarButton
              label="Share"
              onClick={handleShare}
              active={shared}
              activeClass="text-emerald-500"
              icon={shared ? <Check className="h-5 w-5" /> : <Share2 className="h-5 w-5" />}
            />
            <BarButton
              label="Open"
              onClick={handleOpen}
              icon={<ExternalLink className="h-5 w-5" />}
            />
            <BarButton
              label="Like"
              onClick={() => handleVote('liked')}
              active={vote === 'liked'}
              activeClass="text-emerald-500"
              icon={<ThumbsUp className="h-5 w-5" />}
            />
            <BarButton
              label="Dislike"
              onClick={() => handleVote('disliked')}
              active={vote === 'disliked'}
              activeClass="text-red-500"
              icon={<ThumbsDown className="h-5 w-5" />}
            />
            <BarButton
              label="Report"
              onClick={() => setStage('report')}
              icon={<Flag className="h-5 w-5" />}
            />
          </div>
        ) : (
          /* ── Report stage: the 7 bug reasons + optional note ── */
          <div className="px-4 pb-5 pt-1">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Flag className="h-3.5 w-3.5" />
              What's wrong with this story?
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {REPORT_REASONS.map((r) => (
                <button
                  key={r.type}
                  type="button"
                  onClick={() => setReportType(r.type)}
                  className={cn(
                    'flex items-center gap-2.5 rounded-xl border-2 px-3 py-2.5 text-left transition-colors',
                    reportType === r.type
                      ? 'border-foreground/60 bg-muted/60'
                      : 'border-border/60 hover:bg-muted/40',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2',
                      reportType === r.type ? 'border-foreground bg-foreground' : 'border-muted-foreground/50',
                    )}
                  >
                    {reportType === r.type && (
                      <Check className="h-2.5 w-2.5 text-background" strokeWidth={3.5} />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium leading-tight">{r.label}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {r.hint}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <Input
              value={reportNote}
              onChange={(e) => setReportNote(e.target.value)}
              placeholder="Optional — anything else we should know?"
              maxLength={500}
              className="mt-3"
            />
            {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
            <div className="mt-3 flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setStage('actions')}
                disabled={sending}
              >
                Back
              </Button>
              <Button
                size="sm"
                className="flex-1"
                disabled={!reportType || sending}
                onClick={handleSendReport}
              >
                {sending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Sending…
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4" />
                    Send report
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>,
    document.body,
  )
}

/** One big square-ish action button in the app bar row. */
function BarButton({
  label,
  icon,
  onClick,
  active,
  activeClass,
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
  active?: boolean
  activeClass?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex select-none flex-col items-center gap-1 rounded-xl px-1 py-2.5 transition-all active:scale-95',
        'text-foreground/80 hover:bg-muted/60 hover:text-foreground',
        active && activeClass,
      )}
      style={{ touchAction: 'manipulation', WebkitUserSelect: 'none' } as React.CSSProperties}
      aria-label={label}
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-muted/70">
        {icon}
      </span>
      <span className="text-[11px] font-medium leading-none">{label}</span>
    </button>
  )
}
