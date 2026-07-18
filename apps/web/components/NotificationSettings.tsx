'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/states';
import { ArrowLeft, Mail, Moon, Send } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

async function api(path: string, init?: RequestInit) {
  return fetch(`${API_BASE}/api/v1${path}`, { credentials: 'include', ...init });
}

export function NotificationSettings() {
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'err' } | null>(null);
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

  async function connectTelegram() {
    const res = await api('/channels/telegram/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) return setMsg({ text: 'Telegram is not configured on the server.', tone: 'err' });
    const { deepLink } = ((await res.json()) as { data: { deepLink: string } }).data;
    window.open(deepLink, '_blank');
    setMsg({ text: 'Opened Telegram — tap Start to link your account.', tone: 'ok' });
  }

  async function connectEmail() {
    const res = await api('/channels/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const body = (await res.json()) as { data?: { sent: boolean; token?: string } };
    if (!res.ok) return setMsg({ text: 'Could not register that email.', tone: 'err' });
    setMsg({
      text: body.data?.token
        ? `Dev mode: verify at /verify-email?token=${body.data.token}`
        : 'Verification email sent — check your inbox.',
      tone: 'ok',
    });
  }

  async function saveQuietHours() {
    const res = await api('/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quietHours: { tz, start, end } }),
    });
    setMsg(
      res.ok
        ? { text: 'Quiet hours saved.', tone: 'ok' }
        : { text: 'Failed to save.', tone: 'err' },
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <Link
        href="/dashboard"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Dashboard
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Connect channels and control when alerts reach you.
      </p>

      {authed === null && (
        <div className="mt-8 space-y-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32 w-full rounded-xl" />
          ))}
        </div>
      )}

      {authed === false && (
        <div className="mt-8">
          <EmptyState
            icon={Mail}
            title="Sign in to manage notifications"
            description="Connect Telegram or email and set quiet hours once you’re signed in."
            action={
              <Button asChild size="sm">
                <Link href="/signin?next=/settings/notifications">Sign in</Link>
              </Button>
            }
          />
        </div>
      )}

      {authed === true && (
        <div className="mt-8 space-y-5">
          {msg && (
            <output
              className={
                msg.tone === 'ok'
                  ? 'block rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success'
                  : 'block rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive'
              }
            >
              {msg.text}
            </output>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Send className="size-4 text-muted-foreground" />
                Telegram
              </CardTitle>
              <CardDescription>Get instant alerts in Telegram.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={connectTelegram} variant="secondary">
                Connect Telegram
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Mail className="size-4 text-muted-foreground" />
                Email
              </CardTitle>
              <CardDescription>We’ll send a one-time verification link.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  type="email"
                  className="sm:flex-1"
                />
                <Button onClick={connectEmail} variant="secondary">
                  Send verification
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Moon className="size-4 text-muted-foreground" />
                Quiet hours
              </CardTitle>
              <CardDescription>
                Non-critical alerts are held during this window — critical ones still come through.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-[1fr_auto_auto]">
                <div className="space-y-2">
                  <Label htmlFor="tz">Timezone</Label>
                  <Input
                    id="tz"
                    value={tz}
                    onChange={(e) => setTz(e.target.value)}
                    placeholder="IANA tz"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="start">From</Label>
                  <Input
                    id="start"
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                    className="w-24"
                    placeholder="22:00"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="end">To</Label>
                  <Input
                    id="end"
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                    className="w-24"
                    placeholder="07:00"
                  />
                </div>
              </div>
              <Button onClick={saveQuietHours} className="mt-4">
                Save quiet hours
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </main>
  );
}
