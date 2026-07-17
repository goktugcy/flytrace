'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface Dashboard {
  watchlist: { id: string; flightId: string | null; eventTypes: string[]; channels: string[] }[];
  notifications: { id: string; title: string; body: string; status: string; createdAt: string }[];
  favorites: { id: string; kind: string; ref: unknown }[];
  channels: { id: string; channel: string; verified: boolean; enabled: boolean; label: string }[];
}

export function DashboardView() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [state, setState] = useState<'loading' | 'unauth' | 'ready' | 'error'>('loading');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/dashboard`, { credentials: 'include' });
        if (res.status === 401) return setState('unauth');
        if (!res.ok) return setState('error');
        setData(((await res.json()) as { data: Dashboard }).data);
        setState('ready');
      } catch {
        setState('error');
      }
    })();
  }, []);

  if (state === 'loading')
    return (
      <Shell>
        <p style={{ color: 'var(--muted)' }}>Loading…</p>
      </Shell>
    );
  if (state === 'unauth')
    return (
      <Shell>
        <p>
          Please <Link href="/signin?next=/dashboard">sign in</Link> to see your dashboard.
        </p>
      </Shell>
    );
  if (state === 'error' || !data)
    return (
      <Shell>
        <p style={{ color: '#ff7b7b' }}>Failed to load.</p>
      </Shell>
    );

  return (
    <Shell>
      <div style={{ display: 'flex', gap: 12, marginBottom: '1.5rem' }}>
        <Link href="/map">Live map</Link>
        <Link href="/settings/notifications">Notification settings</Link>
      </div>

      <Section title={`Watching (${data.watchlist.length})`}>
        {data.watchlist.length === 0 ? (
          <Empty>No watched flights. Open a flight and tap Watch.</Empty>
        ) : (
          data.watchlist.map((w) => (
            <Row key={w.id}>
              {w.flightId ? (
                <Link href={`/flights/id/${w.flightId}`}>{w.flightId.slice(0, 8)}</Link>
              ) : (
                <span>matcher</span>
              )}
              <span style={{ color: 'var(--muted)', marginLeft: 'auto' }}>
                {w.eventTypes.join(', ')}
              </span>
              <span style={{ color: 'var(--muted)' }}>{w.channels.join(', ')}</span>
            </Row>
          ))
        )}
      </Section>

      <Section title="Recent notifications">
        {data.notifications.length === 0 ? (
          <Empty>No notifications yet.</Empty>
        ) : (
          data.notifications.map((n) => (
            <Row key={n.id}>
              <span style={{ fontWeight: 600 }}>{n.title}</span>
              <span style={{ color: 'var(--muted)' }}>{n.body}</span>
              <span style={{ marginLeft: 'auto', color: statusColor(n.status) }}>{n.status}</span>
            </Row>
          ))
        )}
      </Section>

      <Section title="Channels">
        {data.channels.length === 0 ? (
          <Empty>No channels connected.</Empty>
        ) : (
          data.channels.map((ch) => (
            <Row key={ch.id}>
              <span style={{ fontWeight: 600 }}>{ch.channel}</span>
              <span style={{ color: 'var(--muted)' }}>{ch.label}</span>
              <span style={{ marginLeft: 'auto', color: ch.verified ? '#2e9e6b' : '#c9a227' }}>
                {ch.verified ? 'verified' : 'pending'}
              </span>
            </Row>
          ))
        )}
      </Section>

      <Section title={`Favorites (${data.favorites.length})`}>
        {data.favorites.length === 0 ? (
          <Empty>No favorites.</Empty>
        ) : (
          data.favorites.map((f) => (
            <Row key={f.id}>
              <span>{f.kind}</span>
              <span style={{ color: 'var(--muted)', marginLeft: 'auto' }}>
                {JSON.stringify(f.ref)}
              </span>
            </Row>
          ))
        )}
      </Section>
    </Shell>
  );
}

function statusColor(s: string): string {
  if (s === 'sent' || s === 'delivered') return '#2e9e6b';
  if (s === 'failed') return '#ff7b7b';
  if (s === 'suppressed') return '#8b97ab';
  return 'var(--muted)';
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ maxWidth: 820, margin: '0 auto', padding: '2rem 1.5rem' }}>
      <h1 style={{ fontSize: '1.75rem', marginBottom: '1rem' }}>Dashboard</h1>
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
