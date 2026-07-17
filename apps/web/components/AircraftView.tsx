'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { type CatalogFlight, CatalogFlightList } from './CatalogFlightList';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface Aircraft {
  icao24: string;
  registration: string | null;
  typeIcao: string | null;
  typeName: string | null;
  manufacturer: string | null;
  builtYear: number | null;
  seats: number | null;
  airlineName: string | null;
  airlineIata: string | null;
}

export function AircraftView({ registration }: { registration: string }) {
  const [aircraft, setAircraft] = useState<Aircraft | null>(null);
  const [flights, setFlights] = useState<CatalogFlight[]>([]);
  const [state, setState] = useState<'loading' | 'missing' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/aircraft/${registration}`);
        if (res.status === 404) return void (!cancelled && setState('missing'));
        if (!res.ok) return void (!cancelled && setState('error'));
        const d = ((await res.json()) as { data: { aircraft: Aircraft; flights: CatalogFlight[] } })
          .data;
        if (cancelled) return;
        setAircraft(d.aircraft);
        setFlights(d.flights);
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [registration]);

  return (
    <main style={{ maxWidth: 860, margin: '0 auto', padding: '2rem 1.5rem' }}>
      <p style={{ marginBottom: '1rem' }}>
        <Link href="/map">← Live map</Link>
      </p>

      {state === 'missing' && (
        <p style={{ color: '#ff7b7b' }}>Aircraft {registration.toUpperCase()} not found.</p>
      )}
      {state === 'error' && <p style={{ color: '#ff7b7b' }}>Failed to load aircraft.</p>}
      {state === 'loading' && <p style={{ color: 'var(--muted)' }}>Loading…</p>}

      {state === 'ready' && aircraft && (
        <>
          <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <h1 style={{ fontSize: '2rem', margin: 0 }}>
              {aircraft.registration ?? aircraft.icao24}
            </h1>
            <span style={{ color: 'var(--muted)' }}>
              {aircraft.typeName ?? aircraft.typeIcao ?? 'Unknown type'}
            </span>
          </header>
          {aircraft.airlineName && (
            <p style={{ color: 'var(--muted)', marginTop: 4 }}>{aircraft.airlineName}</p>
          )}

          <section style={panel}>
            <h2 style={h2}>Details</h2>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))',
                gap: 12,
              }}
            >
              <Metric label="ICAO24" value={aircraft.icao24} />
              <Metric label="Type" value={aircraft.typeIcao ?? '—'} />
              <Metric label="Manufacturer" value={aircraft.manufacturer ?? '—'} />
              <Metric
                label="Built"
                value={aircraft.builtYear != null ? String(aircraft.builtYear) : '—'}
              />
              <Metric label="Seats" value={aircraft.seats != null ? String(aircraft.seats) : '—'} />
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
