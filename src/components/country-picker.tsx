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
}

export function CountryPicker({ country, onChange }: CountryPickerProps) {
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
            <span className="text-base">{DEFAULT_COUNTRY.flag}</span>
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
              <span className="text-base">{c.flag}</span>
              <span>{c.name}</span>
              <span className="ml-auto text-[10px] text-muted-foreground">
                {c.code}
              </span>
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
