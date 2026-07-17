'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface Airport {
  iata: string | null;
  icao: string;
  name: string;
  city: string | null;
  country: string | null;
  timezone: string | null;
  elevationFt: number | null;
  lat: number | null;
  lon: number | null;
  runways: unknown;
}

interface BoardRow {
  flightId: string;
  callsign: string;
  flightNumber: string | null;
  status: string;
  counterpartIata: string | null;
  counterpartCity: string | null;
  scheduled: string | null;
  estimated: string | null;
  gate: string | null;
  terminal: string | null;
}

interface Stats {
  departures: number;
  arrivals: number;
  active: number;
}

interface AirportData {
  airport: Airport;
  departures: BoardRow[];
  arrivals: BoardRow[];
  stats: Stats;
}

export function AirportView({ iata }: { iata: string }) {
  const [data, setData] = useState<AirportData | null>(null);
  const [state, setState] = useState<'loading' | 'missing' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/airports/${iata}`);
        if (res.status === 404) return void (!cancelled && setState('missing'));
        if (!res.ok) return void (!cancelled && setState('error'));
        const d = ((await res.json()) as { data: AirportData }).data;
        if (cancelled) return;
        setData(d);
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [iata]);

  const runwayCount = Array.isArray(data?.airport.runways) ? data.airport.runways.length : null;

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: '2rem 1.5rem' }}>
      <p style={{ marginBottom: '1rem' }}>
        <Link href="/map">← Live map</Link>
      </p>

      {state === 'missing' && (
        <p style={{ color: '#ff7b7b' }}>Airport {iata.toUpperCase()} not found.</p>
      )}
      {state === 'error' && <p style={{ color: '#ff7b7b' }}>Failed to load airport.</p>}
      {state === 'loading' && <p style={{ color: 'var(--muted)' }}>Loading…</p>}

      {state === 'ready' && data && (
        <>
          <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <h1 style={{ fontSize: '2rem', margin: 0 }}>
              {data.airport.iata ?? data.airport.icao}
            </h1>
            <span style={{ color: 'var(--muted)' }}>{data.airport.name}</span>
          </header>
          <p style={{ color: 'var(--muted)', marginTop: 4 }}>
            {[data.airport.city, data.airport.country].filter(Boolean).join(', ')}
            {data.airport.timezone ? ` · ${data.airport.timezone}` : ''}
          </p>

          <section style={panel}>
            <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
              <Metric label="Departures" value={data.stats.departures.toLocaleString()} />
              <Metric label="Arrivals" value={data.stats.arrivals.toLocaleString()} />
              <Metric label="Active now" value={data.stats.active.toLocaleString()} accent />
              <Metric label="ICAO" value={data.airport.icao} />
              <Metric
                label="Elevation"
                value={
                  data.airport.elevationFt != null
                    ? `${data.airport.elevationFt.toLocaleString()} ft`
                    : '—'
                }
              />
              <Metric label="Runways" value={runwayCount != null ? String(runwayCount) : '—'} />
            </div>
          </section>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))',
              gap: '1.5rem',
              marginTop: '1.5rem',
            }}
          >
            <Board title="Departures" rows={data.departures} dir="departure" />
            <Board title="Arrivals" rows={data.arrivals} dir="arrival" />
          </div>
        </>
      )}
    </main>
  );
}

function Board({
  title,
  rows,
  dir,
}: { title: string; rows: BoardRow[]; dir: 'departure' | 'arrival' }) {
  return (
    <section style={{ ...panel, marginTop: 0 }}>
      <h2 style={h2}>
        {dir === 'departure' ? '🛫' : '🛬'} {title} ({rows.length})
      </h2>
      {rows.length === 0 ? (
        <p style={{ color: 'var(--muted)', margin: 0 }}>No scheduled flights.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {rows.map((r) => (
            <li
              key={r.flightId}
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr auto',
                gap: 10,
                alignItems: 'baseline',
                padding: '8px 0',
                borderBottom: '1px solid #1e2636',
              }}
            >
              <Link href={`/flights/id/${r.flightId}`} style={{ fontWeight: 600 }}>
                {r.flightNumber ?? r.callsign}
              </Link>
              <span style={{ color: 'var(--muted)' }}>
                {r.counterpartIata ?? '—'}
                {r.counterpartCity ? ` · ${r.counterpartCity}` : ''}
                {r.gate ? ` · Gate ${r.gate}` : ''}
              </span>
              <span style={{ textAlign: 'right' }}>
                <span style={{ display: 'block' }}>{fmtTime(r.estimated ?? r.scheduled)}</span>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>{r.status}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 700, color: accent ? 'var(--accent)' : undefined }}>
        {value}
      </div>
      <div style={{ color: 'var(--muted)', fontSize: 12 }}>{label}</div>
    </div>
  );
}

const panel: React.CSSProperties = {
  background: 'var(--panel)',
  borderRadius: 12,
  padding: '1.25rem',
  marginTop: '1.5rem',
};
const h2: React.CSSProperties = { margin: '0 0 1rem', fontSize: '1.1rem' };
