'use client'

import * as React from 'react'
import { MapPin, Check, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  SELECTABLE_COUNTRIES,
  DEFAULT_COUNTRY,
  type CountryInfo,
} from '@/lib/country-detect'

interface CountryPickerProps {
  country: CountryInfo | null
  onChange: (country: CountryInfo) => void
  /** When true, renders as a compact borderless sub-button (for use
   *  inside a combined button group). No outline, no MapPin icon,
   *  just the code. */
  compact?: boolean
}

/** Display code for a country — users in the UK expect "UK" even though
 *  the ISO code is "GB" (display-only; the API still uses "GB"). */
function displayCode(code: string): string {
  if (code === 'GB') return 'UK'
  return code.toUpperCase()
}

/** Small initials badge shown instead of a flag emoji in list rows.
 *  Monospace-ish tracking + muted background keeps it readable at 10px. */
function CodeBadge({ code, wide = false }: { code: string; wide?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center justify-center rounded bg-muted font-semibold tracking-wider text-foreground/80',
        wide ? 'min-w-9 px-1.5 text-[10px]' : 'min-w-8 text-[10px]',
      )}
    >
      {displayCode(code)}
    </span>
  )
}

export function CountryPicker({ country, onChange, compact = false }: CountryPickerProps) {
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState('')

  const current = country || DEFAULT_COUNTRY

  const filtered = React.useMemo(() => {
    if (!search.trim()) return SELECTABLE_COUNTRIES
    const q = search.toLowerCase()
    return SELECTABLE_COUNTRIES.filter(
      (c) =>
        c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q),
    )
  }, [search])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {compact ? (
          /* Compact mode: borderless sub-button for use inside a combined
             button group. Shows just the country initials, no border/icons. */
          <button
            type="button"
            className="flex items-center gap-1 px-2.5 py-1.5 hover:bg-muted transition-colors active:scale-95 text-xs font-medium"
            title={`Detected: ${current.name}. Click to change.`}
          >
            <span className="font-semibold tracking-wide">{displayCode(current.code)}</span>
          </button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-[11px] font-normal"
            title={`Detected: ${current.name}. Click to change.`}
          >
            <MapPin className="h-3 w-3" />
            <span className="font-semibold">{current.code}</span>
            <ChevronDown className="h-3 w-3 opacity-60" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <div className="border-b p-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search country…"
            className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
            autoFocus
          />
        </div>
        <div className="max-h-72 overflow-y-auto">
          <button
            type="button"
            onClick={() => {
              onChange(DEFAULT_COUNTRY)
              setOpen(false)
            }}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted',
              current.code === 'INT' && 'bg-muted',
            )}
          >
            <CodeBadge code={DEFAULT_COUNTRY.code} wide />
            <span>{DEFAULT_COUNTRY.name}</span>
            {current.code === 'INT' && (
              <Check className="ml-auto h-3 w-3" />
            )}
          </button>
          {filtered.map((c) => (
            <button
              key={c.code}
              type="button"
              onClick={() => {
                onChange(c)
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted',
                current.code === c.code && 'bg-muted',
              )}
            >
              <CodeBadge code={c.code} wide />
              <span>{c.name}</span>
              {current.code === c.code && (
                <Check className="h-3 w-3" />
              )}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              No countries match “{search}”
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
