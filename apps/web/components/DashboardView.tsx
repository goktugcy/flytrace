'use client';

import { apiBase } from '@/lib/api';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useT } from '@/lib/i18n';
import { Bell, Eye, Radio, Star } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

const API_BASE = apiBase();

interface Dashboard {
  watchlist: { id: string; flightId: string | null; eventTypes: string[]; channels: string[] }[];
  notifications: { id: string; title: string; body: string; status: string; createdAt: string }[];
  favorites: { id: string; kind: string; ref: unknown }[];
  channels: { id: string; channel: string; verified: boolean; enabled: boolean; label: string }[];
}

type State = 'loading' | 'unauth' | 'ready' | 'error';

export function DashboardView() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [state, setState] = useState<State>('loading');
  const t = useT();

  async function load() {
    setState('loading');
    try {
      const res = await fetch(`${API_BASE}/api/v1/dashboard`, { credentials: 'include' });
      if (res.status === 401) return setState('unauth');
      if (!res.ok) return setState('error');
      setData(((await res.json()) as { data: Dashboard }).data);
      setState('ready');
    } catch {
      setState('error');
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  useEffect(() => {
    void load();
  }, []);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('dash.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('dash.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/notifications">{t('dash.settings')}</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/security">{t('sec.title')}</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/map">{t('dash.liveMap')}</Link>
          </Button>
        </div>
      </div>

      <div className="mt-8">
        {state === 'loading' && <DashboardSkeleton />}

        {state === 'unauth' && (
          <EmptyState
            icon={Eye}
            title={t('dash.signinTitle')}
            description={t('dash.signinBody')}
            action={
              <Button asChild size="sm">
                <Link href="/signin?next=/dashboard">{t('nav.signin')}</Link>
              </Button>
            }
          />
        )}

        {state === 'error' && <ErrorState onRetry={load} />}

        {state === 'ready' && data && <DashboardBody data={data} />}
      </div>
    </main>
  );
}

function DashboardBody({ data }: { data: Dashboard }) {
  const t = useT();
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat icon={Eye} label={t('dash.watching')} value={data.watchlist.length} />
        <Stat icon={Bell} label={t('dash.notifications')} value={data.notifications.length} />
        <Stat icon={Radio} label={t('dash.channels')} value={data.channels.length} />
        <Stat icon={Star} label={t('dash.favorites')} value={data.favorites.length} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('dash.watching')}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.watchlist.length === 0 ? (
            <InlineEmpty>{t('dash.empty.watch')}</InlineEmpty>
          ) : (
            <List>
              {data.watchlist.map((w) => (
                <Row key={w.id}>
                  {w.flightId ? (
                    <Link
                      href={`/flights/id/${w.flightId}`}
                      className="font-medium text-accent-bright hover:underline"
                    >
                      {w.flightId.slice(0, 8)}
                    </Link>
                  ) : (
                    <span className="font-medium">Matcher rule</span>
                  )}
                  <span className="ml-auto hidden text-sm text-muted-foreground sm:inline">
                    {w.eventTypes.join(', ')}
                  </span>
                  <div className="flex gap-1">
                    {w.channels.map((ch) => (
                      <Badge key={ch} variant="outline">
                        {ch}
                      </Badge>
                    ))}
                  </div>
                </Row>
              ))}
            </List>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('dash.recentNotif')}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.notifications.length === 0 ? (
            <InlineEmpty>{t('dash.empty.notif')}</InlineEmpty>
          ) : (
            <List>
              {data.notifications.map((n) => (
                <Row key={n.id} className="items-start">
                  <div className="min-w-0">
                    <p className="font-medium">{n.title}</p>
                    <p className="truncate text-sm text-muted-foreground">{n.body}</p>
                  </div>
                  <StatusBadge className="ml-auto" status={n.status} />
                </Row>
              ))}
            </List>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('dash.channels')}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.channels.length === 0 ? (
            <InlineEmpty>{t('dash.empty.channels')}</InlineEmpty>
          ) : (
            <List>
              {data.channels.map((ch) => (
                <Row key={ch.id}>
                  <span className="font-medium capitalize">{ch.channel}</span>
                  <span className="text-sm text-muted-foreground">{ch.label}</span>
                  <Badge className="ml-auto" variant={ch.verified ? 'success' : 'warning'}>
                    {ch.verified ? 'verified' : 'pending'}
                  </Badge>
                </Row>
              ))}
            </List>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Eye;
  label: string;
  value: number;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <Icon className="size-4 text-muted-foreground" />
        <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status, className }: { status: string; className?: string }) {
  const variant =
    status === 'sent' || status === 'delivered'
      ? 'success'
      : status === 'failed'
        ? 'destructive'
        : 'default';
  return (
    <Badge variant={variant} className={className}>
      {status}
    </Badge>
  );
}

function List({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-border">{children}</div>;
}

function Row({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex items-center gap-3 py-3 first:pt-0 last:pb-0 ${className ?? ''}`}>
      {children}
    </div>
  );
}

function InlineEmpty({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-sm text-muted-foreground">{children}</p>;
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i}>
            <CardContent className="p-4">
              <Skeleton className="size-4" />
              <Skeleton className="mt-2 h-7 w-10" />
              <Skeleton className="mt-1.5 h-3 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
      {[0, 1].map((i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
          </CardHeader>
          <CardContent className="space-y-3">
            {[0, 1, 2].map((j) => (
              <Skeleton key={j} className="h-6 w-full" />
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
