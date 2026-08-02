'use client';

import { apiBase } from '@/lib/api';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/states';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { CheckCircle2, Plane, ShieldCheck } from 'lucide-react';
import Script from 'next/script';
import { type FormEvent, useEffect, useRef, useState } from 'react';

const API_BASE = apiBase();
const TURNSTILE_ACTION = 'turnstile-spin-v1';
const TURNSTILE_ENABLED = process.env.NEXT_PUBLIC_TURNSTILE_ENABLED === 'true';
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

type Mode = 'sign-in' | 'sign-up';

/**
 * The in-flight second factor.
 *
 * This lives in COMPONENT STATE ONLY — never localStorage, sessionStorage or a
 * cookie. The challenge token is a bearer credential one step away from a
 * session; persisting it would leave a usable half-authentication on disk for
 * any XSS or shared-machine attacker to pick up, and would outlive the tab it
 * was issued to.
 *
 * The consequence is deliberate: reloading the page during the second step
 * loses the challenge and returns the user to the password form. That is the
 * safe direction to fail — the challenge is valid for minutes, re-entering a
 * password is cheap, and the alternative is a persisted credential. The server
 * expires the orphaned challenge on its own.
 */
interface PendingMfa {
  challengeToken: string;
  expiresAt: number;
}

declare global {
  interface Window {
    turnstile?: {
      render?: (container: HTMLElement, opts: { sitekey: string; action?: string }) => string;
      reset?: () => void;
    };
  }
}

interface AuthResponse {
  data?: {
    status?: 'authenticated' | 'mfa_required';
    challengeToken?: string;
    expiresAt?: string;
    expiresInSeconds?: number;
  };
  error?: { message?: string };
}

export function AuthForm({ next, nonce }: { next: string; nonce?: string | undefined }) {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'busy' | 'success'>('idle');
  const [turnstileReady, setTurnstileReady] = useState(false);
  const [pendingMfa, setPendingMfa] = useState<PendingMfa | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);
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

  // Count the challenge down and drop it client-side the moment it expires, so
  // the UI never invites the user to submit a code that cannot work.
  useEffect(() => {
    if (!pendingMfa) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((pendingMfa.expiresAt - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0) {
        setPendingMfa(null);
        setMfaCode('');
        setError(t('auth.mfa.expired'));
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [pendingMfa, t]);

  function onAuthenticated() {
    setStatus('success');
    setPendingMfa(null);
    setMfaCode('');
    setTimeout(() => {
      window.location.href = next || '/map';
    }, 600);
  }

  async function readError(res: Response): Promise<string> {
    const body = (await res.json().catch(() => null)) as AuthResponse | null;
    return body?.error?.message ?? `Request failed (${res.status})`;
  }

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
      if (!res.ok) throw new Error(await readError(res));

      const body = (await res.json()) as AuthResponse;
      if (body.data?.status === 'mfa_required' && body.data.challengeToken) {
        // No session cookie was set by this response — the account is only
        // half authenticated until the code is verified.
        setStatus('idle');
        setPassword('');
        setPendingMfa({
          challengeToken: body.data.challengeToken,
          expiresAt: body.data.expiresAt
            ? Date.parse(body.data.expiresAt)
            : Date.now() + (body.data.expiresInSeconds ?? 300) * 1000,
        });
        return;
      }
      onAuthenticated();
    } catch (err) {
      setStatus('idle');
      setError(err instanceof Error ? err.message : 'Something went wrong');
      if (needsTurnstile) window.turnstile?.reset?.();
    }
  }

  async function submitMfa(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!pendingMfa) return;
    setStatus('busy');
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/auth/mfa/verify`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          challengeToken: pendingMfa.challengeToken,
          code: mfaCode.trim(),
        }),
      });
      if (!res.ok) {
        const message = await readError(res);
        setStatus('idle');
        setMfaCode('');
        // 429 means the challenge is spent (attempt cap or rate limit): send the
        // user back to the start rather than letting them keep typing into a
        // challenge the server has already burned.
        if (res.status === 429) setPendingMfa(null);
        setError(message);
        return;
      }
      onAuthenticated();
    } catch (err) {
      setStatus('idle');
      setError(err instanceof Error ? err.message : 'Something went wrong');
    }
  }

  function switchMode(m: Mode) {
    setMode(m);
    setError(null);
    setPendingMfa(null);
    setMfaCode('');
  }

  function cancelMfa() {
    setPendingMfa(null);
    setMfaCode('');
    setError(null);
  }

  const heading = pendingMfa
    ? t('auth.mfa.title')
    : mode === 'sign-in'
      ? t('auth.welcome')
      : t('auth.create');
  const subheading = pendingMfa
    ? t('auth.mfa.sub')
    : mode === 'sign-in'
      ? t('auth.sub.signin')
      : t('auth.sub.signup');

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
          {pendingMfa ? <ShieldCheck className="size-5" /> : <Plane className="size-5" />}
        </span>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">{heading}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{subheading}</p>
      </div>

      <Card>
        {!pendingMfa && (
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
        )}

        <CardContent className="pt-6">
          {pendingMfa ? (
            <form onSubmit={submitMfa} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="mfa-code">{t('auth.mfa.code')}</Label>
                <Input
                  id="mfa-code"
                  name="mfa-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  // Never let the browser or a password manager retain this.
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={t('auth.mfa.code.ph')}
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  required
                  minLength={4}
                  maxLength={64}
                />
                <p className="text-xs text-muted-foreground">{t('auth.mfa.backup.hint')}</p>
              </div>

              {secondsLeft > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('auth.mfa.expiresIn', { seconds: String(secondsLeft) })}
                </p>
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
                {status === 'success' ? t('auth.success') : t('auth.mfa.submit')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={cancelMfa}
                disabled={status === 'busy'}
              >
                {t('auth.mfa.cancel')}
              </Button>
            </form>
          ) : (
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
          )}
        </CardContent>
      </Card>

      <p className="mt-6 text-center text-xs text-muted-foreground">{t('auth.terms')}</p>
    </main>
  );
}
