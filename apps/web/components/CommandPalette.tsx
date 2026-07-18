'use client';

import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Bell, Home, LayoutDashboard, Map as MapIcon, Plane, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface FlightResult {
  flightId: string;
  callsign: string;
  flightNumber: string | null;
  status: string;
}

/** Global ⌘K / Ctrl+K command palette: quick nav + flight search. */
export function CommandPalette() {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [flights, setFlights] = useState<FlightResult[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const NAV = [
    { id: 'map', label: t('nav.map'), icon: MapIcon, href: '/map' },
    { id: 'dashboard', label: t('nav.dashboard'), icon: LayoutDashboard, href: '/dashboard' },
    { id: 'settings', label: t('dash.settings'), icon: Bell, href: '/settings/notifications' },
    { id: 'home', label: 'FlyTrace', icon: Home, href: '/' },
  ];

  const close = useCallback(() => {
    setOpen(false);
    setQ('');
    setFlights([]);
    setActive(0);
  }, []);

  // Global hotkey.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 20);
  }, [open]);

  // Debounced flight search.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const term = q.trim();
    if (term.length < 1) {
      setFlights([]);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/flights/search?q=${encodeURIComponent(term)}`);
        const data = ((await res.json()) as { data: { results: FlightResult[] } }).data;
        setFlights(data.results.slice(0, 6));
        setActive(0);
      } catch {
        setFlights([]);
      }
    }, 220);
  }, [q]);

  const term = q.trim().toLowerCase();
  const navItems = NAV.filter((n) => !term || n.label.toLowerCase().includes(term));
  const items = [
    ...navItems.map((n) => ({ kind: 'nav' as const, ...n })),
    ...flights.map((f) => ({ kind: 'flight' as const, ...f })),
  ];

  const go = (i: number) => {
    const it = items[i];
    if (!it) return;
    close();
    router.push(it.kind === 'nav' ? it.href : `/flights/id/${it.flightId}`);
  };

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') return close();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (items.length ? (a + 1) % items.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (items.length ? (a - 1 + items.length) % items.length : 0));
    } else if (e.key === 'Enter') {
      go(active);
    }
  }

  if (!open) return null;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss; Esc handled on the input
    <div
      className="fixed inset-0 z-60 flex items-start justify-center bg-black/50 p-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={close}
    >
      <div
        // biome-ignore lint/a11y/useSemanticElements: custom (non-native) command palette dialog
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-popover shadow-soft-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('search.placeholder')}
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            ESC
          </kbd>
        </div>

        <ul className="max-h-80 overflow-y-auto p-1.5">
          {items.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">
              {term ? t('search.noMatch', { q: q.trim() }) : t('common.loading')}
            </li>
          ) : (
            items.map((it, i) => (
              <li key={it.kind === 'nav' ? `nav-${it.id}` : it.flightId}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={() => go(i)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm',
                    i === active ? 'bg-accent' : '',
                  )}
                >
                  {it.kind === 'nav' ? (
                    <it.icon className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <Plane className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  {it.kind === 'nav' ? (
                    <span className="font-medium">{it.label}</span>
                  ) : (
                    <>
                      <span className="font-medium">{it.callsign}</span>
                      {it.flightNumber && (
                        <span className="text-muted-foreground">{it.flightNumber}</span>
                      )}
                      <span className="ml-auto text-xs capitalize text-muted-foreground">
                        {it.status}
                      </span>
                    </>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
