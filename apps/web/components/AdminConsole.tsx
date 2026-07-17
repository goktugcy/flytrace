'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface AdminData {
  stats: Record<string, number>;
  queues: {
    name: string;
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }[];
  providers: {
    key: string;
    name: string;
    enabled: boolean;
    health: string;
    circuitState: string;
  }[];
  flights: { flightId: string; callsign: string; status: string; flightDate: string }[];
}

export function AdminConsole() {
  const [data, setData] = useState<AdminData | null>(null);
  const [state, setState] = useState<'loading' | 'unauth' | 'forbidden' | 'ready' | 'error'>(
    'loading',
  );

  useEffect(() => {
    (async () => {
      const get = (p: string) => fetch(`${API_BASE}/api/v1/admin/${p}`, { credentials: 'include' });
      try {
        const first = await get('stats');
        if (first.status === 401) return setState('unauth');
        if (first.status === 403) return setState('forbidden');
        if (!first.ok) return setState('error');
        const [stats, queues, providers, flights] = await Promise.all([
          first.json(),
          get('queues').then((r) => r.json()),
          get('providers').then((r) => r.json()),
          get('flights').then((r) => r.json()),
        ]);
        setData({
          stats: stats.data.stats,
          queues: queues.data.queues,
          providers: providers.data.providers,
          flights: flights.data.flights,
        });
        setState('ready');
      } catch {
        setState('error');
      }
    })();
  }, []);

  if (state === 'unauth')
    return (
      <Shell>
        <p>
          Please <Link href="/signin?next=/admin">sign in</Link>.
        </p>
      </Shell>
    );
  if (state === 'forbidden')
    return (
      <Shell>
        <p style={{ color: '#ff7b7b' }}>Admins only.</p>
      </Shell>
    );
  if (state !== 'ready' || !data)
    return (
      <Shell>
        <p style={{ color: 'var(--muted)' }}>
          {state === 'error' ? 'Failed to load.' : 'Loading…'}
        </p>
      </Shell>
    );

  return (
    <Shell>
      <Section title="Platform">
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          {Object.entries(data.stats).map(([k, v]) => (
            <Stat key={k} label={k} value={v} />
          ))}
        </div>
      </Section>

      <Section title="Queues">
        {data.queues.map((q) => (
          <Row key={q.name}>
            <span style={{ fontWeight: 600 }}>{q.name}</span>
            <span style={{ color: 'var(--muted)', marginLeft: 'auto' }}>
              waiting {q.waiting} · active {q.active} · done {q.completed} · failed {q.failed} ·
              delayed {q.delayed}
            </span>
          </Row>
        ))}
      </Section>

      <Section title="Providers">
        {data.providers.length === 0 ? (
          <Empty>No providers registered.</Empty>
        ) : (
          data.providers.map((p) => (
            <Row key={p.key}>
              <span style={{ fontWeight: 600 }}>{p.name}</span>
              <span style={{ color: 'var(--muted)' }}>{p.enabled ? 'enabled' : 'disabled'}</span>
              <span style={{ marginLeft: 'auto', color: healthColor(p.health) }}>{p.health}</span>
              <span style={{ color: 'var(--muted)' }}>{p.circuitState}</span>
            </Row>
          ))
        )}
      </Section>

      <Section title={`Recent flights (${data.flights.length})`}>
        {data.flights.map((f) => (
          <Row key={f.flightId}>
            <Link href={`/flights/id/${f.flightId}`}>{f.callsign}</Link>
            <span style={{ color: 'var(--muted)' }}>{f.status}</span>
            <span style={{ color: 'var(--muted)', marginLeft: 'auto' }}>{f.flightDate}</span>
          </Row>
        ))}
      </Section>
    </Shell>
  );
}

function healthColor(h: string): string {
  return h === 'up' ? '#2e9e6b' : h === 'degraded' ? '#c9a227' : '#ff7b7b';
}
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: '2rem 1.5rem' }}>
      <h1 style={{ fontSize: '1.75rem', marginBottom: '1rem' }}>Admin</h1>
      {children}
    </main>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        background: 'var(--panel)',
        borderRadius: 12,
        padding: '1rem 1.25rem',
        marginBottom: '1.25rem',
      }}
    >
      <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.75rem' }}>{title}</h2>
      {children}
    </section>
  );
}
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--accent)' }}>
        {value.toLocaleString()}
      </div>
      <div style={{ color: 'var(--muted)', fontSize: 12 }}>{label}</div>
    </div>
  );
}
function Row({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        padding: '6px 0',
        borderBottom: '1px solid #1e2636',
      }}
    >
      {children}
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p style={{ color: 'var(--muted)', margin: 0 }}>{children}</p>;
}
