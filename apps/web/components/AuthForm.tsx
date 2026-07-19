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
import Script from 'next/script';
import { type FormEvent, useEffect, useRef, useState } from 'react';

const API_BASE = apiBase();
const TURNSTILE_ACTION = 'turnstile-spin-v1';
const TURNSTILE_ENABLED = process.env.NEXT_PUBLIC_TURNSTILE_ENABLED === 'true';
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

type Mode = 'sign-in' | 'sign-up';

declare global {
  interface Window {
    turnstile?: {
      render?: (container: HTMLElement, opts: { sitekey: string; action?: string }) => string;
      reset?: () => void;
    };
  }
}

export function AuthForm({ next, nonce }: { next: string; nonce?: string | undefined }) {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'busy' | 'success'>('idle');
  const [turnstileReady, setTurnstileReady] = useState(false);
  const turnstileRef = useRef<HTMLDivElement | null>(null);
  const t = useT();
  const needsTurnstile = mode === 'sign-up' && TURNSTILE_ENABLED && Boolean(TURNSTILE_SITE_KEY);

  useEffect(() => {
    if (window.turnstile) setTurnstileReady(true);
  }, []);

  useEffect(() => {
    if (!needsTurnstile || !turnstileReady || !TURNSTILE_SITE_KEY || !turnstileRef.current) return;
    if (turnstileRef.current.childElementCount > 0) return;
    window.turnstile?.render?.(turnstileRef.current, {
      sitekey: TURNSTILE_SITE_KEY,
      action: TURNSTILE_ACTION,
    });
  }, [needsTurnstile, turnstileReady]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('busy');
    setError(null);
    try {
      const headers = new Headers({ 'content-type': 'application/json' });
      if (needsTurnstile) {
        const token = new FormData(e.currentTarget).get('cf-turnstile-response');
        if (typeof token !== 'string' || token.length === 0) {
          throw new Error('Bot verification required');
        }
        headers.set('cf-turnstile-response', token);
      }
      const res = await fetch(`${API_BASE}/api/auth/${mode}`, {
        method: 'POST',
        credentials: 'include',
        headers,
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
      if (needsTurnstile) window.turnstile?.reset?.();
    }
  }

  function switchMode(m: Mode) {
    setMode(m);
    setError(null);
  }

  return (
    <main className="mx-auto flex min-h-[calc(100dvh-3.5rem)] max-w-md flex-col justify-center px-4 py-12 sm:px-6">
      {TURNSTILE_ENABLED && TURNSTILE_SITE_KEY && (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
          strategy="lazyOnload"
          nonce={nonce}
          onLoad={() => setTurnstileReady(true)}
        />
      )}
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

            {needsTurnstile && (
              <div className="flex min-h-[65px] justify-center overflow-hidden">
                <div ref={turnstileRef} />
              </div>
            )}

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
