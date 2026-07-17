'use client';

import Link from 'next/link';

export interface CatalogFlight {
  flightId: string;
  callsign: string;
  flightNumber: string | null;
  status: string;
  flightDate: string;
  role?: 'departure' | 'arrival';
}

/** Shared compact flight list used by the airport & aircraft pages. */
export function CatalogFlightList({ flights }: { flights: CatalogFlight[] }) {
  if (flights.length === 0)
    return <p style={{ color: 'var(--muted)', margin: 0 }}>No recent flights.</p>;

  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {flights.map((f) => (
        <li
          key={f.flightId}
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            padding: '8px 0',
            borderBottom: '1px solid #1e2636',
          }}
        >
          <Link href={`/flights/id/${f.flightId}`} style={{ fontWeight: 600 }}>
            {f.callsign}
          </Link>
          {f.flightNumber && <span style={{ color: 'var(--muted)' }}>{f.flightNumber}</span>}
          {f.role && (
            <span
              style={{
                fontSize: 12,
                padding: '1px 8px',
                borderRadius: 999,
                background: '#1e2636',
                color: 'var(--muted)',
              }}
            >
              {f.role}
            </span>
          )}
          <span style={{ marginLeft: 'auto', color: 'var(--muted)' }}>{f.status}</span>
          <span style={{ color: 'var(--muted)', fontSize: 13 }}>{f.flightDate}</span>
        </li>
      ))}
    </ul>
  );
}
