'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { type CatalogFlight, CatalogFlightList } from './CatalogFlightList';

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
}

export function AirportView({ iata }: { iata: string }) {
  const [airport, setAirport] = useState<Airport | null>(null);
  const [flights, setFlights] = useState<CatalogFlight[]>([]);
  const [state, setState] = useState<'loading' | 'missing' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/airports/${iata}`);
        if (res.status === 404) return void (!cancelled && setState('missing'));
        if (!res.ok) return void (!cancelled && setState('error'));
        const d = ((await res.json()) as { data: { airport: Airport; flights: CatalogFlight[] } })
          .data;
        if (cancelled) return;
        setAirport(d.airport);
        setFlights(d.flights);
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [iata]);

  return (
    <main style={{ maxWidth: 860, margin: '0 auto', padding: '2rem 1.5rem' }}>
      <p style={{ marginBottom: '1rem' }}>
        <Link href="/map">← Live map</Link>
      </p>

      {state === 'missing' && (
        <p style={{ color: '#ff7b7b' }}>Airport {iata.toUpperCase()} not found.</p>
      )}
      {state === 'error' && <p style={{ color: '#ff7b7b' }}>Failed to load airport.</p>}
      {state === 'loading' && <p style={{ color: 'var(--muted)' }}>Loading…</p>}

      {state === 'ready' && airport && (
        <>
          <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <h1 style={{ fontSize: '2rem', margin: 0 }}>{airport.iata ?? airport.icao}</h1>
            <span style={{ color: 'var(--muted)' }}>{airport.name}</span>
          </header>
          <p style={{ color: 'var(--muted)', marginTop: 4 }}>
            {[airport.city, airport.country].filter(Boolean).join(', ')}
            {airport.timezone ? ` · ${airport.timezone}` : ''}
          </p>

          <section style={panel}>
            <h2 style={h2}>Details</h2>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))',
                gap: 12,
              }}
            >
              <Metric label="ICAO" value={airport.icao} />
              <Metric label="IATA" value={airport.iata ?? '—'} />
              <Metric
                label="Elevation"
                value={
                  airport.elevationFt != null ? `${airport.elevationFt.toLocaleString()} ft` : '—'
                }
              />
              <Metric
                label="Position"
                value={
                  airport.lat != null && airport.lon != null
                    ? `${airport.lat.toFixed(2)}, ${airport.lon.toFixed(2)}`
                    : '—'
                }
              />
            </div>
          </section>

          <section style={panel}>
            <h2 style={h2}>Recent flights ({flights.length})</h2>
            <CatalogFlightList flights={flights} />
          </section>
        </>
      )}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ color: 'var(--muted)', fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
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
