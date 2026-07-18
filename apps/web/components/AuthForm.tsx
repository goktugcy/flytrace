'use client';

import { apiBase } from '@/lib/api';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/states';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { CheckCircle2, Plane } from 'lucide-react';
import { useState } from 'react';

const API_BASE = apiBase();

type Mode = 'sign-in' | 'sign-up';

export function AuthForm({ next }: { next: string }) {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'busy' | 'success'>('idle');
  const t = useT();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('busy');
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
      setStatus('success');
      setTimeout(() => {
        window.location.href = next || '/map';
      }, 600);
    } catch (err) {
      setStatus('idle');
      setError(err instanceof Error ? err.message : 'Something went wrong');
    }
  }

  function switchMode(m: Mode) {
    setMode(m);
    setError(null);
  }

  return (
    <main className="mx-auto flex min-h-[calc(100dvh-3.5rem)] max-w-md flex-col justify-center px-4 py-12 sm:px-6">
      <div className="mb-6 flex flex-col items-center text-center">
        <span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-soft">
          <Plane className="size-5" />
        </span>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">
          {mode === 'sign-in' ? t('auth.welcome') : t('auth.create')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {mode === 'sign-in' ? t('auth.sub.signin') : t('auth.sub.signup')}
        </p>
      </div>

      <Card>
        <CardHeader className="pb-0">
          {/* Segmented mode switch */}
          <div
            role="tablist"
            aria-label="Authentication mode"
            className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1"
          >
            {(['sign-in', 'sign-up'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => switchMode(m)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  mode === m
                    ? 'bg-card text-foreground shadow-soft'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {m === 'sign-in' ? t('auth.tab.signin') : t('auth.tab.signup')}
              </button>
            ))}
          </div>
        </CardHeader>

        <CardContent className="pt-6">
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">{t('auth.email')}</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t('auth.password')}</Label>
              <Input
                id="password"
                type="password"
                autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
                placeholder={t('auth.password.ph')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
              />
            </div>

            {error && (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={status !== 'idle'}>
              {status === 'busy' && <Spinner />}
              {status === 'success' && <CheckCircle2 />}
              {status === 'success'
                ? t('auth.success')
                : mode === 'sign-in'
                  ? t('auth.submit.signin')
                  : t('auth.submit.signup')}
            </Button>
          </form>
        </CardContent>
      </Card>

      <p className="mt-6 text-center text-xs text-muted-foreground">{t('auth.terms')}</p>
    </main>
  );
}
