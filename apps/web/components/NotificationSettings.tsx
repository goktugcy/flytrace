'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

async function api(path: string, init?: RequestInit) {
  return fetch(`${API_BASE}/api/v1${path}`, { credentials: 'include', ...init });
}

export function NotificationSettings() {
  const [msg, setMsg] = useState<string>('');
  const [tz, setTz] = useState('Europe/Istanbul');
  const [start, setStart] = useState('22:00');
  const [end, setEnd] = useState('07:00');
  const [email, setEmail] = useState('');
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch(`${API_BASE}/api/auth/session`, { credentials: 'include' });
      const user = ((await res.json()) as { data: { user: unknown } }).data.user;
      setAuthed(Boolean(user));
      if (user) {
        const s = await api('/settings');
        const settings = (
          (await s.json()) as {
            data: { settings: { quietHours?: { tz: string; start: string; end: string } } };
          }
        ).data.settings;
        if (settings.quietHours) {
          setTz(settings.quietHours.tz);
          setStart(settings.quietHours.start);
          setEnd(settings.quietHours.end);
        }
      }
    })();
  }, []);

  if (authed === false)
    return (
      <Shell>
        <p>
          Please <Link href="/signin?next=/settings/notifications">sign in</Link>.
        </p>
      </Shell>
    );

  async function connectTelegram() {
    const res = await api('/channels/telegram/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) return setMsg('Telegram is not configured on the server.');
    const { deepLink } = ((await res.json()) as { data: { deepLink: string } }).data;
    window.open(deepLink, '_blank');
    setMsg('Opened Telegram — tap Start to link your account.');
  }

  async function connectEmail() {
    const res = await api('/channels/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const body = (await res.json()) as { data?: { sent: boolean; token?: string } };
    if (!res.ok) return setMsg('Could not register that email.');
    setMsg(
      body.data?.token
        ? `Dev mode: verify at /verify-email?token=${body.data.token}`
        : 'Verification email sent — check your inbox.',
    );
  }

  async function saveQuietHours() {
    const res = await api('/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quietHours: { tz, start, end } }),
    });
    setMsg(res.ok ? 'Quiet hours saved.' : 'Failed to save.');
  }

  return (
    <Shell>
      {msg && <p style={{ color: 'var(--accent)' }}>{msg}</p>}

      <Card title="Telegram">
        <p style={{ color: 'var(--muted)' }}>Get instant alerts in Telegram.</p>
        <Button onClick={connectTelegram}>Connect Telegram</Button>
      </Card>

      <Card title="Email">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          type="email"
          style={field}
        />
        <Button onClick={connectEmail}>Send verification</Button>
      </Card>

      <Card title="Quiet hours">
        <p style={{ color: 'var(--muted)' }}>
          Non-critical alerts are held during this window (critical ones still come through).
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            placeholder="IANA tz"
            style={field}
          />
          <input
            value={start}
            onChange={(e) => setStart(e.target.value)}
            placeholder="22:00"
            style={{ ...field, width: 90 }}
          />
          <input
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            placeholder="07:00"
            style={{ ...field, width: 90 }}
          />
          <Button onClick={saveQuietHours}>Save</Button>
        </div>
      </Card>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: '2rem 1.5rem' }}>
      <p style={{ marginBottom: '1rem' }}>
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1 style={{ fontSize: '1.75rem', marginBottom: '1rem' }}>Notifications</h1>
      {children}
    </main>
  );
}
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        background: 'var(--panel)',
        borderRadius: 12,
        padding: '1rem 1.25rem',
        marginBottom: '1rem',
        display: 'grid',
        gap: 10,
      }}
    >
      <h2 style={{ fontSize: '1.05rem', margin: 0 }}>{title}</h2>
      {children}
    </section>
  );
}
function Button({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '0.5rem 1rem',
        borderRadius: 8,
        border: 'none',
        background: 'var(--accent)',
        color: '#04122b',
        fontWeight: 600,
        cursor: 'pointer',
        justifySelf: 'start',
      }}
    >
      {children}
    </button>
  );
}
const field: React.CSSProperties = {
  padding: '0.5rem 0.7rem',
  borderRadius: 8,
  border: '1px solid #2a3446',
  background: '#0e1420',
  color: 'var(--fg)',
};
