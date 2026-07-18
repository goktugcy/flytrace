'use client';

import { Skeleton } from '@/components/ui/skeleton';
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
        /* offline / api down — leave the loading skeleton in place */
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
    <dl className="mt-8 flex flex-wrap gap-x-10 gap-y-6">
      <Counter label="Live aircraft" value={stats?.flightsLive} />
      <Counter label="Events today" value={stats?.eventsToday} />
    </dl>
  );
}

function Counter({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div aria-live="polite">
      {value === undefined ? (
        <Skeleton className="h-9 w-20" />
      ) : (
        <dd className="text-3xl font-semibold tabular-nums tracking-tight text-foreground sm:text-4xl">
          {value.toLocaleString()}
        </dd>
      )}
      <dt className="mt-1 text-sm text-muted-foreground">{label}</dt>
    </div>
  );
}
