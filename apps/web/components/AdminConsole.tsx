'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import {
  Activity,
  ListChecks,
  Plane,
  Radio,
  RefreshCw,
  ScrollText,
  ShieldAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface AdminData {
  stats: Record<string, number>;
  queues: {
    name: string;
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }[];
  providers: {
    key: string;
    name: string;
    enabled: boolean;
    health: string;
    circuitState: string;
  }[];
  flights: { flightId: string; callsign: string; status: string; flightDate: string }[];
  dlq: DlqJob[];
  logs: ProviderLog[];
  audit: AuditEntry[];
}

interface DlqJob {
  id: string;
  name: string;
  failedReason: string | null;
  attemptsMade: number;
  timestamp: number;
  data: { flightId?: string; flightNumber?: string };
}

interface ProviderLog {
  id: string;
  providerKey: string;
  operation: string;
  latencyMs: number | null;
  success: boolean;
  error: string | null;
  createdAt: string;
}

interface AuditEntry {
  id: string;
  actorType: string;
  action: string;
  entity: string | null;
  entityId: string | null;
  createdAt: string;
}

type State = 'loading' | 'unauth' | 'forbidden' | 'ready' | 'error';

export function AdminConsole() {
  const [data, setData] = useState<AdminData | null>(null);
  const [state, setState] = useState<State>('loading');

  const get = (p: string) => fetch(`${API_BASE}/api/v1/admin/${p}`, { credentials: 'include' });

  async function load() {
    setState('loading');
    try {
      const first = await get('stats');
      if (first.status === 401) return setState('unauth');
      if (first.status === 403) return setState('forbidden');
      if (!first.ok) return setState('error');
      const [stats, queues, providers, flights, dlq, logs, auditRes] = await Promise.all([
        first.json(),
        get('queues').then((r) => r.json()),
        get('providers').then((r) => r.json()),
        get('flights').then((r) => r.json()),
        get('dlq').then((r) => r.json()),
        get('logs').then((r) => r.json()),
        get('audit').then((r) => r.json()),
      ]);
      setData({
        stats: stats.data.stats,
        queues: queues.data.queues,
        providers: providers.data.providers,
        flights: flights.data.flights,
        dlq: dlq.data.jobs,
        logs: logs.data.logs,
        audit: auditRes.data.audit,
      });
      setState('ready');
    } catch {
      setState('error');
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  useEffect(() => {
    void load();
  }, []);

  async function retry(path: string) {
    await fetch(`${API_BASE}/api/v1/admin/${path}`, { method: 'POST', credentials: 'include' });
    await load();
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Operational health — queues, providers and audit.
          </p>
        </div>
        {state === 'ready' && (
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw />
            Refresh
          </Button>
        )}
      </div>

      <div className="mt-8">
        {state === 'loading' && <AdminSkeleton />}
        {state === 'unauth' && (
          <EmptyState
            icon={ShieldAlert}
            title="Sign in required"
            description="This console is only available to signed-in admins."
            action={
              <Button asChild size="sm">
                <Link href="/signin?next=/admin">Sign in</Link>
              </Button>
            }
          />
        )}
        {state === 'forbidden' && (
          <EmptyState
            icon={ShieldAlert}
            title="Admins only"
            description="Your account doesn’t have access to the admin console."
          />
        )}
        {state === 'error' && <ErrorState onRetry={load} />}
        {state === 'ready' && data && <AdminBody data={data} retry={retry} />}
      </div>
    </main>
  );
}

function AdminBody({
  data,
  retry,
}: {
  data: AdminData;
  retry: (path: string) => Promise<void>;
}) {
  return (
    <div className="space-y-6">
      {/* Platform stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Object.entries(data.stats).map(([k, v]) => (
          <Card key={k}>
            <CardContent className="p-4">
              <p className="text-2xl font-semibold tabular-nums tracking-tight">
                {v.toLocaleString()}
              </p>
              <p className="mt-0.5 text-xs capitalize text-muted-foreground">
                {k.replace(/([A-Z])/g, ' $1')}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Queues */}
        <Card>
          <SectionTitle icon={Activity}>Queues</SectionTitle>
          <CardContent>
            {data.queues.map((q) => (
              <div key={q.name} className="flex items-center justify-between gap-3 py-1">
                <span className="font-medium">{q.name}</span>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {q.waiting} waiting · {q.active} active · {q.completed} done · {q.failed} failed
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Providers */}
        <Card>
          <SectionTitle icon={Radio}>Providers</SectionTitle>
          <CardContent>
            {data.providers.length === 0 ? (
              <InlineEmpty>No providers registered.</InlineEmpty>
            ) : (
              <List>
                {data.providers.map((p) => (
                  <Row key={p.key}>
                    <span className="font-medium">{p.name}</span>
                    <Badge variant={p.enabled ? 'accent' : 'default'}>
                      {p.enabled ? 'enabled' : 'disabled'}
                    </Badge>
                    <Badge
                      variant={
                        p.health === 'up'
                          ? 'success'
                          : p.health === 'degraded'
                            ? 'warning'
                            : 'destructive'
                      }
                      className="ml-auto"
                    >
                      {p.health}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{p.circuitState}</span>
                  </Row>
                ))}
              </List>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Dead-letter queue */}
      <Card>
        <SectionTitle
          icon={ListChecks}
          action={
            data.dlq.length > 0 ? (
              <Button variant="outline" size="sm" onClick={() => retry('dlq/retry-all')}>
                Retry all
              </Button>
            ) : undefined
          }
        >
          Dead-letter queue
          <Badge variant="outline" className="tabular-nums">
            {data.dlq.length}
          </Badge>
        </SectionTitle>
        <CardContent>
          {data.dlq.length === 0 ? (
            <InlineEmpty>No failed jobs. 🎉</InlineEmpty>
          ) : (
            <List>
              {data.dlq.map((j) => (
                <Row key={j.id}>
                  <span className="font-medium">{j.data.flightNumber ?? j.name}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-destructive">
                    {j.failedReason ?? 'unknown error'}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {j.attemptsMade} attempts
                  </span>
                  <Button variant="secondary" size="sm" onClick={() => retry(`dlq/${j.id}/retry`)}>
                    Retry
                  </Button>
                </Row>
              ))}
            </List>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent flights */}
        <Card>
          <SectionTitle icon={Plane}>Recent flights</SectionTitle>
          <CardContent>
            {data.flights.length === 0 ? (
              <InlineEmpty>No flights yet.</InlineEmpty>
            ) : (
              <List>
                {data.flights.slice(0, 12).map((f) => (
                  <Row key={f.flightId}>
                    <Link
                      href={`/flights/id/${f.flightId}`}
                      className="font-medium text-accent-bright hover:underline"
                    >
                      {f.callsign}
                    </Link>
                    <Badge variant="outline" className="ml-auto capitalize">
                      {f.status}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{f.flightDate}</span>
                  </Row>
                ))}
              </List>
            )}
          </CardContent>
        </Card>

        {/* Provider logs */}
        <Card>
          <SectionTitle icon={Activity}>Provider logs</SectionTitle>
          <CardContent>
            {data.logs.length === 0 ? (
              <InlineEmpty>No provider traffic yet.</InlineEmpty>
            ) : (
              <List>
                {data.logs.slice(0, 12).map((l) => (
                  <Row key={l.id}>
                    <span className="font-medium">{l.providerKey}</span>
                    <span className="text-sm text-muted-foreground">{l.operation}</span>
                    <Badge variant={l.success ? 'success' : 'destructive'} className="ml-auto">
                      {l.success ? 'ok' : 'fail'}
                    </Badge>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {l.latencyMs != null ? `${l.latencyMs}ms` : ''}
                    </span>
                  </Row>
                ))}
              </List>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Audit */}
      <Card>
        <SectionTitle icon={ScrollText}>Audit log</SectionTitle>
        <CardContent>
          {data.audit.length === 0 ? (
            <InlineEmpty>No admin actions recorded.</InlineEmpty>
          ) : (
            <List>
              {data.audit.slice(0, 12).map((a) => (
                <Row key={a.id}>
                  <span className="font-medium">{a.action}</span>
                  <span className="text-sm text-muted-foreground">
                    {a.entity}
                    {a.entityId ? ` · ${a.entityId}` : ''}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {a.actorType} · {new Date(a.createdAt).toLocaleString()}
                  </span>
                </Row>
              ))}
            </List>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SectionTitle({
  icon: Icon,
  children,
  action,
}: {
  icon: typeof Activity;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <CardHeader className="flex-row items-center gap-2 space-y-0">
      <Icon className="size-4 text-muted-foreground" />
      <CardTitle className="flex flex-1 items-center gap-2 text-base">{children}</CardTitle>
      {action}
    </CardHeader>
  );
}

function List({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-border">{children}</div>;
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">{children}</div>;
}

function InlineEmpty({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-sm text-muted-foreground">{children}</p>;
}

function AdminSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {['s0', 's1', 's2', 's3', 's4', 's5'].map((k) => (
          <Card key={k}>
            <CardContent className="p-4">
              <Skeleton className="h-7 w-12" />
              <Skeleton className="mt-1.5 h-3 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-28" />
            </CardHeader>
            <CardContent className="space-y-3">
              {[0, 1, 2].map((j) => (
                <Skeleton key={j} className="h-6 w-full" />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
