import { describe, expect, test } from 'bun:test';
import type { WatchlistItem, WebPushSubscription } from '@flytrace/db';
import { type EventEnvelope, createLogger, fixedClock, makeEnvelope } from '@flytrace/shared';
import { Notifier, type NotifierRepo } from './notifier.ts';
import { FakePushSender } from './push/fake-sender.ts';

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

/** In-memory notify repo covering the notifier's needs. */
class FakeRepo implements NotifierRepo {
  watches: WatchlistItem[] = [];
  subs: WebPushSubscription[] = [];
  inserted = new Set<string>();
  sent: string[] = [];
  failed: { id: string; error: string }[] = [];
  disabled: string[] = [];
  private seq = 0;

  async watchesForFlight() {
    return this.watches;
  }
  async insertQueued(input: { dedupeKey: string }) {
    if (this.inserted.has(input.dedupeKey)) return null; // dedupe
    this.inserted.add(input.dedupeKey);
    this.seq += 1;
    return { id: `n${this.seq}` };
  }
  async webPushSubscriptions() {
    return this.subs;
  }
  async markSent(id: string) {
    this.sent.push(id);
  }
  async markFailed(id: string, error: string) {
    this.failed.push({ id, error });
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
const sub = (id: string): WebPushSubscription => ({
  channelId: id,
  userId: USER,
  address: { endpoint: `https://push.example/${id}`, keys: { p256dh: 'p', auth: 'a' } },
});

function make(sender = new FakePushSender()) {
  const repo = new FakeRepo();
  const delivered: string[] = [];
  const notifier = new Notifier({
    repo,
    sender,
    logger: createLogger({ level: 'error', base: {} }),
    onDelivered: async (_u, id) => {
      delivered.push(id);
    },
  });
  return { repo, sender, notifier, delivered };
}

describe('Notifier', () => {
  test('delivers a matching event to the user’s subscriptions exactly once', async () => {
    const { repo, sender, notifier, delivered } = make();
    repo.watches = [watch()];
    repo.subs = [sub('c1')];

    await notifier.handle(takeoff());
    expect(sender.sent).toHaveLength(1);
    expect(repo.sent).toHaveLength(1);
    expect(delivered).toHaveLength(1);

    // Redelivery of the same event → no duplicate send (dedupe key).
    await notifier.handle(takeoff());
    expect(sender.sent).toHaveLength(1);
  });

  test('ignores events not in the watch’s eventTypes', async () => {
    const { repo, sender, notifier } = make();
    repo.watches = [watch({ eventTypes: ['landing'] })];
    repo.subs = [sub('c1')];
    await notifier.handle(takeoff());
    expect(sender.sent).toHaveLength(0);
  });

  test('marks failed when the user has no subscription', async () => {
    const { repo, sender, notifier } = make();
    repo.watches = [watch()];
    repo.subs = [];
    await notifier.handle(takeoff());
    expect(sender.sent).toHaveLength(0);
    expect(repo.failed[0]?.error).toContain('no active');
  });

  test('prunes a dead (410) subscription', async () => {
    const { repo, notifier } = make(new FakePushSender({ gone: true }));
    repo.watches = [watch()];
    repo.subs = [sub('c1')];
    await notifier.handle(takeoff());
    expect(repo.disabled).toEqual(['c1']);
    expect(repo.failed).toHaveLength(1); // no successful send
  });

  test('does nothing for a non-notifiable event (position)', async () => {
    const { repo, sender, notifier } = make();
    repo.watches = [watch()];
    repo.subs = [sub('c1')];
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
    expect(sender.sent).toHaveLength(0);
  });
});
