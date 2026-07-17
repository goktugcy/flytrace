'use client';

import { useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export function AuthForm({ next }: { next: string }) {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/auth/${mode}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
      }
      window.location.href = next || '/map';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 400, margin: '0 auto', padding: '4rem 1.5rem' }}>
      <h1 style={{ fontSize: '1.75rem' }}>{mode === 'sign-in' ? 'Sign in' : 'Create account'}</h1>
      <form onSubmit={submit} style={{ display: 'grid', gap: 12, marginTop: '1.5rem' }}>
        <input
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={field}
        />
        <input
          type="password"
          placeholder="Password (min 8 chars)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          style={field}
        />
        {error && <p style={{ color: '#ff7b7b', margin: 0 }}>{error}</p>}
        <button type="submit" disabled={busy} style={button}>
          {busy ? '…' : mode === 'sign-in' ? 'Sign in' : 'Sign up'}
        </button>
      </form>
      <p style={{ color: 'var(--muted)', marginTop: '1rem' }}>
        {mode === 'sign-in' ? 'No account?' : 'Have an account?'}{' '}
        <button
          type="button"
          onClick={() => setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--accent)',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {mode === 'sign-in' ? 'Create one' : 'Sign in'}
        </button>
      </p>
    </main>
  );
}

const field: React.CSSProperties = {
  padding: '0.6rem 0.8rem',
  borderRadius: 8,
  border: '1px solid #2a3446',
  background: '#0e1420',
  color: 'var(--fg)',
  fontSize: 15,
};
const button: React.CSSProperties = {
  padding: '0.6rem 1rem',
  borderRadius: 8,
  border: 'none',
  background: 'var(--accent)',
  color: '#04122b',
  fontWeight: 600,
  cursor: 'pointer',
};
