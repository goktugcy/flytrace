'use client';

import { apiBase } from '@/lib/api';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState, Spinner } from '@/components/ui/states';
import type { FlightDetail } from '@flytrace/shared';
import { ArrowLeft, Bell, BellRing, Check, Clock } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { RealtimeClient } from '../lib/realtime-client';

const API_BASE = apiBase();
const WS_BASE = API_BASE.replace(/^http/, 'ws');

type Live = NonNullable<FlightDetail['live']>;
interface TimelineEntry {
  type: string;
  occurredAt: string;
}

const EVENT_LABEL: Record<string, string> = {
  TakeoffDetected: 'Takeoff',
  LandingDetected: 'Landing',
  ClimbDetected: 'Climb',
  DescentDetected: 'Descent',
  FlightEnded: 'Flight ended',
  takeoff: 'Takeoff',
  landing: 'Landing',
  climb: 'Climb',
  descent: 'Descent',
  top_of_climb: 'Top of climb',
  top_of_descent: 'Top of descent',
  flight_detected: 'Detected',
  flight_ended: 'Flight ended',
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
  const [error, setError] = useState<string | null>(null);
  const [watchState, setWatchState] = useState<'idle' | 'working' | 'watching' | 'error'>('idle');
  const [watchMsg, setWatchMsg] = useState<string>('');
  const clientRef = useRef<RealtimeClient | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/flights/id/${flightId}`);
        if (!res.ok) {
          setError(res.status === 404 ? 'Flight not found' : `Error ${res.status}`);
          return;
        }
        const d = ((await res.json()) as { data: FlightDetail }).data;
        if (cancelled) return;
        setDetail(d);
        setLive(d.live);
        setTimeline(d.timeline.map((e) => ({ type: e.type, occurredAt: e.occurredAt })));
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
        event?: { type: string; payload?: Live; occurredAt?: string };
      };
      if (m.t === 'event' && m.event) {
        if (m.event.type === 'PositionUpdated' && m.event.payload) {
          setLive(m.event.payload);
        } else {
          setTimeline((prev) => [
            {
              type: m.event?.type ?? 'event',
              occurredAt: m.event?.occurredAt ?? new Date().toISOString(),
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

  async function onWatch() {
    setWatchState('working');
    try {
      const session = await fetch(`${API_BASE}/api/auth/session`, { credentials: 'include' });
      const user = ((await session.json()) as { data: { user: unknown } }).data.user;
      if (!user) {
        window.location.href = `/signin?next=/flights/id/${flightId}`;
        return;
      }
      await subscribeWebPush();
      const res = await fetch(`${API_BASE}/api/v1/watchlist`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          flightId,
          eventTypes: ['takeoff', 'landing', 'top_of_climb', 'top_of_descent'],
          channels: ['webpush'],
        }),
      });
      if (!res.ok) throw new Error(`watch ${res.status}`);
      setWatchState('watching');
      setWatchMsg('Watching — you’ll get a push on takeoff, cruise, descent & landing.');
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
              <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
                <Metric
                  label="Altitude"
                  value={live.altitudeFt != null ? `${live.altitudeFt.toLocaleString()} ft` : '—'}
                />
                <Metric
                  label="Ground speed"
                  value={live.groundSpeedKt != null ? `${Math.round(live.groundSpeedKt)} kt` : '—'}
                />
                <Metric
                  label="Heading"
                  value={live.headingDeg != null ? `${Math.round(live.headingDeg)}°` : '—'}
                />
                <Metric
                  label="Vertical"
                  value={live.verticalRateFpm != null ? `${live.verticalRateFpm} fpm` : '—'}
                />
                <Metric
                  label="Position"
                  value={
                    live.lat != null && live.lon != null
                      ? `${live.lat.toFixed(2)}, ${live.lon.toFixed(2)}`
                      : '—'
                  }
                />
                <Metric label="On ground" value={live.onGround ? 'Yes' : 'No'} />
              </div>
            ) : (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Spinner className="text-muted-foreground" />
                Waiting for live data…
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
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
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">{EVENT_LABEL[e.type] ?? e.type}</span>
                      <time className="text-sm text-muted-foreground">
                        {new Date(e.occurredAt).toLocaleTimeString()}
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
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

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };

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
