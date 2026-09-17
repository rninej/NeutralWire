'use client'

import * as React from 'react'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  Lock,
  RefreshCw,
  Rocket,
  FileCode2,
  FileText,
  FileCog,
  Terminal,
  ClipboardList,
  Activity,
  X,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DISCOVER_PLAN,
  DISCOVER_STEPS,
  DISCOVER_TASKS,
  DISCOVER_AUTO_DONE,
  DISCOVER_TOTAL_TASKS,
  DISCOVER_PROGRESS_KEY,
  type DiscoverStep,
} from '@/lib/discover-plan'
import {
  DISCOVER_RESOURCES,
  type DiscoverResource,
} from '@/lib/discover-resources'
import { cn } from '@/lib/utils'

/**
 * ── The Google Discover Kit (mobile-first console) ──
 *
 * Mounted at /debug/discover. Three tabs, sized for one-handed phone use:
 *   Plan       — the 10-step programme (phases → collapsible steps →
 *                per-task checklist, progress persisted per device)
 *   Resources  — every drop-in file, with copy + download
 *   Readiness  — LIVE checks against the running site (routes, gate,
 *                story page structured data) — the "is it actually
 *                deployed?" answer, not a self-report
 *
 * The Kit is intentionally NOT password-gated (unlike the analytics
 * dashboard): it contains public SEO guidance and public-route checks
 * only. The entry card lives inside /debug.
 */

// ── Task progress (localStorage, per device) ──────────────────────────

type Progress = Record<string, boolean>

function readProgress(): Progress {
  try {
    const raw = localStorage.getItem(DISCOVER_PROGRESS_KEY)
    return raw ? (JSON.parse(raw) as Progress) : {}
  } catch {
    return {}
  }
}

function writeProgress(p: Progress) {
  try {
    localStorage.setItem(DISCOVER_PROGRESS_KEY, JSON.stringify(p))
  } catch {
    /* private mode etc. — checklist just won't persist */
  }
}

// ── Small shared pieces ───────────────────────────────────────────────

function StatusBadge({ status }: { status: DiscoverStep['status'] }) {
  if (status === 'live')
    return (
      <Badge className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10">
        <Rocket className="h-3 w-3" /> live
      </Badge>
    )
  if (status === 'done')
    return (
      <Badge className="gap-1 border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400 hover:bg-sky-500/10">
        <Check className="h-3 w-3" /> already done
      </Badge>
    )
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      your move
    </Badge>
  )
}

function CodeBlock({ label, body }: { label: string; body: string }) {
  const [copied, setCopied] = React.useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {}
  }
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/60 px-3 py-1.5">
        <span className="truncate text-[11px] font-medium text-muted-foreground">{label}</span>
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[11px]" onClick={copy}>
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="max-h-64 overflow-auto bg-muted/30 p-3 text-[11px] leading-relaxed">
        <code className="font-mono">{body}</code>
      </pre>
    </div>
  )
}

// ── Plan tab ──────────────────────────────────────────────────────────

function StepCard({
  step,
  isTaskDone,
  onToggleTask,
}: {
  step: DiscoverStep
  isTaskDone: (id: string, auto?: boolean) => boolean
  onToggleTask: (id: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const stepDone = step.tasks.every((t) => isTaskDone(t.id, t.auto))

  return (
    <Card className={cn('overflow-hidden', stepDone && 'border-emerald-500/30')}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-muted/40 active:bg-muted/60"
        aria-expanded={open}
      >
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-bold',
            stepDone
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : 'border-border bg-muted/50 text-muted-foreground',
          )}
        >
          {stepDone ? <Check className="h-4 w-4" /> : step.n}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold leading-snug">{step.title}</span>
          <span className="mt-1 block">
            <StatusBadge status={step.status} />
          </span>
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="border-t border-border px-4 pb-4 pt-3">
          <p className="text-[13px] leading-relaxed text-muted-foreground">{step.why}</p>

          {step.how.length > 0 && (
            <ul className="mt-3 space-y-2">
              {step.how.map((h, i) => (
                <li key={i} className="flex gap-2 text-[13px] leading-relaxed">
                  <span className="mt-0.5 shrink-0 text-primary">›</span>
                  <span>{h}</span>
                </li>
              ))}
            </ul>
          )}

          {step.tasks.length > 0 && (
            <div className="mt-4 space-y-1.5">
              {step.tasks.map((t) => {
                const done = isTaskDone(t.id, t.auto)
                return (
                  <button
                    key={t.id}
                    type="button"
                    disabled={t.auto}
                    onClick={() => onToggleTask(t.id)}
                    className={cn(
                      'flex w-full items-start gap-3 rounded-lg border p-3 text-left text-[13px] transition-colors',
                      done
                        ? 'border-emerald-500/30 bg-emerald-500/5'
                        : 'border-border hover:bg-muted/40 active:bg-muted/60',
                      t.auto && 'cursor-default',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border',
                        done
                          ? 'border-emerald-500 bg-emerald-500 text-white'
                          : 'border-border',
                      )}
                    >
                      {done && (t.auto ? <Lock className="h-3 w-3" /> : <Check className="h-3 w-3" />)}
                    </span>
                    <span className={cn(done && 'text-muted-foreground line-through')}>{t.label}</span>
                  </button>
                )
              })}
            </div>
          )}

          {step.code && <CodeBlock label={step.code.label} body={step.code.body} />}

          {step.tools && step.tools.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {step.tools.map((tool) => (
                <a
                  key={tool.href}
                  href={tool.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted/60"
                >
                  {tool.label}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

// ── Resources tab ─────────────────────────────────────────────────────

const CATEGORY_META: Record<
  DiscoverResource['category'],
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  code: { label: 'Code', icon: FileCode2 },
  config: { label: 'Config', icon: FileCog },
  doc: { label: 'Guide', icon: FileText },
  script: { label: 'Script', icon: Terminal },
}

function ResourceCard({ r }: { r: DiscoverResource }) {
  const [open, setOpen] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const meta = CATEGORY_META[r.category]
  const Icon = meta.icon

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(r.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {}
  }

  const download = () => {
    const blob = new Blob([r.content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = r.filename
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-muted/40 active:bg-muted/60"
        aria-expanded={open}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/60">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold leading-snug">{r.title}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {r.filename}
          </span>
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="border-t border-border px-4 pb-4 pt-3">
          <p className="text-[13px] leading-relaxed text-muted-foreground">{r.description}</p>
          {r.repoPath && (
            <p className="mt-2 font-mono text-[11px] text-muted-foreground/80">{r.repoPath}</p>
          )}

          <CodeBlock label={`${r.filename} · ${r.language}`} body={r.content} />

          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={copy}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy file'}
            </Button>
            <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={download}>
              <Download className="h-3.5 w-3.5" />
              Download
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

// ── Readiness tab ─────────────────────────────────────────────────────

interface CheckResult {
  id: string
  label: string
  status: 'pending' | 'running' | 'pass' | 'fail'
  detail: string
}

const INITIAL_CHECKS: CheckResult[] = [
  { id: 'gate', label: 'max-image-preview:large on the homepage', status: 'pending', detail: 'not run' },
  { id: 'robots', label: 'robots.txt lists both sitemaps', status: 'pending', detail: 'not run' },
  { id: 'sitemap', label: '/sitemap.xml responds', status: 'pending', detail: 'not run' },
  { id: 'news', label: '/news-sitemap.xml lists fresh stories', status: 'pending', detail: 'not run' },
  { id: 'feed', label: '/feed.xml is valid RSS with items', status: 'pending', detail: 'not run' },
  { id: 'story', label: 'A live story page has NewsArticle JSON-LD', status: 'pending', detail: 'not run' },
]

async function runDiscoverChecks(): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  const text = async (url: string) => (await fetch(url, { cache: 'no-store' })).text()

  // 1. The Discover gate in the served HTML
  try {
    const html = await text('/')
    const has = html.includes('max-image-preview:large')
    out.push({
      id: 'gate',
      label: INITIAL_CHECKS[0].label,
      status: has ? 'pass' : 'fail',
      detail: has
        ? 'robots meta gate is live — Discover may use large images'
        : 'gate missing from served HTML — redeploy / clear cache',
    })
  } catch (e) {
    out.push({ id: 'gate', label: INITIAL_CHECKS[0].label, status: 'fail', detail: String(e) })
  }

  // 2. robots.txt sitemap references
  try {
    const robots = await text('/robots.txt')
    const hasBoth =
      robots.includes('Sitemap: https://neutralwire.org/sitemap.xml') &&
      robots.includes('Sitemap: https://neutralwire.org/news-sitemap.xml')
    out.push({
      id: 'robots',
      label: INITIAL_CHECKS[1].label,
      status: hasBoth ? 'pass' : 'fail',
      detail: hasBoth ? 'both sitemap declarations present' : 'sitemap lines missing',
    })
  } catch (e) {
    out.push({ id: 'robots', label: INITIAL_CHECKS[1].label, status: 'fail', detail: String(e) })
  }

  // 3. Static sitemap
  try {
    const xml = await text('/sitemap.xml')
    const ok = xml.includes('<urlset')
    out.push({
      id: 'sitemap',
      label: INITIAL_CHECKS[2].label,
      status: ok ? 'pass' : 'fail',
      detail: ok ? `${(xml.match(/<url>/g) || []).length} URLs listed` : 'not a sitemap',
    })
  } catch (e) {
    out.push({ id: 'sitemap', label: INITIAL_CHECKS[2].label, status: 'fail', detail: String(e) })
  }

  // 4. News sitemap with fresh stories
  try {
    const xml = await text('/news-sitemap.xml')
    const stories = (xml.match(/\/story\//g) || []).length
    const news = xml.includes('news:news')
    out.push({
      id: 'news',
      label: INITIAL_CHECKS[3].label,
      status: news && stories > 0 ? 'pass' : 'fail',
      detail:
        stories > 0
          ? `${stories} fresh story URL${stories === 1 ? '' : 's'} (48h window)`
          : news
            ? 'valid XML but 0 fresh stories — check the cron refresh'
            : 'not a news sitemap',
    })
  } catch (e) {
    out.push({ id: 'news', label: INITIAL_CHECKS[3].label, status: 'fail', detail: String(e) })
  }

  // 5. RSS feed
  try {
    const xml = await text('/feed.xml')
    const items = (xml.match(/<item>/g) || []).length
    const rss = xml.includes('<rss')
    out.push({
      id: 'feed',
      label: INITIAL_CHECKS[4].label,
      status: rss && items > 0 ? 'pass' : 'fail',
      detail: rss ? `${items} item${items === 1 ? '' : 's'} — Publisher Center ready` : 'not RSS 2.0',
    })
  } catch (e) {
    out.push({ id: 'feed', label: INITIAL_CHECKS[4].label, status: 'fail', detail: String(e) })
  }

  // 6. Deep check: real story page → NewsArticle JSON-LD
  try {
    const res = await fetch('/api/news?category=top&limit=5&slim=1', { cache: 'no-store' })
    const data = (await res.json()) as { topics?: Array<{ topicId?: string }> }
    const topicId = data?.topics?.find((t) => t?.topicId)?.topicId
    if (!topicId) throw new Error('no stories in the top feed')
    const storyHtml = await text(`/story/${encodeURIComponent(topicId)}`)
    const hasLd = storyHtml.includes('NewsArticle')
    const hasCanonical = storyHtml.includes('rel="canonical"')
    out.push({
      id: 'story',
      label: INITIAL_CHECKS[5].label,
      status: hasLd ? 'pass' : 'fail',
      detail: hasLd
        ? `/story/${topicId.slice(0, 18)}… — structured data${hasCanonical ? ' + canonical' : ''} ok`
        : 'story page rendered without JSON-LD',
    })
  } catch (e) {
    out.push({ id: 'story', label: INITIAL_CHECKS[5].label, status: 'fail', detail: String(e) })
  }

  return out
}

function ReadinessTab() {
  const [checks, setChecks] = React.useState<CheckResult[]>(INITIAL_CHECKS)
  const [running, setRunning] = React.useState(false)
  const [ranAt, setRanAt] = React.useState<string>('')
  const startedRef = React.useRef(false)

  const run = React.useCallback(async () => {
    setRunning(true)
    setChecks((cs) => cs.map((c) => ({ ...c, status: 'running', detail: '' })))
    try {
      const results = await runDiscoverChecks()
      setChecks(results)
      setRanAt(new Date().toLocaleTimeString())
    } finally {
      setRunning(false)
    }
  }, [])

  React.useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void run()
  }, [run])

  const passCount = checks.filter((c) => c.status === 'pass').length

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">Live site audit</div>
            <div className="text-xs text-muted-foreground">
              {ranAt ? `run at ${ranAt} · ${passCount}/${checks.length} passing` : 'checking the running site…'}
            </div>
          </div>
          <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={run} disabled={running}>
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Re-run
          </Button>
        </div>
      </Card>

      {checks.map((c) => (
        <Card key={c.id} className="flex items-start gap-3 p-4">
          <span
            className={cn(
              'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
              c.status === 'pass' && 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
              c.status === 'fail' && 'bg-red-500/15 text-red-600 dark:text-red-400',
              c.status === 'running' && 'bg-muted text-muted-foreground',
              c.status === 'pending' && 'bg-muted text-muted-foreground',
            )}
          >
            {c.status === 'pass' && <Check className="h-4 w-4" />}
            {c.status === 'fail' && <X className="h-4 w-4" />}
            {c.status === 'running' && <Loader2 className="h-4 w-4 animate-spin" />}
            {c.status === 'pending' && <Activity className="h-4 w-4" />}
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium leading-snug">{c.label}</div>
            <div className="mt-0.5 break-words text-xs text-muted-foreground">{c.detail}</div>
          </div>
        </Card>
      ))}
    </div>
  )
}

// ── The Kit ───────────────────────────────────────────────────────────

export function DiscoverKit() {
  const [progress, setProgress] = React.useState<Progress>({})
  const hydrated = React.useRef(false)

  React.useEffect(() => {
    setProgress(readProgress())
    hydrated.current = true
  }, [])

  const isTaskDone = React.useCallback(
    (id: string, auto?: boolean) => Boolean(auto || progress[id]),
    [progress],
  )

  const toggleTask = React.useCallback((id: string) => {
    setProgress((prev) => {
      const next = { ...prev, [id]: !prev[id] }
      if (hydrated.current) writeProgress(next)
      return next
    })
  }, [])

  const doneCount = DISCOVER_TASKS.filter((t) => isTaskDone(t.id, t.auto)).length
  const pct = Math.round((doneCount / DISCOVER_TOTAL_TASKS) * 100)

  return (
    <div className="min-h-screen bg-background pb-20">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto max-w-2xl px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <a
              href="/debug"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Debug
            </a>
            <span className="text-xs text-muted-foreground">
              {doneCount}/{DISCOVER_TOTAL_TASKS} tasks · {DISCOVER_AUTO_DONE} shipped
            </span>
          </div>
          <h1 className="mt-1 flex items-center gap-2 text-lg font-bold tracking-tight">
            <Rocket className="h-5 w-5 text-primary" />
            Google Discover Kit
          </h1>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-gradient-to-r from-blue-500 via-zinc-400 to-red-500 transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-2xl px-4">
        <Tabs defaultValue="plan" className="gap-0">
          <TabsList className="sticky top-[104px] z-10 grid h-10 w-full grid-cols-3">
            <TabsTrigger value="plan" className="gap-1.5">
              <ClipboardList className="h-3.5 w-3.5" />
              Plan
            </TabsTrigger>
            <TabsTrigger value="resources" className="gap-1.5">
              <FileCode2 className="h-3.5 w-3.5" />
              Resources
            </TabsTrigger>
            <TabsTrigger value="readiness" className="gap-1.5">
              <Activity className="h-3.5 w-3.5" />
              Readiness
            </TabsTrigger>
          </TabsList>

          {/* ── PLAN ── */}
          <TabsContent value="plan" className="mt-4 space-y-6">
            {DISCOVER_PLAN.map((phase) => (
              <section key={phase.id}>
                <div className="mb-2 px-1">
                  <h2 className="text-sm font-bold">{phase.title}</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">{phase.subtitle}</p>
                </div>
                <div className="space-y-2.5">
                  {phase.steps.map((step) => (
                    <StepCard
                      key={step.id}
                      step={step}
                      isTaskDone={isTaskDone}
                      onToggleTask={toggleTask}
                    />
                  ))}
                </div>
              </section>
            ))}
            <p className="px-1 pb-4 text-xs text-muted-foreground">
              {DISCOVER_STEPS.length} steps · progress saved on this device. Steps marked{' '}
              <span className="font-medium text-emerald-600 dark:text-emerald-400">live</span> shipped with
              the Discover-kit deploy — their tasks are verification, not building.
            </p>
          </TabsContent>

          {/* ── RESOURCES ── */}
          <TabsContent value="resources" className="mt-4 space-y-2.5">
            <p className="px-1 pb-1 text-xs text-muted-foreground">
              {DISCOVER_RESOURCES.length} drop-in files — every code snippet, config and guide the plan
              needs. Tap to expand, then copy or download.
            </p>
            {DISCOVER_RESOURCES.map((r) => (
              <ResourceCard key={r.id} r={r} />
            ))}
          </TabsContent>

          {/* ── READINESS ── */}
          <TabsContent value="readiness" className="mt-4">
            <ReadinessTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
