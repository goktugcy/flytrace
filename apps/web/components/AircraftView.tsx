'use client';

import { type CatalogFlight, CatalogFlightList } from '@/components/CatalogFlightList';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ArrowLeft, Plane } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

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

interface Stats {
  totalFlights: number;
  activeFlights: number;
  distinctRoutes: number;
  lastSeenAt: string | null;
}

export function AircraftView({ registration }: { registration: string }) {
  const [aircraft, setAircraft] = useState<Aircraft | null>(null);
  const [flights, setFlights] = useState<CatalogFlight[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [state, setState] = useState<'loading' | 'missing' | 'ready' | 'error'>('loading');

  async function load() {
    setState('loading');
    try {
      const res = await fetch(`${API_BASE}/api/v1/aircraft/${registration}`);
      if (res.status === 404) return setState('missing');
      if (!res.ok) return setState('error');
      const d = (
        (await res.json()) as {
          data: { aircraft: Aircraft; flights: CatalogFlight[]; stats: Stats };
        }
      ).data;
      setAircraft(d.aircraft);
      setFlights(d.flights);
      setStats(d.stats);
      setState('ready');
    } catch {
      setState('error');
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch only on registration change
  useEffect(() => {
    void load();
  }, [registration]);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <Link
        href="/map"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Live map
      </Link>

      {state === 'loading' && <AircraftSkeleton />}

      {state === 'missing' && (
        <EmptyState
          icon={Plane}
          title={`${registration.toUpperCase()} not found`}
          description="We don’t have this tail number in the catalog yet."
        />
      )}

      {state === 'error' && <ErrorState onRetry={load} />}

      {state === 'ready' && aircraft && (
        <>
          <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">
              {aircraft.registration ?? aircraft.icao24}
            </h1>
            <span className="text-muted-foreground">
              {aircraft.typeName ?? aircraft.typeIcao ?? 'Unknown type'}
            </span>
          </header>
          {aircraft.airlineName && (
            <p className="mt-1 text-sm text-muted-foreground">{aircraft.airlineName}</p>
          )}

          <div className="mt-6 grid gap-6 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Details</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-x-6 gap-y-5">
                <Metric label="ICAO24" value={aircraft.icao24} />
                <Metric label="Type" value={aircraft.typeIcao ?? '—'} />
                <Metric label="Manufacturer" value={aircraft.manufacturer ?? '—'} />
                <Metric
                  label="Built"
                  value={aircraft.builtYear != null ? String(aircraft.builtYear) : '—'}
                />
                <Metric
                  label="Seats"
                  value={aircraft.seats != null ? String(aircraft.seats) : '—'}
                />
              </CardContent>
            </Card>

            {stats && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Utilization</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-x-6 gap-y-5">
                  <Metric label="Total legs" value={stats.totalFlights.toLocaleString()} />
                  <Metric label="Active now" value={stats.activeFlights.toLocaleString()} />
                  <Metric label="Distinct routes" value={stats.distinctRoutes.toLocaleString()} />
                  <Metric
                    label="Last seen"
                    value={stats.lastSeenAt ? new Date(stats.lastSeenAt).toLocaleDateString() : '—'}
                  />
                </CardContent>
              </Card>
            )}
          </div>

          <Card className="mt-6">
            <CardHeader>
              <CardTitle className="text-base">Recent flights ({flights.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <CatalogFlightList flights={flights} />
            </CardContent>
          </Card>
        </>
      )}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function AircraftSkeleton() {
  return (
    <div>
      <Skeleton className="h-9 w-44" />
      <Skeleton className="mt-2 h-4 w-32" />
      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-24" />
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-5">
              {[0, 1, 2, 3].map((j) => (
                <Skeleton key={j} className="h-10 w-full" />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
