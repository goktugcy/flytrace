'use client';

import { apiBase } from '@/lib/api';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState, Spinner } from '@/components/ui/states';
import { readLiveFlightDetail } from '@/lib/live-detail-cache';
import type { FlightDetail } from '@flytrace/shared';
import { Activity, ArrowLeft, Bell, BellRing, Check, Clock, RadioTower } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { RealtimeClient } from '../lib/realtime-client';

const API_BASE = apiBase();
const WS_BASE = API_BASE.replace(/^http/, 'ws');
const WATCH_EVENT_TYPES = ['takeoff', 'landing', 'top_of_climb', 'top_of_descent'] as const;
const CHANNEL_KEYS = ['telegram', 'webpush', 'email'] as const;

type Live = NonNullable<FlightDetail['live']>;
type StatusSnapshot = NonNullable<FlightDetail['statusSnapshot']>;
type ChannelKey = (typeof CHANNEL_KEYS)[number];
interface TimelineEntry {
  type: string;
  occurredAt: string;
  confidence?: number | null;
  source?: string | null;
}

interface AirspaceSummary {
  id: string;
  name: string;
  type: string;
  class: string | null;
  frequency: string | null;
  lowerFt: number | null;
  upperFt: number | null;
}

const EVENT_LABEL: Record<string, string> = {
  TakeoffDetected: 'Takeoff',
  LandingDetected: 'Landing',
  ClimbDetected: 'Climb',
  DescentDetected: 'Descent',
  FlightEnded: 'Flight ended',
  ProviderUpdated: 'Provider update',
  GateChanged: 'Gate change',
  DelayDetected: 'Delay',
  FlightCancelled: 'Cancelled',
  ArrivedAtGate: 'Arrived',
  takeoff: 'Takeoff',
  landing: 'Landing',
  climb: 'Climb',
  descent: 'Descent',
  top_of_climb: 'Top of climb',
  top_of_descent: 'Top of descent',
  flight_detected: 'Detected',
  flight_ended: 'Flight ended',
  gate_change: 'Gate change',
  delay: 'Delay',
  cancelled: 'Cancelled',
  arrived: 'Arrived',
  entered_airspace: 'Airspace',
  aircraft_changed: 'Aircraft',
};

function statusVariant(status: string): 'success' | 'warning' | 'destructive' | 'default' {
  if (status === 'active') return 'success';
  if (status === 'delayed') return 'warning';
  if (status === 'cancelled' || status === 'diverted') return 'destructive';
  return 'default';
}

export function FlightView({ flightId }: { flightId: string }) {
  const [detail, setDetail] = useState<FlightDetail | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [airspaces, setAirspaces] = useState<AirspaceSummary[]>([]);
  const [airspaceState, setAirspaceState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);
  const [watchState, setWatchState] = useState<'idle' | 'working' | 'watching' | 'error'>('idle');
  const [watchMsg, setWatchMsg] = useState<string>('');
  const clientRef = useRef<RealtimeClient | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/flights/id/${encodeURIComponent(flightId)}`);
        if (!res.ok) {
          const cached = flightId.startsWith('adsb:') ? readLiveFlightDetail(flightId) : null;
          if (cached) {
            setDetail(cached);
            setLive(cached.live);
            setTimeline(
              cached.timeline.map((e) => ({
                type: e.type,
                occurredAt: e.occurredAt,
                confidence: e.confidence,
                source: e.source,
              })),
            );
            return;
          }
          setError(res.status === 404 ? 'Flight not found' : `Error ${res.status}`);
          return;
        }
        const d = ((await res.json()) as { data: FlightDetail }).data;
        if (cancelled) return;
        setDetail(d);
        setLive(d.live);
        setTimeline(
          d.timeline.map((e) => ({
            type: e.type,
            occurredAt: e.occurredAt,
            confidence: e.confidence,
            source: e.source,
          })),
        );
      } catch {
        if (!cancelled) setError('Failed to load flight');
      }
    })();

    const client = new RealtimeClient({ apiBase: API_BASE, wsBase: WS_BASE });
    clientRef.current = client;
    const off = client.onMessage((raw) => {
      const m = raw as {
        t: string;
        channel?: string;
        event?: { type: string; payload?: unknown; occurredAt?: string; producer?: string };
      };
      if (m.t === 'event' && m.event) {
        if (m.event.type === 'PositionUpdated' && m.event.payload) {
          setLive((prev) => liveFromPositionPayload(m.event?.payload, prev));
        } else {
          const confidence = eventConfidence(m.event.payload);
          setTimeline((prev) => [
            {
              type: m.event?.type ?? 'event',
              occurredAt: m.event?.occurredAt ?? new Date().toISOString(),
              ...(confidence !== null ? { confidence } : {}),
              ...(m.event?.producer ? { source: m.event.producer } : {}),
            },
            ...prev,
          ]);
        }
      }
    });
    void client.connect().then(() => client.subscribe(`flight:${flightId}`));

    return () => {
      cancelled = true;
      off();
      client.close();
    };
  }, [flightId]);

  const airspaceKey =
    live?.lat != null && live.lon != null
      ? [
          live.lat.toFixed(2),
          live.lon.toFixed(2),
          live.altitudeFt != null ? Math.round(live.altitudeFt / 1000) : 'na',
        ].join(':')
      : '';

  // biome-ignore lint/correctness/useExhaustiveDependencies: airspaceKey intentionally quantizes live movement
  useEffect(() => {
    if (!live || live.lat == null || live.lon == null) {
      setAirspaces([]);
      setAirspaceState('idle');
      return;
    }
    let cancelled = false;
    setAirspaceState('loading');
    const params = new URLSearchParams({
      lat: String(live.lat),
      lon: String(live.lon),
      ...(live.altitudeFt != null ? { alt: String(live.altitudeFt) } : {}),
    });
    fetch(`${API_BASE}/api/v1/airspace/current?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return;
        setAirspaces((body?.data?.matches as AirspaceSummary[] | undefined) ?? []);
        setAirspaceState('ready');
      })
      .catch(() => {
        if (!cancelled) {
          setAirspaces([]);
          setAirspaceState('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [airspaceKey]);

  async function onWatch() {
    if (flightId.startsWith('adsb:')) {
      setWatchState('error');
      setWatchMsg('Live ADS-B aircraft must be persisted before alerts can be created.');
      return;
    }
    setWatchState('working');
    try {
      const session = await fetch(`${API_BASE}/api/auth/session`, { credentials: 'include' });
      const user = ((await session.json()) as { data: { user: unknown } }).data.user;
      if (!user) {
        window.location.href = `/signin?next=/flights/id/${flightId}`;
        return;
      }
      const channels = await preferredWatchChannels();
      const res = await fetch(`${API_BASE}/api/v1/watchlist`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          flightId,
          eventTypes: WATCH_EVENT_TYPES,
          channels,
        }),
      });
      if (!res.ok) throw new Error(`watch ${res.status}`);
      setWatchState('watching');
      setWatchMsg(`Watching — alerts will use ${channels.map(channelLabel).join(', ')}.`);
    } catch (e) {
      setWatchState('error');
      setWatchMsg(e instanceof Error ? e.message : 'Failed to set up the watch');
    }
  }

  if (error) {
    return (
      <Container>
        <BackLink />
        <ErrorState
          title={error === 'Flight not found' ? 'Flight not found' : 'Couldn’t load this flight'}
          description={
            error === 'Flight not found'
              ? 'This flight may have landed and rolled off, or the link is wrong.'
              : 'Please try again in a moment.'
          }
        />
      </Container>
    );
  }

  if (!detail) {
    return (
      <Container>
        <BackLink />
        <FlightSkeleton />
      </Container>
    );
  }

  const canWatch = !detail.flight.flightId.startsWith('adsb:');

  return (
    <Container>
      <BackLink />

      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">{detail.flight.callsign}</h1>
        <Badge variant={statusVariant(detail.flight.status)} className="capitalize">
          {detail.flight.status}
        </Badge>
        {detail.flight.flightNumber && (
          <span className="text-muted-foreground">{detail.flight.flightNumber}</span>
        )}
        {canWatch && (
          <div className="ml-auto">
            <Button
              type="button"
              onClick={onWatch}
              disabled={watchState === 'working' || watchState === 'watching'}
              variant={watchState === 'watching' ? 'secondary' : 'default'}
            >
              {watchState === 'working' && <Spinner />}
              {watchState === 'watching' ? <Check /> : watchState === 'working' ? null : <Bell />}
              {watchState === 'watching'
                ? 'Watching'
                : watchState === 'working'
                  ? 'Setting up…'
                  : 'Watch'}
            </Button>
          </div>
        )}
      </header>
      {watchMsg && (
        <p
          className={
            watchState === 'error'
              ? 'mt-2 text-sm text-destructive'
              : 'mt-2 text-sm text-muted-foreground'
          }
        >
          {watchMsg}
        </p>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BellRing className="size-4 text-muted-foreground" />
              Live telemetry
            </CardTitle>
          </CardHeader>
          <CardContent>
            {live ? (
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
                  <Metric
                    label="Altitude"
                    value={live.altitudeFt != null ? `${live.altitudeFt.toLocaleString()} ft` : '—'}
                  />
                  <Metric label="Geo altitude" value={fmtFt(live.geoAltitudeFt ?? null)} />
                  <Metric
                    label="Ground speed"
                    value={
                      live.groundSpeedKt != null ? `${Math.round(live.groundSpeedKt)} kt` : '—'
                    }
                  />
                  <Metric
                    label="Heading"
                    value={live.headingDeg != null ? headingLabel(live.headingDeg) : '—'}
                  />
                  <Metric
                    label="Vertical"
                    value={
                      live.verticalRateFpm != null
                        ? `${live.verticalRateFpm.toLocaleString()} fpm`
                        : '—'
                    }
                  />
                  <Metric
                    label="Trend"
                    value={verticalTrend(live.verticalRateFpm, live.onGround)}
                  />
                  <Metric label="Squawk" value={live.squawk ?? '—'} />
                  <Metric label="Signal age" value={signalAge(live.ts)} />
                  <Metric
                    label="Position"
                    value={
                      live.lat != null && live.lon != null
                        ? `${live.lat.toFixed(4)}, ${live.lon.toFixed(4)}`
                        : '—'
                    }
                  />
                  <Metric label="On ground" value={live.onGround ? 'Yes' : 'No'} />
                  <Metric label="Updated" value={timeShort(live.ts)} />
                </div>
                <SignalPanel live={live} />
                <AirspacePanel airspaces={airspaces} state={airspaceState} />
              </div>
            ) : (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Spinner className="text-muted-foreground" />
                Waiting for live data…
              </div>
            )}
          </CardContent>
        </Card>

        <OperationsPanel snapshot={detail.statusSnapshot ?? null} />

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="size-4 text-muted-foreground" />
              Timeline
            </CardTitle>
          </CardHeader>
          <CardContent>
            {timeline.length === 0 ? (
              <EmptyState
                icon={Clock}
                title="No events yet"
                description="Takeoff, climb, descent and landing will appear here as they’re detected."
                className="border-0 py-8"
              />
            ) : (
              <ol className="relative space-y-4 border-l border-border pl-5">
                {timeline.map((e, i) => (
                  <li key={`${e.type}-${e.occurredAt}-${i}`} className="relative">
                    <span className="absolute -left-6 top-1.5 size-2 rounded-full bg-accent-bright ring-4 ring-background" />
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <span className="font-medium">{EVENT_LABEL[e.type] ?? e.type}</span>
                        <TimelineMeta entry={e} />
                      </div>
                      <time className="shrink-0 text-sm text-muted-foreground">
                        {timeShort(e.occurredAt)}
                      </time>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>
    </Container>
  );
}

function Container({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">{children}</main>;
}

function BackLink() {
  return (
    <Link
      href="/map"
      className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      Live map
    </Link>
  );
}

function liveFromPositionPayload(raw: unknown, prev: Live | null): Live | null {
  if (!raw || typeof raw !== 'object') return prev;
  const p = raw as {
    flightId?: unknown;
    icao24?: unknown;
    callsign?: unknown;
    lat?: unknown;
    lon?: unknown;
    altitudeFt?: unknown;
    altFt?: unknown;
    geoAltitudeFt?: unknown;
    headingDeg?: unknown;
    groundSpeedKt?: unknown;
    gsKt?: unknown;
    verticalRateFpm?: unknown;
    vrateFpm?: unknown;
    onGround?: unknown;
    squawk?: unknown;
    category?: unknown;
    qualityState?: unknown;
    source?: unknown;
    sourceTimestamp?: unknown;
    receivedAt?: unknown;
    ageMs?: unknown;
    quality?: unknown;
    qualityScore?: unknown;
    positionSource?: unknown;
    isMlat?: unknown;
    ts?: unknown;
  };
  if (typeof p.lat !== 'number' || typeof p.lon !== 'number') return prev;

  const next: Live = {
    ...(prev ?? {}),
    lat: p.lat,
    lon: p.lon,
    altitudeFt: nullableNumberOrFallback(
      firstDefined(p.altitudeFt, p.altFt),
      prev?.altitudeFt ?? null,
    ),
    headingDeg: nullableNumberOrFallback(p.headingDeg, prev?.headingDeg ?? null),
    groundSpeedKt: nullableNumberOrFallback(
      firstDefined(p.groundSpeedKt, p.gsKt),
      prev?.groundSpeedKt ?? null,
    ),
    verticalRateFpm: nullableNumberOrFallback(
      firstDefined(p.verticalRateFpm, p.vrateFpm),
      prev?.verticalRateFpm ?? null,
    ),
    onGround: typeof p.onGround === 'boolean' ? p.onGround : (prev?.onGround ?? false),
    ts: typeof p.ts === 'string' ? p.ts : (prev?.ts ?? new Date().toISOString()),
  };

  const geoAltitudeFt = nullableNumber(p.geoAltitudeFt);
  if (geoAltitudeFt !== undefined) next.geoAltitudeFt = geoAltitudeFt;
  else if (prev?.geoAltitudeFt !== undefined) next.geoAltitudeFt = prev.geoAltitudeFt;

  const qualityScore = nullableNumber(firstDefined(p.qualityScore, p.quality));
  if (qualityScore !== undefined && qualityScore !== null)
    next.qualityScore = clamp01(qualityScore);
  else if (prev?.qualityScore !== undefined) next.qualityScore = prev.qualityScore;

  if (typeof p.flightId === 'string') next.flightId = p.flightId;
  if (typeof p.icao24 === 'string') next.icao24 = p.icao24;
  if (typeof p.callsign === 'string' || p.callsign === null) next.callsign = p.callsign;
  if (typeof p.squawk === 'string' || p.squawk === null) next.squawk = p.squawk;
  if (typeof p.category === 'string' || p.category === null) next.category = p.category;
  if (isQualityState(p.qualityState)) next.qualityState = p.qualityState;
  else if (prev?.qualityState !== undefined) next.qualityState = prev.qualityState;
  if (typeof p.source === 'string' || p.source === null) next.source = p.source;
  if (typeof p.sourceTimestamp === 'string') next.sourceTimestamp = p.sourceTimestamp;
  if (typeof p.receivedAt === 'string') next.receivedAt = p.receivedAt;
  if (typeof p.ageMs === 'number' && Number.isFinite(p.ageMs)) {
    next.ageMs = Math.max(0, Math.round(p.ageMs));
  } else if (prev?.ageMs !== undefined) {
    next.ageMs = prev.ageMs;
  }
  if (typeof p.positionSource === 'string') next.positionSource = p.positionSource;
  if (typeof p.isMlat === 'boolean') next.isMlat = p.isMlat;

  return next;
}

function eventConfidence(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const confidence = (payload as { confidence?: unknown }).confidence;
  return typeof confidence === 'number' && Number.isFinite(confidence) ? clamp01(confidence) : null;
}

function SignalPanel({ live }: { live: Live }) {
  const quality = live.qualityState ?? derivedQuality(live.ts);
  const source = sourceLabel(
    live.source ?? null,
    live.positionSource ?? null,
    live.isMlat ?? false,
  );
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={qualityVariant(quality)} className="capitalize">
          {qualityText(quality)}
        </Badge>
        {source !== '—' && <Badge variant="outline">{source}</Badge>}
        {live.qualityScore != null && (
          <Badge variant="outline">Quality {formatPercent(live.qualityScore)}</Badge>
        )}
        <span className="text-xs text-muted-foreground">
          Age {live.ageMs != null ? fmtAgeMs(live.ageMs) : signalAge(live.ts)}
        </span>
        {live.sourceTimestamp && (
          <span className="text-xs text-muted-foreground">
            Source {timeShort(live.sourceTimestamp)}
          </span>
        )}
        {live.receivedAt && (
          <span className="text-xs text-muted-foreground">Rx {timeShort(live.receivedAt)}</span>
        )}
      </div>
    </div>
  );
}

function OperationsPanel({ snapshot }: { snapshot: StatusSnapshot | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="size-4 text-muted-foreground" />
          Operations
        </CardTitle>
      </CardHeader>
      <CardContent>
        {snapshot ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={statusVariant(snapshot.status)} className="capitalize">
                {snapshot.status}
              </Badge>
              <Badge variant="outline">{snapshot.providerKey}</Badge>
              <span className="text-xs text-muted-foreground">
                Fetched {dateTimeShort(snapshot.fetchedAt)}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
              <Field label="Gate" value={snapshot.gate ?? '—'} />
              <Field label="Terminal" value={snapshot.terminal ?? '—'} />
              <Field label="Baggage" value={snapshot.baggageBelt ?? '—'} />
              <Field label="Scheduled dep" value={dateTimeShort(snapshot.scheduledDeparture)} />
              <Field label="Estimated dep" value={dateTimeShort(snapshot.estimatedDeparture)} />
              <Field label="Actual dep" value={dateTimeShort(snapshot.actualDeparture)} />
              <Field label="Scheduled arr" value={dateTimeShort(snapshot.scheduledArrival)} />
              <Field label="Estimated arr" value={dateTimeShort(snapshot.estimatedArrival)} />
              <Field label="Actual arr" value={dateTimeShort(snapshot.actualArrival)} />
            </div>
          </div>
        ) : (
          <EmptyState icon={Activity} title="No provider status" className="border-0 py-8" />
        )}
      </CardContent>
    </Card>
  );
}

function TimelineMeta({ entry }: { entry: TimelineEntry }) {
  const items = [
    entry.source,
    entry.confidence != null ? `${formatPercent(entry.confidence)} confidence` : null,
  ].filter(Boolean);
  if (items.length === 0) return null;
  return <div className="mt-0.5 text-xs text-muted-foreground">{items.join(' · ')}</div>;
}

function signalAge(ts: string): string {
  const ageSec = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
  if (!Number.isFinite(ageSec)) return '—';
  if (ageSec < 60) return `${ageSec}s`;
  const min = Math.round(ageSec / 60);
  return `${min}m`;
}

function fmtAgeMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function fmtFt(ft: number | null): string {
  return ft != null ? `${Math.round(ft).toLocaleString()} ft` : '—';
}

function nullableNumber(raw: unknown): number | null | undefined {
  if (raw === null) return null;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function nullableNumberOrFallback(raw: unknown, fallback: number | null): number | null {
  const parsed = nullableNumber(raw);
  return parsed === undefined ? fallback : parsed;
}

function firstDefined(a: unknown, b: unknown): unknown {
  return a === undefined ? b : a;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function isQualityState(raw: unknown): raw is NonNullable<Live['qualityState']> {
  return raw === 'live' || raw === 'delayed' || raw === 'stale' || raw === 'signal_lost';
}

function derivedQuality(ts: string): NonNullable<Live['qualityState']> {
  const ageMs = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(ageMs) || ageMs <= 15_000) return 'live';
  if (ageMs <= 30_000) return 'delayed';
  if (ageMs <= 60_000) return 'stale';
  return 'signal_lost';
}

function qualityVariant(
  state: NonNullable<Live['qualityState']>,
): 'success' | 'warning' | 'destructive' | 'default' {
  if (state === 'live') return 'success';
  if (state === 'delayed' || state === 'stale') return 'warning';
  if (state === 'signal_lost') return 'destructive';
  return 'default';
}

function qualityText(state: NonNullable<Live['qualityState']>): string {
  if (state === 'signal_lost') return 'Signal lost';
  return state.replace('_', ' ');
}

function sourceLabel(
  source: string | null,
  positionSource: string | null,
  isMlat: boolean,
): string {
  const base = (positionSource ?? source)?.trim();
  if (!base) return '—';
  const normalized = base.toUpperCase().replace(/[_-]/g, ' ');
  if (base.toLowerCase() === 'mlat') return 'MLAT';
  return isMlat ? `${normalized} / MLAT` : normalized;
}

function formatPercent(n: number): string {
  return `${Math.round(clamp01(n) * 100)}%`;
}

function timeShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dateTimeShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function headingLabel(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % dirs.length;
  return `${Math.round(deg)}° ${dirs[idx]}`;
}

function verticalTrend(vr: number | null, onGround: boolean): string {
  if (onGround) return 'Ground';
  if (vr == null) return '—';
  if (vr > 300) return 'Climbing';
  if (vr < -300) return 'Descending';
  return 'Level';
}

function airspaceBand(a: AirspaceSummary): string {
  const lower = a.lowerFt == null || a.lowerFt <= 0 ? 'GND' : `${a.lowerFt.toLocaleString()} ft`;
  const upper = a.upperFt == null ? 'UNL' : `${a.upperFt.toLocaleString()} ft`;
  return `${lower}-${upper}`;
}

function AirspacePanel({
  airspaces,
  state,
}: {
  airspaces: AirspaceSummary[];
  state: 'idle' | 'loading' | 'ready' | 'error';
}) {
  const primary = airspaces[0];
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <div className="flex items-start gap-2">
        <RadioTower className="mt-0.5 size-4 shrink-0 text-accent-bright" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium uppercase text-muted-foreground">Airspace</span>
            {primary && (
              <span className="text-xs text-muted-foreground">{airspaceBand(primary)}</span>
            )}
          </div>
          <div className="mt-1 truncate font-medium">
            {state === 'loading'
              ? 'Loading...'
              : state === 'error'
                ? 'Unavailable'
                : primary
                  ? primary.name
                  : state === 'ready'
                    ? 'Outside controlled airspace'
                    : '—'}
          </div>
          {primary && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {airspaces.slice(0, 4).map((airspace) => (
                <span
                  key={airspace.id}
                  className="rounded bg-background px-2 py-1 text-xs text-muted-foreground"
                >
                  {airspace.type}
                  {airspace.class ? ` ${airspace.class}` : ''}
                  {airspace.frequency ? ` · ${airspace.frequency}` : ''}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
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

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-sm font-medium tabular-nums">{value}</div>
    </div>
  );
}

function FlightSkeleton() {
  return (
    <div>
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-32" />
            </CardHeader>
            <CardContent className="space-y-4">
              {[0, 1, 2].map((j) => (
                <Skeleton key={j} className="h-8 w-full" />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

async function preferredWatchChannels(): Promise<ChannelKey[]> {
  const settingsRes = await fetch(`${API_BASE}/api/v1/settings`, { credentials: 'include' });
  const settingsBody = (await settingsRes.json().catch(() => ({}))) as {
    data?: { settings?: { defaultChannels?: unknown } };
  };
  const defaults = normalizeChannels(settingsBody.data?.settings?.defaultChannels);
  const requested: ChannelKey[] = defaults.length > 0 ? defaults : ['webpush'];

  const channelsRes = await fetch(`${API_BASE}/api/v1/channels`, { credentials: 'include' });
  const channelsBody = (await channelsRes.json().catch(() => ({}))) as {
    data?: { items?: { channel: string; verified: boolean; enabled: boolean }[] };
  };
  const readyChannels = new Set<ChannelKey>(
    (channelsBody.data?.items ?? [])
      .filter((item) => item.verified && item.enabled && isChannelKey(item.channel))
      .map((item) => item.channel as ChannelKey),
  );

  if (requested.includes('webpush')) {
    await subscribeWebPush();
    readyChannels.add('webpush');
  }

  const selected = requested.filter((channel) => readyChannels.has(channel));
  if (selected.length === 0) {
    throw new Error('Connect a notification channel in settings first.');
  }
  return selected;
}

function normalizeChannels(value: unknown): ChannelKey[] {
  if (!Array.isArray(value)) return [];
  return CHANNEL_KEYS.filter((channel) => value.includes(channel));
}

function isChannelKey(value: string): value is ChannelKey {
  return CHANNEL_KEYS.includes(value as ChannelKey);
}

function channelLabel(channel: ChannelKey): string {
  if (channel === 'webpush') return 'Push';
  if (channel === 'telegram') return 'Telegram';
  return 'Email';
}

/** Register the service worker + create a Web Push subscription (docs/10 §10.6). */
async function subscribeWebPush(): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Web Push is not supported in this browser');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission denied');

  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;

  const keyRes = await fetch(`${API_BASE}/api/v1/config/webpush`);
  const publicKey = ((await keyRes.json()) as { data: { publicKey: string | null } }).data
    .publicKey;
  if (!publicKey) throw new Error('Web Push is not configured on the server');

  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error('Browser returned an incomplete push subscription');
  }

  await fetch(`${API_BASE}/api/v1/channels/webpush/subscribe`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
  });
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
