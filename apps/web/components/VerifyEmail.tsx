'use client';

import { apiBase } from '@/lib/api';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/states';
import { useT } from '@/lib/i18n';
import { CheckCircle2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

const API_BASE = apiBase();

export function VerifyEmail({ token }: { token: string }) {
  const t = useT();
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
    <main className="mx-auto flex min-h-[calc(100dvh-3.5rem)] max-w-md flex-col justify-center px-4 py-12 sm:px-6">
      <Card>
        <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
          {state === 'working' && (
            <>
              <Spinner className="size-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t('verify.verifying')}</p>
            </>
          )}

          {state === 'ok' && (
            <>
              <div className="flex size-12 items-center justify-center rounded-full bg-success/15 text-success">
                <CheckCircle2 className="size-6" />
              </div>
              <div className="space-y-1">
                <h1 className="text-lg font-semibold">{t('verify.verified')}</h1>
                <p className="text-sm text-muted-foreground">{t('verify.okBody')}</p>
              </div>
              <Button asChild size="sm">
                <Link href="/dashboard">{t('landing.cta.dashboard')}</Link>
              </Button>
            </>
          )}

          {state === 'fail' && (
            <>
              <div className="flex size-12 items-center justify-center rounded-full bg-destructive/15 text-destructive">
                <XCircle className="size-6" />
              </div>
              <div className="space-y-1">
                <h1 className="text-lg font-semibold">{t('verify.failed')}</h1>
                <p className="text-sm text-muted-foreground">{t('verify.invalid')}</p>
              </div>
              <Button asChild size="sm" variant="outline">
                <Link href="/settings/notifications">{t('common.retry')}</Link>
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
