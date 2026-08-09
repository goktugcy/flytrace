'use client';

import { apiBase } from '@/lib/api';
import { useT } from '@/lib/i18n';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { usePasswordPrompt } from '@/components/ui/password-prompt';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState, Spinner } from '@/components/ui/states';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Copy,
  Download,
  KeyRound,
  Laptop,
  LogOut,
  MonitorSmartphone,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import QRCode from 'qrcode';
import { type FormEvent, useCallback, useEffect, useState } from 'react';

const API_BASE = apiBase();

interface SessionRow {
  id: string;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
}

interface DeviceRow {
  id: string;
  fingerprint: string;
  ua: string | null;
  lastIp: string | null;
  trusted: boolean;
  lastSeenAt: string;
  createdAt: string;
}

type State = 'loading' | 'ready' | 'unauth' | 'error';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api/v1${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const body = (await res.json().catch(() => ({}))) as {
    data?: T;
    error?: { message?: string; code?: string };
  };
  if (!res.ok) throw new Error(body.error?.message ?? body.error?.code ?? `HTTP ${res.status}`);
  return body.data as T;
}

function shortUa(ua: string | null): string {
  if (!ua) return 'Unknown device';
  // Enough to recognise your own device without dumping a 200-char string.
  const browser = /Firefox\/[\d.]+/.exec(ua)?.[0] ?? /(Chrome|Safari|Edg)\/[\d.]+/.exec(ua)?.[0];
  const os = /\(([^)]+)\)/.exec(ua)?.[1]?.split(';')[0]?.trim();
  return [browser, os].filter(Boolean).join(' · ') || ua.slice(0, 48);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Groups a Base32 secret into readable blocks for manual entry. */
function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? [secret]).join(' ');
}

export function SecuritySettings() {
  const t = useT();
  const passwordPrompt = usePasswordPrompt();
  const [state, setState] = useState<State>('loading');
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // ── MFA enrolment ──
  const [enrolling, setEnrolling] = useState<{ secret: string; uri: string; qr: string } | null>(
    null,
  );
  const [confirmCode, setConfirmCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    // `/me` carries mfaEnabled; sessions and devices are their own endpoints.
    const [me, s, d] = await Promise.all([
      api<{ user: { mfaEnabled?: boolean } }>('/me'),
      api<{ items: SessionRow[] }>('/security/sessions'),
      api<{ items: DeviceRow[] }>('/security/devices'),
    ]);
    setMfaEnabled(Boolean(me.user?.mfaEnabled));
    setSessions(s.items);
    setDevices(d.items);
  }, []);

  const load = useCallback(async () => {
    setState('loading');
    setError(null);
    try {
      const session = await fetch(`${API_BASE}/api/auth/session`, { credentials: 'include' });
      const user = ((await session.json()) as { data?: { user?: unknown } }).data?.user;
      if (!user) {
        setState('unauth');
        return;
      }
      await refresh();
      setState('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  }, [refresh]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Wrap an action: single in-flight guard, surface the error, then reload. */
  async function run(key: string, fn: () => Promise<void>, successMessage?: string) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (successMessage) setNotice(successMessage);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function beginEnrollment() {
    await run('mfa-setup', async () => {
      const data = await api<{ secret: string; otpauthUri: string }>('/security/mfa/setup', {
        method: 'POST',
      });
      // Rendered to a data: URL, which the CSP's `img-src data:` already allows.
      const qr = await QRCode.toDataURL(data.otpauthUri, { margin: 1, width: 208 });
      setEnrolling({ secret: data.secret, uri: data.otpauthUri, qr });
      setConfirmCode('');
    });
  }

  async function confirmEnrollment(e: FormEvent) {
    e.preventDefault();
    await run('mfa-confirm', async () => {
      const data = await api<{ backupCodes: string[] }>('/security/mfa/confirm', {
        method: 'POST',
        body: JSON.stringify({ token: confirmCode.trim() }),
      });
      setEnrolling(null);
      setConfirmCode('');
      setBackupCodes(data.backupCodes);
    });
  }

  async function regenerateCodes() {
    const password = await passwordPrompt.ask({
      title: t('sec.mfa.regen'),
      description: t('sec.password.desc.regen'),
    });
    if (!password) return;
    await run('mfa-regen', async () => {
      const data = await api<{ backupCodes: string[] }>('/security/mfa/backup-codes/refresh', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      setBackupCodes(data.backupCodes);
    });
  }

  async function disableMfa() {
    const password = await passwordPrompt.ask({
      title: t('sec.mfa.disable'),
      description: t('sec.password.desc.mfaOff'),
      destructive: true,
    });
    if (!password) return;
    await run('mfa-disable', async () => {
      await api('/security/mfa/disable', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      // The server revoked every session, including this one.
      window.location.href = '/signin?next=/settings/security';
    });
  }

  async function revokeDevice(id: string) {
    const password = await passwordPrompt.ask({
      title: t('sec.devices.revoke'),
      description: t('sec.password.desc.device'),
      destructive: true,
    });
    if (!password) return;
    await run(`device-${id}`, async () => {
      await api(`/security/devices/${id}`, {
        method: 'DELETE',
        body: JSON.stringify({ password }),
      });
    });
  }

  async function changePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const currentPassword = String(form.get('currentPassword') ?? '');
    const newPassword = String(form.get('newPassword') ?? '');
    await run(
      'password',
      async () => {
        await api('/security/password', {
          method: 'POST',
          body: JSON.stringify({ currentPassword, newPassword }),
        });
        setNotice(t('sec.pw.done'));
        setTimeout(() => {
          window.location.href = '/signin?next=/settings/security';
        }, 1200);
      },
      undefined,
    );
  }

  async function signOutEverywhere() {
    await run('signout-all', async () => {
      const res = await fetch(`${API_BASE}/api/auth/sign-out-all`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      window.location.href = '/signin';
    });
  }

  async function copyCodes() {
    if (!backupCodes) return;
    await navigator.clipboard.writeText(backupCodes.join('\n')).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function downloadCodes() {
    if (!backupCodes) return;
    const blob = new Blob([`${backupCodes.join('\n')}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'flytrace-backup-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            {t('nav.dashboard')}
          </Link>
          <h1 className="mt-5 text-2xl font-semibold tracking-tight">{t('sec.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('sec.subtitle')}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={load}>
          <RefreshCw />
          {t('sec.refresh')}
        </Button>
      </div>

      <div className="mt-8 space-y-6">
        {state === 'loading' && (
          <div className="space-y-4">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}

        {state === 'unauth' && (
          <EmptyState
            icon={ShieldCheck}
            title={t('sec.unauth.title')}
            description={t('sec.unauth.body')}
            action={
              <Button asChild size="sm">
                <Link href="/signin?next=/settings/security">{t('nav.signin')}</Link>
              </Button>
            }
          />
        )}

        {state === 'error' && <ErrorState title={t('sec.error.title')} onRetry={load} />}

        {state === 'ready' && (
          <>
            {error && (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                {error}
              </p>
            )}
            {notice && (
              <p className="flex items-start gap-2 rounded-md border border-border bg-secondary/40 px-3 py-2 text-sm">
                <Check className="mt-0.5 size-4 shrink-0" />
                {notice}
              </p>
            )}

            {/* ── Backup codes: shown once, immediately after they are minted ── */}
            {backupCodes && (
              <Card className="border-accent-bright/40">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <KeyRound className="size-4 text-muted-foreground" />
                    {t('sec.mfa.codes.title')}
                  </CardTitle>
                  <CardDescription>{t('sec.mfa.codes.body')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <ul className="grid grid-cols-2 gap-2 rounded-md border border-border bg-secondary/30 p-3 font-mono text-sm sm:grid-cols-3">
                    {backupCodes.map((code) => (
                      <li key={code}>{code}</li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={copyCodes}>
                      {copied ? <Check /> : <Copy />}
                      {copied ? t('sec.copied') : t('sec.mfa.codes.copy')}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={downloadCodes}>
                      <Download />
                      {t('sec.mfa.codes.download')}
                    </Button>
                    <Button type="button" size="sm" onClick={() => setBackupCodes(null)}>
                      {t('sec.mfa.codes.done')}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* ── Two-factor ── */}
            <Card>
              <CardHeader className="pb-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <ShieldCheck className="size-4 text-muted-foreground" />
                      {t('sec.mfa.title')}
                    </CardTitle>
                    <CardDescription>{t('sec.mfa.desc')}</CardDescription>
                  </div>
                  <Badge variant={mfaEnabled ? 'success' : 'outline'}>
                    {mfaEnabled ? t('sec.mfa.on') : t('sec.mfa.off')}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {!mfaEnabled && !enrolling && (
                  <Button type="button" size="sm" onClick={beginEnrollment} disabled={!!busy}>
                    {busy === 'mfa-setup' && <Spinner />}
                    {t('sec.mfa.enable')}
                  </Button>
                )}

                {enrolling && (
                  <form onSubmit={confirmEnrollment} className="space-y-4">
                    <div className="flex flex-wrap items-start gap-5">
                      <div className="rounded-md border border-border bg-white p-2">
                        {/* Plain <img>: the QR is a data: URL, so next/image's loader
                            would add nothing but indirection. */}
                        <img src={enrolling.qr} alt="" width={208} height={208} />
                      </div>
                      <div className="min-w-[16rem] flex-1 space-y-3">
                        <p className="text-sm">{t('sec.mfa.step1')}</p>
                        <div>
                          <p className="text-xs text-muted-foreground">{t('sec.mfa.manual')}</p>
                          <code className="mt-1 block break-all rounded-md border border-border bg-secondary/30 px-2 py-1.5 font-mono text-sm">
                            {groupSecret(enrolling.secret)}
                          </code>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="mfa-confirm">{t('sec.mfa.step2')}</Label>
                          <Input
                            id="mfa-confirm"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            placeholder="123456"
                            value={confirmCode}
                            onChange={(e) => setConfirmCode(e.target.value)}
                            required
                            minLength={6}
                            maxLength={8}
                          />
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button type="submit" size="sm" disabled={!!busy}>
                        {busy === 'mfa-confirm' && <Spinner />}
                        {t('sec.mfa.confirm')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setEnrolling(null)}
                      >
                        {t('sec.mfa.cancel')}
                      </Button>
                    </div>
                  </form>
                )}

                {mfaEnabled && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={regenerateCodes}
                      disabled={!!busy}
                    >
                      {busy === 'mfa-regen' && <Spinner />}
                      <KeyRound />
                      {t('sec.mfa.regen')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={disableMfa}
                      disabled={!!busy}
                    >
                      {busy === 'mfa-disable' && <Spinner />}
                      {t('sec.mfa.disable')}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {t('sec.mfa.disable.warn')}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ── Password ── */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <KeyRound className="size-4 text-muted-foreground" />
                  {t('sec.pw.title')}
                </CardTitle>
                <CardDescription>{t('sec.pw.desc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={changePassword} className="grid gap-4 sm:max-w-md">
                  <div className="space-y-2">
                    <Label htmlFor="currentPassword">{t('sec.pw.current')}</Label>
                    <Input
                      id="currentPassword"
                      name="currentPassword"
                      type="password"
                      autoComplete="current-password"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="newPassword">{t('sec.pw.new')}</Label>
                    <Input
                      id="newPassword"
                      name="newPassword"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={8}
                    />
                  </div>
                  <Button type="submit" size="sm" className="justify-self-start" disabled={!!busy}>
                    {busy === 'password' && <Spinner />}
                    {t('sec.pw.submit')}
                  </Button>
                </form>
              </CardContent>
            </Card>

            {/* ── Sessions ── */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Laptop className="size-4 text-muted-foreground" />
                  {t('sec.sessions.title')}
                </CardTitle>
                <CardDescription>{t('sec.sessions.desc')}</CardDescription>
              </CardHeader>
              <CardContent>
                {sessions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('sec.sessions.empty')}</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {sessions.map((s) => (
                      <li key={s.id} className="flex flex-wrap gap-x-6 gap-y-1 py-3 text-sm">
                        <span className="font-medium">{shortUa(s.userAgent)}</span>
                        {s.ip && (
                          <span className="text-muted-foreground">
                            {t('sec.sessions.network')}: <code className="font-mono">{s.ip}</code>
                          </span>
                        )}
                        <span className="text-muted-foreground">
                          {t('sec.sessions.created')}: {formatDate(s.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            {/* ── Devices ── */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <MonitorSmartphone className="size-4 text-muted-foreground" />
                  {t('sec.devices.title')}
                </CardTitle>
                <CardDescription>{t('sec.devices.desc')}</CardDescription>
              </CardHeader>
              <CardContent>
                {devices.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('sec.devices.empty')}</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {devices.map((d) => (
                      <li
                        key={d.id}
                        className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
                      >
                        <div className="min-w-0">
                          <p className="flex items-center gap-2 font-medium">
                            {shortUa(d.ua)}
                            {d.trusted && (
                              <Badge variant="accent">{t('sec.devices.trusted')}</Badge>
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {t('sec.devices.lastSeen')}: {formatDate(d.lastSeenAt)}
                            {d.lastIp ? ` · ${d.lastIp}` : ''}
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          title={t('sec.devices.revoke.hint')}
                          onClick={() => revokeDevice(d.id)}
                          disabled={!!busy}
                        >
                          {busy === `device-${d.id}` ? <Spinner /> : <Trash2 />}
                          {t('sec.devices.revoke')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            {/* ── Sign out everywhere ── */}
            <Card className="border-destructive/30">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <LogOut className="size-4 text-muted-foreground" />
                  {t('sec.signout.title')}
                </CardTitle>
                <CardDescription>{t('sec.signout.desc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={signOutEverywhere}
                  disabled={!!busy}
                >
                  {busy === 'signout-all' && <Spinner />}
                  {t('sec.signout.action')}
                </Button>
              </CardContent>
            </Card>
          </>
        )}
      </div>
      {passwordPrompt.element}
    </main>
  );
}
