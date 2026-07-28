'use client';

import { apiBase } from '@/lib/api';
import { useT } from '@/lib/i18n';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import {
  Activity,
  Globe2,
  ListChecks,
  Plane,
  Radio,
  RefreshCw,
  ScrollText,
  ShieldAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

const API_BASE = apiBase();

interface AdminData {
  stats: Record<string, number>;
  queues: {
    name: string;
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    error?: string;
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
  airspaceImports: AirspaceImports;
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

interface AirspaceImports {
  configured: boolean;
  counts: {
    waiting?: number;
    active?: number;
    completed?: number;
    failed?: number;
    delayed?: number;
  };
  jobs: AirspaceImportJob[];
  error?: string;
}

interface AirspaceImportJob {
  id: string;
  name: string;
  state: string;
  data?: { datasetVersion?: string; provider?: string; scope?: string };
  progress: unknown;
  failedReason: string | null;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
  returnvalue: unknown;
}

interface AirspaceImportProgress {
  status?: string;
  datasetVersion?: string;
  page?: number;
  totalPages?: number | null;
  totalCount?: number | null;
  pagesImported?: number;
  upserted?: number;
  invalid?: number;
  retired?: number;
  message?: string;
  updatedAt?: string;
}

type State = 'loading' | 'unauth' | 'forbidden' | 'ready' | 'error';

function fallbackData(airspaceError: string): Omit<AdminData, 'stats'> {
  return {
    queues: [],
    providers: [],
    flights: [],
    dlq: [],
    logs: [],
    audit: [],
    airspaceImports: {
      configured: false,
      counts: {},
      jobs: [],
      error: airspaceError,
    },
  };
}

async function readAdminData<T>(response: Promise<Response>, fallback: T): Promise<T> {
  try {
    const res = await response;
    if (!res.ok) return fallback;
    const body = (await res.json().catch(() => null)) as { data?: T } | null;
    return body?.data ?? fallback;
  } catch {
    return fallback;
  }
}

async function responseErrorMessage(
  res: Response,
  t: (key: string, vars?: Record<string, string | number>) => string,
): Promise<string> {
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: string };
    message?: string;
  } | null;
  return body?.error?.message ?? body?.message ?? t('admin.requestFailed', { status: res.status });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function AdminConsole() {
  const t = useT();
  const [data, setData] = useState<AdminData | null>(null);
  const [state, setState] = useState<State>('loading');
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const get = (p: string) => fetch(`${API_BASE}/api/v1/admin/${p}`, { credentials: 'include' });

  async function load(opts: { silent?: boolean } = {}) {
    if (!opts.silent) setState('loading');
    try {
      const first = await get('stats');
      if (first.status === 401) return setState('unauth');
      if (first.status === 403) return setState('forbidden');
      if (!first.ok) return setState('error');
      const stats = (await first.json().catch(() => null)) as {
        data?: { stats?: Record<string, number> };
      } | null;
      if (!stats?.data?.stats) return setState('error');
      const fallback = fallbackData(t('admin.airspaceUnavailable'));
      const [queues, providers, flights, dlq, logs, auditRes, airspaceImports] = await Promise.all([
        readAdminData<{ queues: AdminData['queues'] }>(get('queues'), {
          queues: fallback.queues,
        }),
        readAdminData<{ providers: AdminData['providers'] }>(get('providers'), {
          providers: fallback.providers,
        }),
        readAdminData<{ flights: AdminData['flights'] }>(get('flights'), {
          flights: fallback.flights,
        }),
        readAdminData<{ jobs: AdminData['dlq'] }>(get('dlq'), { jobs: fallback.dlq }),
        readAdminData<{ logs: AdminData['logs'] }>(get('logs'), { logs: fallback.logs }),
        readAdminData<{ audit: AdminData['audit'] }>(get('audit'), { audit: fallback.audit }),
        readAdminData<AirspaceImports>(get('airspace/imports'), fallback.airspaceImports),
      ]);
      setData({
        stats: stats.data.stats,
        queues: queues.queues,
        providers: providers.providers,
        flights: flights.flights,
        dlq: dlq.jobs,
        logs: logs.logs,
        audit: auditRes.audit,
        airspaceImports,
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: poll while the admin-triggered job is active
  useEffect(() => {
    const active = data?.airspaceImports.jobs.some((j) =>
      ['active', 'waiting', 'delayed'].includes(j.state),
    );
    if (state !== 'ready' || !active) return;
    const id = window.setInterval(() => void load({ silent: true }), 5000);
    return () => window.clearInterval(id);
  }, [state, data?.airspaceImports.jobs]);

  async function retry(path: string) {
    await fetch(`${API_BASE}/api/v1/admin/${path}`, { method: 'POST', credentials: 'include' });
    await load();
  }

  async function startAirspaceImport() {
    setActionBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/airspace/imports/openaip-global`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        setActionError(await responseErrorMessage(res, t));
        return;
      }
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('admin.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('admin.subtitle')}</p>
        </div>
        {state === 'ready' && (
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw />
            {t('admin.refresh')}
          </Button>
        )}
      </div>

      <div className="mt-8">
        {state === 'loading' && <AdminSkeleton />}
        {state === 'unauth' && (
          <EmptyState
            icon={ShieldAlert}
            title={t('admin.signinTitle')}
            description={t('admin.signinBody')}
            action={
              <Button asChild size="sm">
                <Link href="/signin?next=/admin">{t('nav.signin')}</Link>
              </Button>
            }
          />
        )}
        {state === 'forbidden' && (
          <EmptyState
            icon={ShieldAlert}
            title={t('admin.forbiddenTitle')}
            description={t('admin.forbiddenBody')}
          />
        )}
        {state === 'error' && <ErrorState onRetry={load} />}
        {state === 'ready' && data && (
          <AdminBody
            data={data}
            retry={retry}
            startAirspaceImport={startAirspaceImport}
            actionBusy={actionBusy}
            actionError={actionError}
          />
        )}
      </div>
    </main>
  );
}

function AdminBody({
  data,
  retry,
  startAirspaceImport,
  actionBusy,
  actionError,
}: {
  data: AdminData;
  retry: (path: string) => Promise<void>;
  startAirspaceImport: () => Promise<void>;
  actionBusy: boolean;
  actionError: string | null;
}) {
  const t = useT();
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

      <AirspaceImportPanel
        imports={data.airspaceImports}
        onStart={startAirspaceImport}
        busy={actionBusy}
        actionError={actionError}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Queues */}
        <Card>
          <SectionTitle icon={Activity}>{t('admin.queues')}</SectionTitle>
          <CardContent>
            {data.queues.map((q) => (
              <div key={q.name} className="flex items-center justify-between gap-3 py-1">
                <span className="shrink-0 font-medium">{q.name}</span>
                <span className="min-w-0 text-right text-sm tabular-nums text-muted-foreground">
                  {q.error
                    ? q.error
                    : t('admin.queueCounts', {
                        waiting: q.waiting,
                        active: q.active,
                        completed: q.completed,
                        failed: q.failed,
                      })}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Providers */}
        <Card>
          <SectionTitle icon={Radio}>{t('admin.providers')}</SectionTitle>
          <CardContent>
            {data.providers.length === 0 ? (
              <InlineEmpty>{t('admin.noProviders')}</InlineEmpty>
            ) : (
              <List>
                {data.providers.map((p) => (
                  <Row key={p.key}>
                    <span className="font-medium">{p.name}</span>
                    <Badge variant={p.enabled ? 'accent' : 'default'}>
                      {p.enabled ? t('admin.enabled') : t('admin.disabled')}
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
                {t('admin.retryAll')}
              </Button>
            ) : undefined
          }
        >
          {t('admin.dlq')}
          <Badge variant="outline" className="tabular-nums">
            {data.dlq.length}
          </Badge>
        </SectionTitle>
        <CardContent>
          {data.dlq.length === 0 ? (
            <InlineEmpty>{t('admin.noFailedJobs')}</InlineEmpty>
          ) : (
            <List>
              {data.dlq.map((j) => (
                <Row key={j.id}>
                  <span className="font-medium">{j.data.flightNumber ?? j.name}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-destructive">
                    {j.failedReason ?? t('admin.unknownError')}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {t('admin.attempts', { n: j.attemptsMade })}
                  </span>
                  <Button variant="secondary" size="sm" onClick={() => retry(`dlq/${j.id}/retry`)}>
                    {t('common.retry')}
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
          <SectionTitle icon={Plane}>{t('aircraft.recentFlights')}</SectionTitle>
          <CardContent>
            {data.flights.length === 0 ? (
              <InlineEmpty>{t('admin.noFlights')}</InlineEmpty>
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
          <SectionTitle icon={Activity}>{t('admin.providerLogs')}</SectionTitle>
          <CardContent>
            {data.logs.length === 0 ? (
              <InlineEmpty>{t('admin.noProviderTraffic')}</InlineEmpty>
            ) : (
              <List>
                {data.logs.slice(0, 12).map((l) => (
                  <Row key={l.id}>
                    <span className="font-medium">{l.providerKey}</span>
                    <span className="text-sm text-muted-foreground">{l.operation}</span>
                    <Badge variant={l.success ? 'success' : 'destructive'} className="ml-auto">
                      {l.success ? t('admin.logOk') : t('admin.logFail')}
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
        <SectionTitle icon={ScrollText}>{t('admin.auditLog')}</SectionTitle>
        <CardContent>
          {data.audit.length === 0 ? (
            <InlineEmpty>{t('admin.noAudit')}</InlineEmpty>
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

function airspaceProgress(job: AirspaceImportJob | undefined): AirspaceImportProgress | null {
  const raw = job?.returnvalue && job.state === 'completed' ? job.returnvalue : job?.progress;
  return raw && typeof raw === 'object' ? (raw as AirspaceImportProgress) : null;
}

function AirspaceImportPanel({
  imports,
  onStart,
  busy,
  actionError,
}: {
  imports: AirspaceImports;
  onStart: () => Promise<void>;
  busy: boolean;
  actionError: string | null;
}) {
  const t = useT();
  const latest = imports.jobs[0];
  const progress = airspaceProgress(latest);
  const running = imports.jobs.some((j) => ['active', 'waiting', 'delayed'].includes(j.state));
  const totalPages = progress?.totalPages ?? null;
  const pagesImported = progress?.pagesImported ?? 0;
  const percent = totalPages ? Math.min(100, Math.round((pagesImported / totalPages) * 100)) : 0;
  const datasetVersion =
    latest?.data?.datasetVersion ?? progress?.datasetVersion ?? t('admin.unknownDataset');

  return (
    <Card>
      <SectionTitle
        icon={Globe2}
        action={
          <Button
            variant="outline"
            size="sm"
            disabled={!imports.configured || running || busy || Boolean(imports.error)}
            onClick={onStart}
          >
            <RefreshCw />
            {running ? t('admin.importRunning') : t('admin.startGlobalImport')}
          </Button>
        }
      >
        {t('admin.airspaceImport')}
        <Badge
          variant={running ? 'warning' : latest?.state === 'failed' ? 'destructive' : 'outline'}
        >
          {running ? t('admin.running') : (latest?.state ?? t('admin.idle'))}
        </Badge>
      </SectionTitle>
      <CardContent>
        {imports.error ? (
          <InlineEmpty>{imports.error}</InlineEmpty>
        ) : actionError ? (
          <InlineEmpty>{actionError}</InlineEmpty>
        ) : !imports.configured ? (
          <InlineEmpty>{t('admin.notConfigured')}</InlineEmpty>
        ) : !latest ? (
          <InlineEmpty>{t('admin.noImportYet')}</InlineEmpty>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{datasetVersion}</span>
              <span className="text-muted-foreground">
                {progress?.message ?? latest.failedReason ?? latest.state}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded bg-muted">
              <div className="h-full bg-accent-bright" style={{ width: `${percent}%` }} />
            </div>
            <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-5">
              <span className="tabular-nums">
                {t('admin.pages')} {pagesImported}
                {totalPages ? `/${totalPages}` : ''}
              </span>
              <span className="tabular-nums">
                {(progress?.totalCount ?? 0).toLocaleString()} {t('admin.total')}
              </span>
              <span className="tabular-nums">
                {(progress?.upserted ?? 0).toLocaleString()} {t('admin.upserted')}
              </span>
              <span className="tabular-nums">
                {(progress?.invalid ?? 0).toLocaleString()} {t('admin.invalid')}
              </span>
              <span className="tabular-nums">
                {(progress?.retired ?? 0).toLocaleString()} {t('admin.retired')}
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
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
