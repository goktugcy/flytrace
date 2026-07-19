import { beforeEach, describe, expect, test } from 'bun:test';
import {
  type EventEnvelope,
  type PositionPayload,
  createLogger,
  fixedClock,
  makeEnvelope,
} from '@flytrace/shared';
import type { Redis } from 'ioredis';
import { createApiMetrics } from '../metrics.ts';
import { WsHub } from './hub.ts';
import type { Socket } from './hub.ts';
import type { ServerMessage } from './protocol.ts';
import type { TicketPayload } from './ticket.ts';

const PREFIX = 'test:';
const guest: TicketPayload = { uid: null, role: 'guest', iat: 0, exp: 9e15, jti: 'j', bind: '' };

/** Records everything the hub sends. */
class FakeSocket implements Socket {
  readonly sent: ServerMessage[] = [];
  constructor(readonly id: string) {}
  send(msg: ServerMessage): void {
    this.sent.push(msg);
  }
  close(): void {}
  ofType<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
}

function cmp(a: string, b: string): number {
  const [am, as] = a.split('-').map(Number);
  const [bm, bs] = b.split('-').map(Number);
  return am !== bm ? (am as number) - (bm as number) : (as as number) - (bs as number);
}

/** Minimal in-memory Redis covering only what the hub reads. */
class FakeRedis {
  strings = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  streams = new Map<string, [string, string[]][]>();

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }
  async mget(keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.strings.get(k) ?? null);
  }
  async xrange(
    key: string,
    start: string,
    _end: string,
    _c?: string,
    count?: number,
  ): Promise<[string, string[]][]> {
    const after = start.startsWith('(') ? start.slice(1) : start;
    const exclusive = start.startsWith('(');
    const rows = (this.streams.get(key) ?? []).filter(([id]) =>
      exclusive ? cmp(id, after) > 0 : cmp(id, after) >= 0,
    );
    return count ? rows.slice(0, count) : rows;
  }
  async xrevrange(
    key: string,
    _s: string,
    _e: string,
    _c?: string,
    count?: number,
  ): Promise<[string, string[]][]> {
    const rows = [...(this.streams.get(key) ?? [])].reverse();
    return count ? rows.slice(0, count) : rows;
  }
}

function positionEnvelope(
  flightId: string,
  lat: number,
  lon: number,
): EventEnvelope<PositionPayload> {
  const ts = '2023-11-14T22:13:20.000Z';
  return makeEnvelope<PositionPayload>(
    {
      type: 'PositionUpdated',
      occurredAt: ts,
      dedupeKey: `${flightId}:pos:${ts}`,
      partitionKey: flightId,
      payload: {
        flightId,
        icao24: 'abc123',
        lat,
        lon,
        altFt: 1000,
        headingDeg: 90,
        gsKt: 100,
        vrateFpm: 0,
        onGround: false,
        ts,
      },
    },
    { producer: 'tracker', clock: fixedClock(1_700_000_000_000), correlationId: flightId },
  );
}

function endedEnvelope(flightId: string): EventEnvelope<{ flightId: string; icao24: string }> {
  const ts = '2023-11-14T22:15:00.000Z';
  return makeEnvelope(
    {
      type: 'FlightEnded',
      occurredAt: ts,
      dedupeKey: `${flightId}:ended`,
      partitionKey: flightId,
      payload: { flightId, icao24: 'abc123', endedAt: ts, reason: 'timeout' },
    },
    { producer: 'tracker', clock: fixedClock(1_700_000_000_000), correlationId: flightId },
  );
}

function makeHub(redis: FakeRedis, metrics?: ReturnType<typeof createApiMetrics>) {
  return new WsHub({
    redis: redis as unknown as Redis,
    prefix: PREFIX,
    clock: fixedClock(1_700_000_000_000),
    logger: createLogger({ level: 'error', base: {} }),
    ...(metrics ? { metrics } : {}),
  });
}

describe('WsHub', () => {
  let redis: FakeRedis;
  let hub: WsHub;

  beforeEach(() => {
    redis = new FakeRedis();
    hub = makeHub(redis);
  });

  test('sends hello on connect', () => {
    const s = new FakeSocket('c1');
    hub.add(s, guest);
    expect(s.sent[0]?.t).toBe('hello');
    expect(hub.size).toBe(1);
  });

  test('flight subscribe → snapshot then ack with latest cursor', async () => {
    redis.strings.set(
      `${PREFIX}flight:state:F1`,
      JSON.stringify({
        flightId: 'F1',
        icao24: 'abc123',
        callsign: 'THY1',
        lat: 41,
        lon: 29,
        altFt: 1000,
        gsKt: 100,
        headingDeg: 90,
        vrateFpm: 0,
        lastTs: '2023-11-14T22:13:20.000Z',
      }),
    );
    redis.streams.set(`${PREFIX}stream:flight:F1`, [['5-0', ['e', '{}']]]);

    const s = new FakeSocket('c1');
    hub.add(s, guest);
    await hub.handleMessage('c1', { t: 'subscribe', channel: 'flight:F1' });

    const snap = s.ofType('snapshot');
    expect(snap).toHaveLength(1);
    expect((snap[0]?.data as { flightId: string }).flightId).toBe('F1');
    expect(snap[0]?.snapshotId).toBe('c1:1');
    expect(snap[0]?.generatedAt).toBe('2023-11-14T22:13:20.000Z');
    expect(snap[0]?.scope).toEqual({ kind: 'flight', flightId: 'F1' });
    const ack = s.ofType('ack');
    expect(ack[0]?.cursor).toBe('5-0');
  });

  test('routes a flight event only to subscribers of that flight', async () => {
    const a = new FakeSocket('a');
    const b = new FakeSocket('b');
    hub.add(a, guest);
    hub.add(b, guest);
    await hub.handleMessage('a', { t: 'subscribe', channel: 'flight:F1' });

    hub.route('7-0', positionEnvelope('F1', 41, 29));

    const aEvents = a.ofType('event');
    expect(aEvents).toHaveLength(1);
    expect(aEvents[0]?.channel).toBe('flight:F1');
    expect(aEvents[0]?.id).toBe('7-0');
    expect(b.ofType('event')).toHaveLength(0); // not subscribed
  });

  test('viewport: snapshot of in-view flights, then routed positions', async () => {
    redis.sets.set(`${PREFIX}flights:active`, new Set(['F1', 'F2']));
    redis.strings.set(
      `${PREFIX}flight:state:F1`,
      JSON.stringify({
        flightId: 'F1',
        icao24: 'a',
        callsign: null,
        lat: 41,
        lon: 29,
        altFt: 1,
        gsKt: 1,
        headingDeg: 1,
        vrateFpm: 0,
        lastTs: 't',
      }),
    );
    redis.strings.set(
      `${PREFIX}flight:state:F2`,
      JSON.stringify({
        flightId: 'F2',
        icao24: 'b',
        callsign: null,
        lat: 10,
        lon: 10,
        altFt: 1,
        gsKt: 1,
        headingDeg: 1,
        vrateFpm: 0,
        lastTs: 't',
      }),
    );

    const s = new FakeSocket('c1');
    hub.add(s, guest);
    await hub.handleMessage('c1', { t: 'viewport', bbox: [28, 40, 33, 42] });

    const snap = s.ofType('snapshot');
    expect(snap).toHaveLength(1);
    expect((snap[0]?.data as unknown[]).length).toBe(1); // only F1 in view
    expect(snap[0]?.scope).toEqual({ kind: 'viewport', bbox: [28, 40, 33, 42] });

    hub.route('9-0', positionEnvelope('F1', 41, 29)); // in view
    hub.route('9-1', positionEnvelope('F2', 10, 10)); // out of view
    const evs = s.ofType('event');
    expect(evs).toHaveLength(1);
    expect(evs[0]?.channel).toBe('viewport');
  });

  test('routes lifecycle removals to viewport clients for local cleanup', async () => {
    const s = new FakeSocket('c1');
    hub.add(s, guest);
    await hub.handleMessage('c1', { t: 'viewport', bbox: [28, 40, 33, 42] });

    hub.route('10-0', endedEnvelope('F1'));

    const evs = s.ofType('event');
    expect(evs).toHaveLength(1);
    expect(evs[0]?.channel).toBe('viewport');
    expect(evs[0]?.event.type).toBe('FlightEnded');
  });

  test('reconnect replays missed deltas exclusive of the cursor', async () => {
    redis.streams.set(`${PREFIX}stream:flight:F1`, [
      ['3-0', ['e', JSON.stringify(positionEnvelope('F1', 41, 29))]],
      ['4-0', ['e', JSON.stringify(positionEnvelope('F1', 41.1, 29))]],
      ['5-0', ['e', JSON.stringify(positionEnvelope('F1', 41.2, 29))]],
    ]);

    const s = new FakeSocket('c1');
    hub.add(s, guest);
    await hub.handleMessage('c1', { t: 'subscribe', channel: 'flight:F1', cursor: '3-0' });

    const ids = s.ofType('event').map((e) => e.id);
    expect(ids).toEqual(['4-0', '5-0']); // 3-0 excluded
    expect(s.ofType('ack')[0]?.cursor).toBe('5-0');
  });

  test('forbids a guest from a user channel', async () => {
    const s = new FakeSocket('c1');
    hub.add(s, guest);
    await hub.handleMessage('c1', { t: 'subscribe', channel: 'user:u1' });
    expect(s.ofType('error')[0]?.code).toBe('FORBIDDEN');
  });

  test('responds to ping with pong', async () => {
    const s = new FakeSocket('c1');
    hub.add(s, guest);
    await hub.handleMessage('c1', { t: 'ping' });
    expect(s.ofType('pong')).toHaveLength(1);
  });

  test('records websocket message, reconnect and snapshot metrics', async () => {
    const metrics = createApiMetrics();
    hub = makeHub(redis, metrics);
    redis.strings.set(
      `${PREFIX}flight:state:F1`,
      JSON.stringify({
        flightId: 'F1',
        icao24: 'abc123',
        callsign: 'THY1',
        lat: 41,
        lon: 29,
        altFt: 1000,
        gsKt: 100,
        headingDeg: 90,
        vrateFpm: 0,
        lastTs: '2023-11-14T22:13:20.000Z',
      }),
    );

    const s = new FakeSocket('c1');
    hub.add(s, guest);
    await hub.handleMessage('c1', { t: 'subscribe', channel: 'flight:F1', cursor: '1-0' });

    const rendered = metrics.registry.render();
    expect(rendered).toContain('ws_messages_sent_total{channel="control",type="hello"} 1');
    expect(rendered).toContain('ws_messages_sent_total{channel="flight",type="snapshot"} 1');
    expect(rendered).toContain('ws_reconnects_total{channel="flight"} 1');
    expect(rendered).toContain('ws_snapshot_size_count{channel="flight",scope="flight"} 1');
  });
});
