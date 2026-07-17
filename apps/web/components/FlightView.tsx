'use client';

import type { FlightDetail } from '@flytrace/shared';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { RealtimeClient } from '../lib/realtime-client';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
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

  const title = detail?.flight.callsign ?? flightId.slice(0, 8);

  return (
    <main style={{ maxWidth: 860, margin: '0 auto', padding: '2rem 1.5rem' }}>
      <p style={{ marginBottom: '1rem' }}>
        <Link href="/map">← Live map</Link>
      </p>

      {error ? (
        <p style={{ color: '#ff7b7b' }}>{error}</p>
      ) : (
        <>
          <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <h1 style={{ fontSize: '2rem', margin: 0 }}>{title}</h1>
            {detail && <StatusChip status={detail.flight.status} />}
            <button
              type="button"
              onClick={onWatch}
              disabled={watchState === 'working' || watchState === 'watching'}
              style={{
                marginLeft: 'auto',
                padding: '0.5rem 1rem',
                borderRadius: 8,
                border: 'none',
                cursor: 'pointer',
                fontWeight: 600,
                background: watchState === 'watching' ? '#2e7d5b' : 'var(--accent)',
                color: '#04122b',
              }}
            >
              {watchState === 'watching'
                ? '✓ Watching'
                : watchState === 'working'
                  ? 'Setting up…'
                  : '🔔 Watch'}
            </button>
          </header>
          {watchMsg && (
            <p style={{ color: watchState === 'error' ? '#ff7b7b' : 'var(--muted)', marginTop: 6 }}>
              {watchMsg}
            </p>
          )}

          <section style={panel}>
            <h2 style={h2}>Live telemetry</h2>
            {live ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))',
                  gap: 12,
                }}
              >
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
              <p style={{ color: 'var(--muted)' }}>Waiting for live data…</p>
            )}
          </section>

          <section style={panel}>
            <h2 style={h2}>Timeline</h2>
            {timeline.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>No events yet.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {timeline.map((e, i) => (
                  <li
                    key={`${e.type}-${e.occurredAt}-${i}`}
                    style={{
                      display: 'flex',
                      gap: 12,
                      padding: '6px 0',
                      borderBottom: '1px solid #1e2636',
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{EVENT_LABEL[e.type] ?? e.type}</span>
                    <span style={{ color: 'var(--muted)', marginLeft: 'auto' }}>
                      {new Date(e.occurredAt).toLocaleTimeString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
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

function StatusChip({ status }: { status: string }) {
  return (
    <span
      style={{
        padding: '2px 10px',
        borderRadius: 999,
        background: '#1e2636',
        color: 'var(--muted)',
        fontSize: 13,
      }}
    >
      {status}
    </span>
  );
}

const panel: React.CSSProperties = {
  background: 'var(--panel)',
  borderRadius: 12,
  padding: '1.25rem',
  marginTop: '1.5rem',
};
const h2: React.CSSProperties = { margin: '0 0 1rem', fontSize: '1.1rem' };

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
