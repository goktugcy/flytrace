'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface Result {
  flightId: string;
  callsign: string;
  flightNumber: string | null;
  status: string;
}

export function SearchBox() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 1) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `${API_BASE}/api/v1/flights/search?q=${encodeURIComponent(q.trim())}`,
        );
        const data = ((await res.json()) as { data: { results: Result[] } }).data;
        setResults(data.results);
        setOpen(true);
      } catch {
        setResults([]);
      }
    }, 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q]);

  return (
    <div style={{ position: 'relative', width: 280 }}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        placeholder="Search flight / callsign…"
        style={{
          width: '100%',
          padding: '8px 12px',
          borderRadius: 8,
          border: '1px solid #2a3446',
          background: 'rgba(14,20,32,0.95)',
          color: 'var(--fg)',
          fontSize: 14,
        }}
      />
      {open && results.length > 0 && (
        <ul
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            listStyle: 'none',
            margin: 0,
            padding: 4,
            background: 'rgba(18,24,38,0.98)',
            border: '1px solid #2a3446',
            borderRadius: 8,
            maxHeight: 280,
            overflowY: 'auto',
          }}
        >
          {results.map((r) => (
            <li key={r.flightId}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  router.push(`/flights/id/${r.flightId}`);
                }}
                style={{
                  display: 'flex',
                  width: '100%',
                  gap: 8,
                  padding: '6px 8px',
                  border: 'none',
                  background: 'none',
                  color: 'var(--fg)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ fontWeight: 600 }}>{r.callsign}</span>
                {r.flightNumber && <span style={{ color: 'var(--muted)' }}>{r.flightNumber}</span>}
                <span style={{ color: 'var(--muted)', marginLeft: 'auto' }}>{r.status}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
