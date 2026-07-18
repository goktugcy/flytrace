'use client';

import { apiBase } from '@/lib/api';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ArrowLeft, PlaneLanding, PlaneTakeoff, TowerControl } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

const API_BASE = apiBase();

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

  async function load() {
    setState('loading');
    try {
      const res = await fetch(`${API_BASE}/api/v1/airports/${iata}`);
      if (res.status === 404) return setState('missing');
      if (!res.ok) return setState('error');
      setData(((await res.json()) as { data: AirportData }).data);
      setState('ready');
    } catch {
      setState('error');
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch only on iata change
  useEffect(() => {
    void load();
  }, [iata]);

  const runwayCount = Array.isArray(data?.airport.runways) ? data.airport.runways.length : null;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <Link
        href="/map"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Live map
      </Link>

      {state === 'loading' && <AirportSkeleton />}

      {state === 'missing' && (
        <EmptyState
          icon={TowerControl}
          title={`${iata.toUpperCase()} not found`}
          description="We don’t have this airport in the catalog yet."
        />
      )}

      {state === 'error' && <ErrorState onRetry={load} />}

      {state === 'ready' && data && (
        <>
          <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">
              {data.airport.iata ?? data.airport.icao}
            </h1>
            <span className="text-muted-foreground">{data.airport.name}</span>
          </header>
          <p className="mt-1 text-sm text-muted-foreground">
            {[data.airport.city, data.airport.country].filter(Boolean).join(', ')}
            {data.airport.timezone ? ` · ${data.airport.timezone}` : ''}
          </p>

          <Card className="mt-6">
            <CardContent className="flex flex-wrap gap-x-10 gap-y-5 p-6">
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
            </CardContent>
          </Card>

          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <Board title="Departures" dir="departure" rows={data.departures} />
            <Board title="Arrivals" dir="arrival" rows={data.arrivals} />
          </div>
        </>
      )}
    </main>
  );
}

function Board({
  title,
  dir,
  rows,
}: {
  title: string;
  dir: 'departure' | 'arrival';
  rows: BoardRow[];
}) {
  const Icon = dir === 'departure' ? PlaneTakeoff : PlaneLanding;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="size-4 text-muted-foreground" />
          {title}
          <Badge variant="outline" className="ml-auto tabular-nums">
            {rows.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">No scheduled flights.</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li
                key={r.flightId}
                className="grid grid-cols-[auto_1fr_auto] items-baseline gap-3 py-3 first:pt-0 last:pb-0"
              >
                <Link
                  href={`/flights/id/${r.flightId}`}
                  className="font-medium text-accent-bright hover:underline"
                >
                  {r.flightNumber ?? r.callsign}
                </Link>
                <span className="truncate text-sm text-muted-foreground">
                  {r.counterpartIata ?? '—'}
                  {r.counterpartCity ? ` · ${r.counterpartCity}` : ''}
                  {r.gate ? ` · Gate ${r.gate}` : ''}
                </span>
                <span className="text-right">
                  <span className="block tabular-nums">{fmtTime(r.estimated ?? r.scheduled)}</span>
                  <span className="text-xs capitalize text-muted-foreground">{r.status}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
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
      <div className={`text-xl font-semibold tabular-nums ${accent ? 'text-accent-bright' : ''}`}>
        {value}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function AirportSkeleton() {
  return (
    <div>
      <Skeleton className="h-9 w-48" />
      <Skeleton className="mt-2 h-4 w-64" />
      <Card className="mt-6">
        <CardContent className="flex flex-wrap gap-10 p-6">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i}>
              <Skeleton className="h-7 w-12" />
              <Skeleton className="mt-1.5 h-3 w-16" />
            </div>
          ))}
        </CardContent>
      </Card>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        {[0, 1].map((i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-28" />
            </CardHeader>
            <CardContent className="space-y-3">
              {[0, 1, 2, 3].map((j) => (
                <Skeleton key={j} className="h-7 w-full" />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
