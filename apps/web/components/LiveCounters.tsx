'use client';

import { useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface Stats {
  flightsLive: number;
  eventsToday: number;
}

export function LiveCounters() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/stats/live`);
        if (res.ok && alive) setStats(((await res.json()) as { data: Stats }).data);
      } catch {
        /* offline / api down — leave placeholders */
      }
    };
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div style={{ display: 'flex', gap: 32, marginTop: '2rem', flexWrap: 'wrap' }}>
      <Counter label="Live aircraft" value={stats?.flightsLive} />
      <Counter label="Events today" value={stats?.eventsToday} />
    </div>
  );
}

function Counter({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div aria-live="polite">
      <div style={{ fontSize: '2.25rem', fontWeight: 700, color: 'var(--accent)' }}>
        {value === undefined ? '—' : value.toLocaleString()}
      </div>
      <div style={{ color: 'var(--muted)', fontSize: 13 }}>{label}</div>
    </div>
  );
}
