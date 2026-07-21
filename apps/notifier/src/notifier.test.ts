import { describe, expect, test } from 'bun:test';
import type { ChannelEndpoint, ChannelKey, WatchlistItem } from '@flytrace/db';
import { ChannelRegistry, FakeChannel } from '@flytrace/notifications';
import {
  type EventEnvelope,
  type ProviderUpdatedPayload,
  createLogger,
  fixedClock,
  makeEnvelope,
} from '@flytrace/shared';
import { Notifier, type NotifierRepo, deriveFromProviderUpdated } from './notifier.ts';

const clock = fixedClock(1_700_000_000_000);
const FLIGHT = '00000000-0000-7000-8000-000000000001';
const USER = 'user-1';

function takeoff(dedupe = `${FLIGHT}:takeoff`): EventEnvelope {
  return makeEnvelope(
    {
      type: 'TakeoffDetected',
      occurredAt: '2023-11-14T22:15:00.000Z',
      dedupeKey: dedupe,
      partitionKey: FLIGHT,
      payload: {
        flightId: FLIGHT,
        icao24: '4bb1a2',
        at: '2023-11-14T22:15:00.000Z',
        lat: 41,
        lon: 29,
        altFt: 900,
        confidence: 0.9,
        source: 'fixture',
      },
    },
    { producer: 'tracker', clock },
  );
}

function flightEnded(reason: 'landed' | 'timeout' = 'landed'): EventEnvelope {
  return makeEnvelope(
    {
      type: 'FlightEnded',
      occurredAt: '2023-11-14T22:35:00.000Z',
      dedupeKey: `${FLIGHT}:ended:${reason}`,
      partitionKey: FLIGHT,
      payload: {
        flightId: FLIGHT,
        icao24: '4bb1a2',
        endedAt: '2023-11-14T22:35:00.000Z',
        reason,
      },
    },
    { producer: 'tracker', clock },
  );
}

function topOfClimb(): EventEnvelope {
  return makeEnvelope(
    {
      type: 'ClimbDetected',
      occurredAt: '2023-11-14T22:25:00.000Z',
      dedupeKey: `${FLIGHT}:vphase:top_of_climb:1`,
      partitionKey: FLIGHT,
      payload: {
        flightId: FLIGHT,
        phase: 'top_of_climb',
        at: '2023-11-14T22:25:00.000Z',
        altFt: 33000,
        vrateFpm: 0,
        confidence: 0.8,
        source: 'fixture',
      },
    },
    { producer: 'tracker', clock },
  );
}

class FakeRepo implements NotifierRepo {
  watches: WatchlistItem[] = [];
  endpoints: ChannelEndpoint[] = [];
  quietHours: { tz: string; start: string; end: string } | null = null;
  recentCount = 0;
  inserted = new Set<string>();
  sent: string[] = [];
  failed: { id: string; error: string }[] = [];
  suppressed: { id: string; reason: string }[] = [];
  disabled: string[] = [];
  private seq = 0;

  async watchesForFlight() {
    return this.watches;
  }
  async insertQueued(input: { dedupeKey: string }) {
    if (this.inserted.has(input.dedupeKey)) return null;
    this.inserted.add(input.dedupeKey);
    this.seq += 1;
    return { id: `n${this.seq}` };
  }
  async channelEndpoints(_userId: string, _channel: ChannelKey) {
    return this.endpoints;
  }
  async getQuietHours() {
    return this.quietHours;
  }
  async countRecentNotifications() {
    return this.recentCount;
  }
  async markSent(id: string) {
    this.sent.push(id);
  }
  async markFailed(id: string, error: string) {
    this.failed.push({ id, error });
  }
  async markSuppressed(id: string, reason: string) {
    this.suppressed.push({ id, reason });
  }
  async disableChannel(channelId: string) {
    this.disabled.push(channelId);
  }
}

const watch = (over: Partial<WatchlistItem> = {}): WatchlistItem => ({
  id: 'w1',
  userId: USER,
  flightId: FLIGHT,
  eventTypes: ['takeoff', 'landing'],
  channels: ['webpush'],
  ...over,
});
const endpoint = (id: string): ChannelEndpoint => ({
  channelId: id,
  userId: USER,
  address: { endpoint: `https://push.example/${id}`, keys: { p256dh: 'p', auth: 'a' } },
});

function make(webpush = new FakeChannel('webpush')) {
  const repo = new FakeRepo();
  const channels = new ChannelRegistry().register(webpush);
  const delivered: string[] = [];
  const notifier = new Notifier({
    repo,
    channels,
    logger: createLogger({ level: 'error', base: {} }),
    clock,
    frequencyCap: 5,
    onDelivered: async (_u, id) => {
      delivered.push(id);
    },
  });
  return { repo, webpush, notifier, delivered };
}

const ALWAYS_QUIET = { tz: 'UTC', start: '00:00', end: '23:59' };

function providerGate(): EventEnvelope {
  return makeEnvelope(
    {
      type: 'ProviderUpdated',
      occurredAt: '2023-11-14T22:20:00.000Z',
      dedupeKey: `${FLIGHT}:provider:2023-11-14T22:20`,
      partitionKey: FLIGHT,
      payload: {
        flightId: FLIGHT,
        providerKey: 'fixture',
        before: { gate: 'A12' },
        after: { gate: 'B7' },
        changed: ['gate'],
        fetchedAt: '2023-11-14T22:20:00.000Z',
      } satisfies ProviderUpdatedPayload,
    },
    { producer: 'worker', clock },
  );
}

describe('Notifier', () => {
  test('delivers a matching event to the user’s endpoints exactly once', async () => {
    const { repo, webpush, notifier, delivered } = make();
    repo.watches = [watch()];
    repo.endpoints = [endpoint('c1')];

    await notifier.handle(takeoff());
    expect(webpush.sent).toHaveLength(1);
    expect(repo.sent).toHaveLength(1);
    expect(delivered).toHaveLength(1);

    await notifier.handle(takeoff()); // redelivery → deduped
    expect(webpush.sent).toHaveLength(1);
  });

  test('ignores events not in the watch’s eventTypes', async () => {
    const { repo, webpush, notifier } = make();
    repo.watches = [watch({ eventTypes: ['landing'] })];
    repo.endpoints = [endpoint('c1')];
    await notifier.handle(takeoff());
    expect(webpush.sent).toHaveLength(0);
  });

  test('marks failed when the user has no endpoint for the channel', async () => {
    const { repo, webpush, notifier } = make();
    repo.watches = [watch()];
    repo.endpoints = [];
    await notifier.handle(takeoff());
    expect(webpush.sent).toHaveLength(0);
    expect(repo.failed[0]?.error).toContain('no active');
  });

  test('prunes a dead (gone) endpoint', async () => {
    const { repo, notifier } = make(new FakeChannel('webpush', { gone: true }));
    repo.watches = [watch()];
    repo.endpoints = [endpoint('c1')];
    await notifier.handle(takeoff());
    expect(repo.disabled).toEqual(['c1']);
    expect(repo.failed).toHaveLength(1);
    expect(repo.failed[0]?.error).toContain('gone');
  });

  test('skips channels with no enabled adapter', async () => {
    const { repo, webpush, notifier } = make(); // only webpush registered
    repo.watches = [watch({ channels: ['telegram'] })]; // telegram not registered
    repo.endpoints = [endpoint('c1')];
    await notifier.handle(takeoff());
    expect(webpush.sent).toHaveLength(0);
  });

  test('derives and delivers a gate-change from ProviderUpdated', async () => {
    const { repo, webpush, notifier } = make();
    repo.watches = [watch({ eventTypes: ['gate_change', 'delay'] })];
    repo.endpoints = [endpoint('c1')];

    const env = makeEnvelope(
      {
        type: 'ProviderUpdated',
        occurredAt: '2023-11-14T22:20:00.000Z',
        dedupeKey: `${FLIGHT}:provider:2023-11-14T22:20`,
        partitionKey: FLIGHT,
        payload: {
          flightId: FLIGHT,
          providerKey: 'fixture',
          before: { gate: 'A12' },
          after: { status: 'active', gate: 'B7' },
          changed: ['gate'],
          fetchedAt: '2023-11-14T22:20:00.000Z',
        } satisfies ProviderUpdatedPayload,
      },
      { producer: 'worker', clock },
    );
    await notifier.handle(env);
    expect(webpush.sent).toHaveLength(1);
    expect(webpush.sent[0]?.message.title).toBe('Gate changed');
    expect(webpush.sent[0]?.message.body).toContain('B7');
  });

  test('suppresses a non-critical alert during quiet hours', async () => {
    const { repo, webpush, notifier } = make();
    repo.watches = [watch({ eventTypes: ['top_of_climb'] })];
    repo.endpoints = [endpoint('c1')];
    repo.quietHours = ALWAYS_QUIET;
    await notifier.handle(topOfClimb());
    expect(webpush.sent).toHaveLength(0);
    expect(repo.suppressed[0]?.reason).toBe('quiet_hours');
  });

  test('delivers a critical alert (gate change) despite quiet hours', async () => {
    const { repo, webpush, notifier } = make();
    repo.watches = [watch({ eventTypes: ['gate_change'] })];
    repo.endpoints = [endpoint('c1')];
    repo.quietHours = ALWAYS_QUIET;
    await notifier.handle(providerGate());
    expect(webpush.sent).toHaveLength(1); // critical bypasses quiet hours
  });

  test('suppresses non-critical over the frequency cap', async () => {
    const { repo, webpush, notifier } = make();
    repo.watches = [watch({ eventTypes: ['top_of_climb'] })];
    repo.endpoints = [endpoint('c1')];
    repo.recentCount = 5; // == cap
    await notifier.handle(topOfClimb());
    expect(webpush.sent).toHaveLength(0);
    expect(repo.suppressed[0]?.reason).toBe('frequency_cap');
  });

  test('does nothing for a non-notifiable event (position)', async () => {
    const { repo, webpush, notifier } = make();
    repo.watches = [watch()];
    repo.endpoints = [endpoint('c1')];
    const pos = makeEnvelope(
      {
        type: 'PositionUpdated',
        occurredAt: '2023-11-14T22:15:00.000Z',
        dedupeKey: `${FLIGHT}:pos`,
        partitionKey: FLIGHT,
        payload: {},
      },
      { producer: 'tracker', clock },
    );
    await notifier.handle(pos);
    expect(webpush.sent).toHaveLength(0);
  });

  test('does not duplicate landed FlightEnded when landing is also watched', async () => {
    const { repo, webpush, notifier } = make();
    repo.watches = [watch({ eventTypes: ['landing', 'flight_ended'] })];
    repo.endpoints = [endpoint('c1')];

    await notifier.handle(flightEnded('landed'));
    expect(webpush.sent).toHaveLength(0);

    await notifier.handle(flightEnded('timeout'));
    expect(webpush.sent).toHaveLength(1);
  });

  test('delivers timeout FlightEnded to legacy landing watches', async () => {
    const { repo, webpush, notifier } = make();
    repo.watches = [watch({ eventTypes: ['landing'] })];
    repo.endpoints = [endpoint('c1')];

    await notifier.handle(flightEnded('timeout'));
    expect(webpush.sent).toHaveLength(1);
  });
});

describe('deriveFromProviderUpdated', () => {
  const base = {
    flightId: FLIGHT,
    providerKey: 'fixture',
    before: null,
    fetchedAt: '2023-11-14T22:20:00.000Z',
  };

  test('maps changed fields to notifiable sub-events', () => {
    expect(
      deriveFromProviderUpdated({ ...base, after: { gate: 'B7' }, changed: ['gate'] }).map(
        (d) => d.dbType,
      ),
    ).toEqual(['gate_change']);
    expect(
      deriveFromProviderUpdated({ ...base, after: { status: 'delayed' }, changed: ['status'] }).map(
        (d) => d.dbType,
      ),
    ).toEqual(['delay']);
    expect(
      deriveFromProviderUpdated({
        ...base,
        after: { status: 'cancelled' },
        changed: ['status'],
      }).map((d) => d.dbType),
    ).toEqual(['cancelled']);
    expect(
      deriveFromProviderUpdated({ ...base, after: { status: 'landed' }, changed: ['status'] }).map(
        (d) => d.dbType,
      ),
    ).toEqual(['arrived']);
  });

  test('ignores non-notable changes (e.g. terminal only)', () => {
    expect(
      deriveFromProviderUpdated({ ...base, after: { terminal: '2' }, changed: ['terminal'] }),
    ).toEqual([]);
  });
});
