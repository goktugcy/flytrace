'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export function VerifyEmail({ token }: { token: string }) {
  const [state, setState] = useState<'working' | 'ok' | 'fail'>('working');

  useEffect(() => {
    if (!token) return setState('fail');
    (async () => {
      const res = await fetch(`${API_BASE}/api/v1/channels/email/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      setState(res.ok ? 'ok' : 'fail');
    })();
  }, [token]);

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '4rem 1.5rem', textAlign: 'center' }}>
      {state === 'working' && <p style={{ color: 'var(--muted)' }}>Verifying…</p>}
      {state === 'ok' && (
        <>
          <h1>✅ Email verified</h1>
          <p style={{ color: 'var(--muted)' }}>You’ll now receive flight alerts by email.</p>
          <p>
            <Link href="/dashboard">Go to dashboard →</Link>
          </p>
        </>
      )}
      {state === 'fail' && (
        <>
          <h1>⚠️ Verification failed</h1>
          <p style={{ color: 'var(--muted)' }}>This link is invalid or expired.</p>
          <p>
            <Link href="/settings/notifications">Try again</Link>
          </p>
        </>
      )}
    </main>
  );
}
