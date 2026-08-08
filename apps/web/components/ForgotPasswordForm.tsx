'use client';

import { apiBase } from '@/lib/api';
import { useT } from '@/lib/i18n';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/states';
import { AlertTriangle, MailCheck } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';

const API_BASE = apiBase();

export function ForgotPasswordForm() {
  const t = useT();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get('email') ?? '');
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/auth/password/forgot`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      // The API answers identically for known and unknown addresses, so the
      // confirmation below must not depend on which it was. Only a genuine
      // transport/rate-limit failure is worth surfacing.
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md items-center px-4">
      <Card className="w-full">
        {sent ? (
          <>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <MailCheck className="size-4 text-muted-foreground" />
                {t('pwreset.forgot.sent.title')}
              </CardTitle>
              <CardDescription>{t('pwreset.forgot.sent.body')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild size="sm" variant="outline">
                <Link href="/signin">{t('pwreset.back')}</Link>
              </Button>
            </CardContent>
          </>
        ) : (
          <>
            <CardHeader>
              <CardTitle className="text-base">{t('pwreset.forgot.title')}</CardTitle>
              <CardDescription>{t('pwreset.forgot.body')}</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} className="grid gap-4">
                {error && (
                  <p
                    role="alert"
                    className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  >
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    {error}
                  </p>
                )}
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    autoFocus
                  />
                </div>
                <Button type="submit" size="sm" disabled={busy}>
                  {busy && <Spinner />}
                  {t('pwreset.forgot.submit')}
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
