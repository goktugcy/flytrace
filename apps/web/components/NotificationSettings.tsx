'use client';

import { apiBase } from '@/lib/api';
import { cn } from '@/lib/utils';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  BellRing,
  CheckCircle2,
  Clock3,
  Eye,
  Loader2,
  Mail,
  MessageCircle,
  Moon,
  Plane,
  Power,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  Trash2,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

const API_BASE = apiBase();
const CHANNELS = ['webpush', 'telegram', 'email'] as const;
const EVENT_ORDER = [
  'takeoff',
  'top_of_climb',
  'top_of_descent',
  'landing',
  'flight_ended',
  'delay',
  'gate_change',
  'cancelled',
  'arrived',
  'entered_airspace',
] as const;

type ChannelKey = (typeof CHANNELS)[number];
type VisibleEventType = (typeof EVENT_ORDER)[number];
type State = 'loading' | 'unauth' | 'ready' | 'error';

interface QuietHours {
  tz: string;
  start: string;
  end: string;
}

interface SettingsData {
  quietHours?: QuietHours | null;
  defaultChannels?: unknown;
}

interface ChannelItem {
  id: string;
  channel: ChannelKey | string;
  verified: boolean;
  enabled: boolean;
  label: string;
  createdAt?: string;
}

interface WatchItem {
  id: string;
  flightId: string | null;
  eventTypes: string[];
  channels: string[];
  active: boolean;
  createdAt?: string;
}

interface NotificationItem {
  id: string;
  channel: string;
  status: string;
  title: string;
  body: string;
  error?: string | null;
  flightId?: string | null;
  createdAt: string;
  sentAt?: string | null;
}

interface DashboardData {
  watchlist: WatchItem[];
  notifications: NotificationItem[];
  favorites: unknown[];
  channels: ChannelItem[];
}

const EVENT_LABELS: Record<string, string> = {
  takeoff: 'Takeoff',
  top_of_climb: 'Cruise reached',
  top_of_descent: 'Descent started',
  landing: 'Landing',
  flight_ended: 'Flight ended',
  delay: 'Delay',
  gate_change: 'Gate change',
  cancelled: 'Cancelled',
  arrived: 'Arrived',
  entered_airspace: 'Airspace',
};

const EVENT_GROUPS: {
  id: string;
  label: string;
  events: VisibleEventType[];
  critical?: boolean;
}[] = [
  {
    id: 'phase',
    label: 'Flight phase',
    events: ['takeoff', 'top_of_climb', 'top_of_descent', 'landing', 'flight_ended'],
  },
  {
    id: 'ops',
    label: 'Operational',
    events: ['delay', 'gate_change', 'cancelled', 'arrived'],
    critical: true,
  },
  { id: 'airspace', label: 'Airspace', events: ['entered_airspace'] },
];

const CHANNEL_META: Record<
  ChannelKey,
  { title: string; label: string; icon: LucideIcon; description: string }
> = {
  webpush: {
    title: 'Browser push',
    label: 'Push',
    icon: Smartphone,
    description: 'Device-level alerts',
  },
  telegram: {
    title: 'Telegram',
    label: 'Telegram',
    icon: MessageCircle,
    description: 'Instant bot messages',
  },
  email: {
    title: 'Email',
    label: 'Email',
    icon: Mail,
    description: 'Verified inbox delivery',
  },
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api/v1${path}`, { credentials: 'include', ...init });
  const body = (await res.json().catch(() => ({}))) as {
    data?: T;
    error?: { message?: string; code?: string };
  };
  if (!res.ok) throw new Error(body.error?.message ?? body.error?.code ?? `HTTP ${res.status}`);
  return body.data as T;
}

export function NotificationSettings() {
  const [state, setState] = useState<State>('loading');
  const [data, setData] = useState<DashboardData | null>(null);
  const [webPushKey, setWebPushKey] = useState<string | null>(null);
  const [pushPermission, setPushPermission] = useState<NotificationPermission | 'unsupported'>(
    'default',
  );
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'err' } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tz, setTz] = useState('Europe/Istanbul');
  const [start, setStart] = useState('22:00');
  const [end, setEnd] = useState('07:00');
  const [quietEnabled, setQuietEnabled] = useState(true);
  const [defaultChannels, setDefaultChannels] = useState<ChannelKey[]>(['webpush']);
  const [email, setEmail] = useState('');

  async function refreshData() {
    const [dashboard, settingsEnvelope, webPushConfig] = await Promise.all([
      api<DashboardData>('/dashboard'),
      api<{ settings: SettingsData }>('/settings'),
      api<{ publicKey: string | null }>('/config/webpush'),
    ]);
    setData(dashboard);
    setWebPushKey(webPushConfig.publicKey);
    setPushPermission(readPushPermission());

    const settings = settingsEnvelope.settings ?? {};
    const quiet = settings.quietHours ?? null;
    setQuietEnabled(Boolean(quiet));
    setTz(quiet?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Europe/Istanbul');
    setStart(quiet?.start ?? '22:00');
    setEnd(quiet?.end ?? '07:00');
    const defaults = normalizeChannels(settings.defaultChannels);
    setDefaultChannels(defaults.length > 0 ? defaults : ['webpush']);
  }

  async function load() {
    setState('loading');
    try {
      const session = await fetch(`${API_BASE}/api/auth/session`, { credentials: 'include' });
      const user = ((await session.json()) as { data?: { user?: unknown } }).data?.user;
      if (!user) {
        setState('unauth');
        return;
      }
      await refreshData();
      setState('ready');
    } catch {
      setState('error');
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  useEffect(() => {
    void load();
  }, []);

  const stats = useMemo(() => buildStats(data), [data]);
  const channelGroups = useMemo(() => groupChannels(data?.channels ?? []), [data]);
  const pushSupport = getPushSupport();

  async function connectTelegram() {
    await runAction('telegram', async () => {
      const { deepLink } = await api<{ deepLink: string }>('/channels/telegram/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      window.open(deepLink, '_blank', 'noopener,noreferrer');
      setMsg({ text: 'Telegram link created. Finish the link in Telegram.', tone: 'ok' });
      await refreshData();
    });
  }

  async function connectEmail() {
    const trimmed = email.trim();
    if (!trimmed) {
      setMsg({ text: 'Enter an email address first.', tone: 'err' });
      return;
    }
    await runAction('email', async () => {
      const body = await api<{ sent: boolean; token?: string }>('/channels/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: trimmed }),
      });
      setMsg({
        text: body.token
          ? `Dev verification token: ${body.token}`
          : body.sent
            ? 'Verification email sent.'
            : 'Email channel saved, but the provider is not configured.',
        tone: body.sent || body.token ? 'ok' : 'err',
      });
      setEmail('');
      await refreshData();
    });
  }

  async function connectWebPush() {
    await runAction('webpush', async () => {
      const hasDisabledEndpoint = channelGroups.webpush.some(
        (channel) => channel.verified && !channel.enabled,
      );
      await subscribeWebPush({ forceRenew: hasDisabledEndpoint });
      setMsg({ text: 'Browser push is connected on this device.', tone: 'ok' });
      await refreshData();
    });
  }

  async function testWebPush() {
    await runAction('webpush:test', async () => {
      const hasReadyEndpoint = channelGroups.webpush.some(
        (channel) => channel.verified && channel.enabled,
      );
      if (!hasReadyEndpoint) await subscribeWebPush({ forceRenew: true });
      await showLocalWebPushTest();
      try {
        const result = await api<{ sent: number; failed: number }>('/channels/webpush/test', {
          method: 'POST',
        });
        setMsg({
          text:
            result.failed > 0
              ? `Chrome accepted the local test. Server push reached ${result.sent} endpoint(s); ${result.failed} failed.`
              : `Chrome accepted the local test. Server push reached ${result.sent} endpoint(s).`,
          tone: result.failed > 0 ? 'err' : 'ok',
        });
      } finally {
        await refreshData();
      }
    });
  }

  async function savePreferences() {
    if (defaultChannels.length === 0) {
      setMsg({ text: 'Choose at least one default channel.', tone: 'err' });
      return;
    }
    await runAction('preferences', async () => {
      await api<{ ok: true }>('/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          quietHours: quietEnabled ? { tz, start, end } : null,
          defaultChannels,
        }),
      });
      setMsg({ text: 'Notification preferences saved.', tone: 'ok' });
      await refreshData();
    });
  }

  async function updateChannel(id: string, enabled: boolean) {
    await runAction(`channel:${id}`, async () => {
      await api<{ ok: true }>(`/channels/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      await refreshData();
    });
  }

  async function deleteChannel(id: string) {
    await runAction(`channel:${id}`, async () => {
      await api<{ ok: true }>(`/channels/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await refreshData();
    });
  }

  async function updateWatch(
    id: string,
    patch: Partial<Pick<WatchItem, 'active' | 'channels' | 'eventTypes'>>,
  ) {
    await runAction(`watch:${id}`, async () => {
      await api<{ ok: true }>(`/watchlist/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      await refreshData();
    });
  }

  async function deleteWatch(id: string) {
    await runAction(`watch:${id}`, async () => {
      await api<{ ok: true }>(`/watchlist/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await refreshData();
    });
  }

  async function runAction(key: string, action: () => Promise<void>) {
    setBusy(key);
    setMsg(null);
    try {
      await action();
    } catch (err) {
      setMsg({
        text: err instanceof Error ? err.message : 'Action failed.',
        tone: 'err',
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            Dashboard
          </Link>
          <h1 className="mt-5 text-2xl font-semibold tracking-tight">Notifications</h1>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={load}>
          <RefreshCw />
          Refresh
        </Button>
      </div>

      <div className="mt-8">
        {state === 'loading' && <NotificationSkeleton />}

        {state === 'unauth' && (
          <EmptyState
            icon={Bell}
            title="Sign in to manage notifications"
            description="Watched flights, channels and alert history live here."
            action={
              <Button asChild size="sm">
                <Link href="/signin?next=/settings/notifications">Sign in</Link>
              </Button>
            }
          />
        )}

        {state === 'error' && <ErrorState onRetry={load} />}

        {state === 'ready' && data && (
          <div className="space-y-6">
            {msg && (
              <output
                className={cn(
                  'block rounded-md border px-3 py-2 text-sm',
                  msg.tone === 'ok'
                    ? 'border-success/30 bg-success/10 text-success'
                    : 'border-destructive/30 bg-destructive/10 text-destructive',
                )}
              >
                {msg.text}
              </output>
            )}

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat icon={Eye} label="Active watches" value={stats.activeWatches} />
              <Stat icon={ShieldCheck} label="Ready channels" value={stats.readyChannels} />
              <Stat icon={BellRing} label="Sent alerts" value={stats.sentNotifications} />
              <Stat icon={AlertTriangle} label="Needs attention" value={stats.needsAttention} />
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <ChannelPanel
                kind="webpush"
                channels={channelGroups.webpush}
                busy={busy}
                status={
                  webPushKey
                    ? pushSupport.supported
                      ? pushPermission
                      : 'unsupported'
                    : 'not_configured'
                }
                onConnect={connectWebPush}
                onTest={testWebPush}
                onToggle={updateChannel}
                onDelete={deleteChannel}
              />
              <ChannelPanel
                kind="telegram"
                channels={channelGroups.telegram}
                busy={busy}
                status="available"
                onConnect={connectTelegram}
                onToggle={updateChannel}
                onDelete={deleteChannel}
              />
              <ChannelPanel
                kind="email"
                channels={channelGroups.email}
                busy={busy}
                status="available"
                email={email}
                onEmailChange={setEmail}
                onConnect={connectEmail}
                onToggle={updateChannel}
                onDelete={deleteChannel}
              />
            </div>

            <PreferencesPanel
              quietEnabled={quietEnabled}
              setQuietEnabled={setQuietEnabled}
              tz={tz}
              setTz={setTz}
              start={start}
              setStart={setStart}
              end={end}
              setEnd={setEnd}
              defaultChannels={defaultChannels}
              setDefaultChannels={setDefaultChannels}
              channelGroups={channelGroups}
              busy={busy}
              onSave={savePreferences}
            />

            <WatchlistPanel
              watches={data.watchlist}
              channelGroups={channelGroups}
              busy={busy}
              onUpdate={updateWatch}
              onDelete={deleteWatch}
            />

            <HistoryPanel notifications={data.notifications} />
          </div>
        )}
      </div>
    </main>
  );
}

function ChannelPanel({
  kind,
  channels,
  status,
  busy,
  email,
  onEmailChange,
  onConnect,
  onTest,
  onToggle,
  onDelete,
}: {
  kind: ChannelKey;
  channels: ChannelItem[];
  status: NotificationPermission | 'unsupported' | 'not_configured' | 'available';
  busy: string | null;
  email?: string;
  onEmailChange?: (value: string) => void;
  onConnect: () => void;
  onTest?: () => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const meta = CHANNEL_META[kind];
  const ready = channels.some((ch) => ch.verified && ch.enabled);
  const pending = channels.some((ch) => !ch.verified);
  const Icon = meta.icon;
  const connectBusy = busy === kind;
  const testBusy = busy === `${kind}:test`;

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Icon className="size-4 text-muted-foreground" />
              {meta.title}
            </CardTitle>
            <CardDescription>{meta.description}</CardDescription>
          </div>
          <StatusBadge status={ready ? 'ready' : pending ? 'pending' : status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {kind === 'email' ? (
          <div className="flex flex-col gap-2 sm:flex-row lg:flex-col xl:flex-row">
            <Input
              value={email ?? ''}
              onChange={(event) => onEmailChange?.(event.target.value)}
              placeholder="you@example.com"
              type="email"
              className="min-w-0"
            />
            <Button type="button" variant="secondary" onClick={onConnect} disabled={connectBusy}>
              {connectBusy ? <Loader2 className="animate-spin" /> : <Send />}
              Verify
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant={ready ? 'outline' : 'secondary'}
              onClick={onConnect}
              disabled={connectBusy || status === 'unsupported' || status === 'not_configured'}
            >
              {connectBusy ? (
                <Loader2 className="animate-spin" />
              ) : ready ? (
                <CheckCircle2 />
              ) : (
                <Send />
              )}
              {ready ? 'Add another endpoint' : 'Connect'}
            </Button>
            {kind === 'webpush' && (
              <Button
                type="button"
                variant="outline"
                onClick={onTest}
                disabled={
                  testBusy ||
                  status === 'unsupported' ||
                  status === 'not_configured' ||
                  status === 'denied'
                }
                title="Send a browser push test"
              >
                {testBusy ? <Loader2 className="animate-spin" /> : <BellRing />}
                Test
              </Button>
            )}
          </div>
        )}

        {channels.length === 0 ? (
          <p className="text-sm text-muted-foreground">No endpoint connected.</p>
        ) : (
          <div className="divide-y divide-border">
            {channels.map((channel) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                busy={busy === `channel:${channel.id}`}
                onToggle={onToggle}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ChannelRow({
  channel,
  busy,
  onToggle,
  onDelete,
}: {
  channel: ChannelItem;
  busy: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{channel.label}</p>
        <p className="text-xs text-muted-foreground">
          {channel.enabled ? 'Enabled' : 'Disabled'} / {channel.verified ? 'Verified' : 'Pending'}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        title={channel.enabled ? 'Disable' : 'Enable'}
        disabled={busy}
        onClick={() => onToggle(channel.id, !channel.enabled)}
      >
        {busy ? <Loader2 className="animate-spin" /> : <Power />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        title="Disconnect"
        disabled={busy}
        onClick={() => onDelete(channel.id)}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

function PreferencesPanel({
  quietEnabled,
  setQuietEnabled,
  tz,
  setTz,
  start,
  setStart,
  end,
  setEnd,
  defaultChannels,
  setDefaultChannels,
  channelGroups,
  busy,
  onSave,
}: {
  quietEnabled: boolean;
  setQuietEnabled: (value: boolean) => void;
  tz: string;
  setTz: (value: string) => void;
  start: string;
  setStart: (value: string) => void;
  end: string;
  setEnd: (value: string) => void;
  defaultChannels: ChannelKey[];
  setDefaultChannels: (value: ChannelKey[]) => void;
  channelGroups: Record<ChannelKey, ChannelItem[]>;
  busy: string | null;
  onSave: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Moon className="size-4 text-muted-foreground" />
          Preferences
        </CardTitle>
        <CardDescription>Quiet hours and default delivery channels.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-secondary/30 p-3">
          <div>
            <p className="text-sm font-medium">Quiet hours</p>
            <p className="text-xs text-muted-foreground">
              Critical alerts still bypass this window.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={quietEnabled}
            aria-label="Quiet hours"
            onClick={() => setQuietEnabled(!quietEnabled)}
            className={cn(
              'inline-flex h-7 w-12 items-center rounded-full border p-0.5 transition-colors',
              quietEnabled ? 'border-primary bg-primary' : 'border-border bg-muted',
            )}
          >
            <span
              className={cn(
                'block size-5 rounded-full bg-foreground transition-transform',
                quietEnabled && 'translate-x-5 bg-primary-foreground',
              )}
            />
          </button>
        </div>

        {quietEnabled && (
          <div className="grid gap-4 sm:grid-cols-[1fr_auto_auto]">
            <div className="space-y-2">
              <Label htmlFor="tz">Timezone</Label>
              <Input id="tz" value={tz} onChange={(event) => setTz(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="start">From</Label>
              <Input
                id="start"
                value={start}
                onChange={(event) => setStart(event.target.value)}
                className="w-28"
                placeholder="22:00"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="end">To</Label>
              <Input
                id="end"
                value={end}
                onChange={(event) => setEnd(event.target.value)}
                className="w-28"
                placeholder="07:00"
              />
            </div>
          </div>
        )}

        <div className="space-y-2">
          <Label>Default channels</Label>
          <div className="flex flex-wrap gap-2">
            {CHANNELS.map((channel) => {
              const selected = defaultChannels.includes(channel);
              const connected = channelGroups[channel].some(
                (item) => item.enabled && item.verified,
              );
              return (
                <button
                  key={channel}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setDefaultChannels(toggleChannel(defaultChannels, channel))}
                  className={cn(
                    'inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm transition-colors',
                    selected
                      ? 'border-primary bg-primary/15 text-accent-bright'
                      : 'border-border bg-transparent text-muted-foreground hover:bg-accent',
                  )}
                >
                  {selected ? <CheckCircle2 className="size-4" /> : <Bell className="size-4" />}
                  {CHANNEL_META[channel].label}
                  {!connected && <span className="text-xs text-warning">not ready</span>}
                </button>
              );
            })}
          </div>
        </div>

        <Button type="button" onClick={onSave} disabled={busy === 'preferences'}>
          {busy === 'preferences' ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
          Save
        </Button>
      </CardContent>
    </Card>
  );
}

function WatchlistPanel({
  watches,
  channelGroups,
  busy,
  onUpdate,
  onDelete,
}: {
  watches: WatchItem[];
  channelGroups: Record<ChannelKey, ChannelItem[]>;
  busy: string | null;
  onUpdate: (
    id: string,
    patch: Partial<Pick<WatchItem, 'active' | 'channels' | 'eventTypes'>>,
  ) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Plane className="size-4 text-muted-foreground" />
          Watched flights
        </CardTitle>
        <CardDescription>Alert rules currently attached to flights.</CardDescription>
      </CardHeader>
      <CardContent>
        {watches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No watched flights yet.</p>
        ) : (
          <div className="space-y-3">
            {watches.map((watch) => (
              <WatchRow
                key={watch.id}
                watch={watch}
                channelGroups={channelGroups}
                busy={busy === `watch:${watch.id}`}
                onUpdate={onUpdate}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WatchRow({
  watch,
  channelGroups,
  busy,
  onUpdate,
  onDelete,
}: {
  watch: WatchItem;
  channelGroups: Record<ChannelKey, ChannelItem[]>;
  busy: boolean;
  onUpdate: (
    id: string,
    patch: Partial<Pick<WatchItem, 'active' | 'channels' | 'eventTypes'>>,
  ) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="rounded-md border border-border bg-secondary/20 p-4">
      <div className="flex flex-wrap items-center gap-3">
        {watch.flightId ? (
          <Link
            href={`/flights/id/${watch.flightId}`}
            className="font-mono text-sm font-medium text-accent-bright hover:underline"
          >
            {watch.flightId.slice(0, 8)}
          </Link>
        ) : (
          <span className="text-sm font-medium">Matcher rule</span>
        )}
        <Badge variant={watch.active ? 'success' : 'warning'}>
          {watch.active ? 'Active' : 'Paused'}
        </Badge>
        <span className="text-xs text-muted-foreground">{formatDate(watch.createdAt)}</span>
        <div className="ml-auto flex gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title={watch.active ? 'Pause' : 'Resume'}
            disabled={busy}
            onClick={() => onUpdate(watch.id, { active: !watch.active })}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Power />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="Remove watch"
            disabled={busy}
            onClick={() => onDelete(watch.id)}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase text-muted-foreground">Events</p>
          <div className="flex flex-wrap gap-2">
            {EVENT_GROUPS.map((group) => {
              const selected = group.events.every((event) => watch.eventTypes.includes(event));
              return (
                <button
                  key={group.id}
                  type="button"
                  aria-pressed={selected}
                  disabled={busy}
                  onClick={() =>
                    onUpdate(watch.id, { eventTypes: toggleEvents(watch, group.events) })
                  }
                  className={cn(
                    'inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors',
                    selected
                      ? 'border-primary bg-primary/15 text-accent-bright'
                      : 'border-border text-muted-foreground hover:bg-accent',
                  )}
                >
                  {selected ? (
                    <CheckCircle2 className="size-3.5" />
                  ) : (
                    <Clock3 className="size-3.5" />
                  )}
                  {group.label}
                  {group.critical && <span className="text-warning">critical</span>}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">{formatEvents(watch.eventTypes)}</p>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium uppercase text-muted-foreground">Channels</p>
          <div className="flex flex-wrap gap-2">
            {CHANNELS.map((channel) => {
              const selected = watch.channels.includes(channel);
              const connected = channelGroups[channel].some(
                (item) => item.enabled && item.verified,
              );
              return (
                <button
                  key={channel}
                  type="button"
                  aria-pressed={selected}
                  disabled={busy || (!selected && !connected)}
                  onClick={() =>
                    onUpdate(watch.id, { channels: toggleChannel(watch.channels, channel) })
                  }
                  className={cn(
                    'inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors disabled:opacity-50',
                    selected
                      ? 'border-primary bg-primary/15 text-accent-bright'
                      : 'border-border text-muted-foreground hover:bg-accent',
                  )}
                >
                  {selected ? <CheckCircle2 className="size-3.5" /> : <Bell className="size-3.5" />}
                  {CHANNEL_META[channel].label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function HistoryPanel({ notifications }: { notifications: NotificationItem[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BellRing className="size-4 text-muted-foreground" />
          Recent alerts
        </CardTitle>
        <CardDescription>Latest queued, sent, failed and suppressed notifications.</CardDescription>
      </CardHeader>
      <CardContent>
        {notifications.length === 0 ? (
          <p className="text-sm text-muted-foreground">No notifications yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {notifications.map((item) => (
              <div key={item.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <StatusIcon status={item.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{item.title}</p>
                    <Badge variant="outline">{item.channel}</Badge>
                    <StatusBadge status={item.status} />
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{item.body}</p>
                  {item.error && <p className="mt-1 text-xs text-destructive">{item.error}</p>}
                </div>
                <div className="shrink-0 text-right text-xs text-muted-foreground">
                  <p>{formatDate(item.createdAt)}</p>
                  {item.flightId && (
                    <Link
                      href={`/flights/id/${item.flightId}`}
                      className="text-accent-bright hover:underline"
                    >
                      Flight
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: number }) {
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

function StatusBadge({
  status,
}: {
  status: string | NotificationPermission | 'unsupported' | 'not_configured' | 'available';
}) {
  const label = statusLabel(status);
  const variant =
    status === 'ready' || status === 'sent' || status === 'delivered' || status === 'granted'
      ? 'success'
      : status === 'pending' ||
          status === 'queued' ||
          status === 'suppressed' ||
          status === 'default'
        ? 'warning'
        : status === 'failed' ||
            status === 'denied' ||
            status === 'unsupported' ||
            status === 'not_configured'
          ? 'destructive'
          : 'outline';
  return <Badge variant={variant}>{label}</Badge>;
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'sent' || status === 'delivered') {
    return <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />;
  }
  if (status === 'failed') return <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />;
  if (status === 'suppressed') return <Moon className="mt-0.5 size-4 shrink-0 text-warning" />;
  return <Clock3 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />;
}

function NotificationSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i}>
            <CardContent className="p-4">
              <Skeleton className="size-4" />
              <Skeleton className="mt-2 h-7 w-10" />
              <Skeleton className="mt-1.5 h-3 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-48 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}

function buildStats(data: DashboardData | null) {
  const channels = data?.channels ?? [];
  const notifications = data?.notifications ?? [];
  const watchlist = data?.watchlist ?? [];
  return {
    activeWatches: watchlist.filter((item) => item.active).length,
    readyChannels: channels.filter((item) => item.enabled && item.verified).length,
    sentNotifications: notifications.filter(
      (item) => item.status === 'sent' || item.status === 'delivered',
    ).length,
    needsAttention:
      channels.filter((item) => !item.enabled || !item.verified).length +
      notifications.filter((item) => item.status === 'failed').length,
  };
}

function groupChannels(channels: ChannelItem[]): Record<ChannelKey, ChannelItem[]> {
  return {
    webpush: channels.filter((item) => item.channel === 'webpush'),
    telegram: channels.filter((item) => item.channel === 'telegram'),
    email: channels.filter((item) => item.channel === 'email'),
  };
}

function normalizeChannels(value: unknown): ChannelKey[] {
  if (!Array.isArray(value)) return [];
  return CHANNELS.filter((channel) => value.includes(channel));
}

function toggleChannel(current: readonly string[], channel: ChannelKey): ChannelKey[] {
  const next = new Set(current.filter(isChannelKey));
  if (next.has(channel)) next.delete(channel);
  else next.add(channel);
  return next.size > 0 ? CHANNELS.filter((key) => next.has(key)) : [channel];
}

function toggleEvents(watch: WatchItem, events: readonly VisibleEventType[]): string[] {
  const next = new Set(watch.eventTypes);
  const allSelected = events.every((event) => next.has(event));
  for (const event of events) {
    if (allSelected) next.delete(event);
    else next.add(event);
  }
  if (next.size === 0) return watch.eventTypes;
  return [...next].sort((a, b) => eventRank(a) - eventRank(b));
}

function eventRank(event: string): number {
  const index = EVENT_ORDER.indexOf(event as VisibleEventType);
  return index === -1 ? EVENT_ORDER.length : index;
}

function isChannelKey(value: string): value is ChannelKey {
  return CHANNELS.includes(value as ChannelKey);
}

function formatEvents(events: string[]): string {
  return events.map((event) => EVENT_LABELS[event] ?? event.replace(/_/g, ' ')).join(', ');
}

function statusLabel(status: string): string {
  if (status === 'not_configured') return 'not configured';
  if (status === 'default') return 'ask';
  return status.replace(/_/g, ' ');
}

function formatDate(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function getPushSupport(): { supported: boolean } {
  if (typeof window === 'undefined') return { supported: false };
  return {
    supported: 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window,
  };
}

function readPushPermission(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

async function subscribeWebPush(options: { forceRenew?: boolean } = {}): Promise<void> {
  if (
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  ) {
    throw new Error('Web Push is not supported in this browser.');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission is blocked.');

  const reg = await registerServiceWorker();

  const { publicKey } = await api<{ publicKey: string | null }>('/config/webpush');
  if (!publicKey) throw new Error('Web Push is not configured on the server.');

  const applicationServerKey = urlBase64ToUint8Array(publicKey);
  let existing = await reg.pushManager.getSubscription();
  let replaceEndpoint: string | undefined;
  if (
    existing &&
    (options.forceRenew ||
      !sameApplicationServerKey(existing.options.applicationServerKey, applicationServerKey))
  ) {
    replaceEndpoint = existing.endpoint;
    await existing.unsubscribe();
    existing = null;
  }
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    }));
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };

  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error('Browser returned an incomplete push subscription.');
  }
  await api<{ ok: true }>('/channels/webpush/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: json.keys,
      ...(replaceEndpoint ? { replaceEndpoint } : {}),
    }),
  });
}

async function showLocalWebPushTest(): Promise<void> {
  if (
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  ) {
    throw new Error('Web Push is not supported in this browser.');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission is blocked.');

  const reg = await registerServiceWorker();
  await reg.showNotification('FlyTrace test', {
    body: 'Chrome can display notifications for this site.',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: 'flytrace-local-test',
    data: { url: '/settings/notifications' },
  });
}

async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register('/sw.js');
  await reg.update().catch(() => undefined);
  return navigator.serviceWorker.ready;
}

function sameApplicationServerKey(
  current: ArrayBuffer | null | undefined,
  expected: Uint8Array<ArrayBuffer>,
): boolean {
  if (!current) return false;
  const actual = new Uint8Array(current);
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < actual.length; i += 1) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
