'use client';

import { apiBase } from '@/lib/api';

import { Badge } from '@/components/ui/badge';
import { useT } from '@/lib/i18n';
import { type FocusTarget, focusQuery, tryFocus } from '@/lib/map-focus';
import { cn } from '@/lib/utils';
import { Loader2, Plane, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';

const API_BASE = apiBase();

interface Result {
  flightId: string;
  callsign: string;
  flightNumber: string | null;
  status: string;
  icao24: string | null;
  lat: number | null;
  lon: number | null;
}

/** Debounced flight/callsign typeahead with keyboard navigation (↑/↓/Enter/Esc). */
export function SearchBox({ className, autoFocus }: { className?: string; autoFocus?: boolean }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const router = useRouter();
  const t = useT();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listId = useId();

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const term = q.trim();
    if (term.length < 1) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/flights/search?q=${encodeURIComponent(term)}`);
        const data = ((await res.json()) as { data: { results: Result[] } }).data;
        setResults(data.results);
        setActive(0);
        setOpen(true);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q]);

  function go(r: Result) {
    setOpen(false);
    setQ('');
    const target: FocusTarget = {
      flightId: r.flightId,
      icao24: r.icao24,
      callsign: r.callsign,
      lat: r.lat,
      lon: r.lon,
    };
    // Locate + select on the live map instead of opening the detail page.
    if (!tryFocus(target)) router.push(`/map?${focusQuery(target)}`);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') return setOpen(false);
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      const r = results[active];
      if (r) go(r);
    }
  }

  const showList = open && q.trim().length > 0;

  return (
    <div className={cn('relative', className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          // biome-ignore lint/a11y/noAutofocus: opt-in via prop for the mobile search sheet
          autoFocus={autoFocus}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          placeholder={t('search.placeholder')}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          className="h-9 w-full rounded-md border border-input bg-card/60 pl-9 pr-3 text-sm shadow-soft transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none"
        />
        {loading && (
          <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>

      {showList && (
        <ul
          id={listId}
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-soft-lg"
        >
          {results.length === 0 && !loading ? (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t('search.noMatch', { q: q.trim() })}
            </li>
          ) : (
            results.map((r, i) => (
              <li key={r.flightId}>
                <button
                  type="button"
                  // onMouseDown (not onClick) fires before input blur closes the list.
                  onMouseDown={() => go(r)}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                    i === active ? 'bg-accent' : 'hover:bg-accent',
                  )}
                >
                  <Plane className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="font-medium">{r.callsign}</span>
                  {r.flightNumber && (
                    <span className="text-muted-foreground">{r.flightNumber}</span>
                  )}
                  <Badge variant="outline" className="ml-auto capitalize">
                    {r.status}
                  </Badge>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
