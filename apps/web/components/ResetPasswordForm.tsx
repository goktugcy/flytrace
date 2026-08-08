'use client';

import { apiBase } from '@/lib/api';
import { useT } from '@/lib/i18n';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/states';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';

const API_BASE = apiBase();

export function ResetPasswordForm() {
  const t = useT();
  const params = useSearchParams();
  const token = params.get('token');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const newPassword = String(form.get('newPassword') ?? '');
    const confirm = String(form.get('confirm') ?? '');

    if (newPassword !== confirm) {
      setError(t('pwreset.reset.mismatch'));
      return;
    }
    if (!token) {
      setError(t('pwreset.reset.missing'));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/auth/password/reset`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, newPassword }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md items-center px-4">
      <Card className="w-full">
        {done ? (
          <>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <CheckCircle2 className="size-4 text-success" />
                {t('pwreset.reset.done.title')}
              </CardTitle>
              <CardDescription>{t('pwreset.reset.done.body')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild size="sm">
                <Link href="/signin">{t('pwreset.back')}</Link>
              </Button>
            </CardContent>
          </>
        ) : (
          <>
            <CardHeader>
              <CardTitle className="text-base">{t('pwreset.reset.title')}</CardTitle>
              <CardDescription>{t('pwreset.reset.body')}</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} className="grid gap-4">
                {(error || !token) && (
                  <p
                    role="alert"
                    className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  >
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    {error ?? t('pwreset.reset.missing')}
                  </p>
                )}
                <div className="space-y-2">
                  <Label htmlFor="newPassword">{t('pwreset.reset.new')}</Label>
                  <Input
                    id="newPassword"
                    name="newPassword"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirm">{t('pwreset.reset.confirm')}</Label>
                  <Input
                    id="confirm"
                    name="confirm"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                  />
                </div>
                <Button type="submit" size="sm" disabled={busy || !token}>
                  {busy && <Spinner />}
                  {t('pwreset.reset.submit')}
                </Button>
                <Link
                  href="/signin"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  {t('pwreset.back')}
                </Link>
              </form>
            </CardContent>
          </>
        )}
      </Card>
    </main>
  );
}
