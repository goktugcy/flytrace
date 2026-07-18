'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Bell, Eye, Radio, Star } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

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
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your watched flights, alerts and channels.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/notifications">Notification settings</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/map">Live map</Link>
          </Button>
        </div>
      </div>

      <div className="mt-8">
        {state === 'loading' && <DashboardSkeleton />}

        {state === 'unauth' && (
          <EmptyState
            icon={Eye}
            title="Sign in to see your dashboard"
            description="Watched flights, notifications and connected channels live here."
            action={
              <Button asChild size="sm">
                <Link href="/signin?next=/dashboard">Sign in</Link>
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
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat icon={Eye} label="Watching" value={data.watchlist.length} />
        <Stat icon={Bell} label="Notifications" value={data.notifications.length} />
        <Stat icon={Radio} label="Channels" value={data.channels.length} />
        <Stat icon={Star} label="Favorites" value={data.favorites.length} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Watching</CardTitle>
        </CardHeader>
        <CardContent>
          {data.watchlist.length === 0 ? (
            <InlineEmpty>No watched flights yet. Open a flight and tap Watch.</InlineEmpty>
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
          <CardTitle>Recent notifications</CardTitle>
        </CardHeader>
        <CardContent>
          {data.notifications.length === 0 ? (
            <InlineEmpty>No notifications yet.</InlineEmpty>
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
          <CardTitle>Channels</CardTitle>
        </CardHeader>
        <CardContent>
          {data.channels.length === 0 ? (
            <InlineEmpty>No channels connected.</InlineEmpty>
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
