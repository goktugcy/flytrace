import { describe, expect, test } from 'bun:test';
import type {
  CatalogRepo,
  FlightEnrichment,
  FlightStatusRepo,
  SnapshotStatus,
  SnapshotUpsert,
} from '@flytrace/db';
import { ProviderRegistry, fixtureProviderFactory } from '@flytrace/providers';
import type { ProviderContext } from '@flytrace/providers';
import {
  type AircraftChangedPayload,
  type EventEnvelope,
  type ProviderUpdatedPayload,
  createLogger,
  fixedClock,
} from '@flytrace/shared';
import { ProviderFetchService, diffStatus } from './provider-fetch.ts';

const clock = fixedClock(1_700_000_000_000);
const FLIGHT = '00000000-0000-7000-8000-000000000001';

function providerCtx(): ProviderContext {
  const store = new Map<string, { v: string; exp: number }>();
  return {
    http: { getJson: async () => ({}) },
    cache: {
      get: async (k) => {
        const e = store.get(k);
        return e && e.exp > clock.now() ? e.v : null;
      },
      set: async (k, v, ttl) => {
        store.set(k, { v, exp: clock.now() + ttl });
      },
    },
    rateLimiter: { tryAcquire: async () => true },
    logger: createLogger({ level: 'error', base: {} }),
    clock,
    config: {},
  };
}

class FakeStatusRepo implements FlightStatusRepo {
  snap: SnapshotStatus | null = null;
  upserts: SnapshotUpsert[] = [];
  async getSnapshot() {
    return this.snap;
  }
  async upsertSnapshot(i: SnapshotUpsert) {
    this.upserts.push(i);
    this.snap = {
      providerKey: i.providerKey,
      status: i.status,
      gate: i.gate ?? null,
      terminal: i.terminal ?? null,
      baggageBelt: i.baggageBelt ?? null,
      scheduledDeparture: i.scheduledDeparture ?? null,
      estimatedDeparture: i.estimatedDeparture ?? null,
      actualDeparture: i.actualDeparture ?? null,
      scheduledArrival: i.scheduledArrival ?? null,
      estimatedArrival: i.estimatedArrival ?? null,
      actualArrival: i.actualArrival ?? null,
      fetchedAt: i.fetchedAt.toISOString(),
    };
  }
}

/** Catalog fake: resolves a couple of known codes, everything else misses. */
const fakeCatalog = {
  getAirlineByIcao: async () => null,
  getAirlineIdByIata: async (iata: string) => (iata === 'XX' ? 'airline-xx' : null),
  getAirportIdByIata: async (iata: string) => ({ IST: 'ap-ist', ESB: 'ap-esb' })[iata] ?? null,
  getAircraftIdByRegistration: async (reg: string) => (reg === 'TC-XXX' ? 'ac-1' : null),
  getFlightIcao24: async () => null,
  getIcao24ByRegistration: async () => null,
} as unknown as CatalogRepo;

async function makeService(
  statusRepo: FakeStatusRepo,
  opts: {
    deriveStatus?: (id: string) => Promise<'active' | 'landed' | null>;
    build?: Parameters<typeof fixtureProviderFactory>[0]['build'];
    catalog?: CatalogRepo;
  } = {},
) {
  const emitted: EventEnvelope[] = [];
  const enriched: { flightId: string; patch: FlightEnrichment }[] = [];
  const logs: { providerKey: string; success: boolean }[] = [];
  const registry = await ProviderRegistry.build(
    [
      fixtureProviderFactory({
        key: 'fixture',
        airlineIata: ['XX'],
        ...(opts.build ? { build: opts.build } : {}),
      }),
    ],
    { enabled: new Set(['fixture']), ctx: providerCtx() },
  );
  const service = new ProviderFetchService({
    registry,
    statusRepo,
    catalog: opts.catalog ?? fakeCatalog,
    flightRepo: {
      enrichFlight: async (flightId, patch) => {
        enriched.push({ flightId, patch });
      },
    },
    emit: async (e) => {
      emitted.push(e);
    },
    clock,
    logger: createLogger({ level: 'error', base: {} }),
    logProvider: async (e) => {
      logs.push({ providerKey: e.providerKey, success: e.success });
    },
    ...(opts.deriveStatus ? { deriveStatus: opts.deriveStatus } : {}),
  });
  return { service, emitted, enriched, logs };
}

describe('diffStatus', () => {
  test('reports all present fields when there is no prior snapshot', () => {
    const changed = diffStatus(null, { status: 'active', gate: 'A12', terminal: '1' });
    expect(changed).toContain('status');
    expect(changed).toContain('gate');
    expect(changed).toContain('terminal');
  });

  test('reports only changed fields', () => {
    const before: SnapshotStatus = {
      providerKey: 'fixture',
      status: 'active',
      gate: 'A12',
      terminal: '1',
      baggageBelt: null,
      scheduledDeparture: null,
      estimatedDeparture: null,
      actualDeparture: null,
      scheduledArrival: null,
      estimatedArrival: null,
      actualArrival: null,
      fetchedAt: clock.nowIso(),
    };
    expect(diffStatus(before, { status: 'active', gate: 'B7', terminal: '1' })).toEqual(['gate']);
  });
});

describe('ProviderFetchService', () => {
  const job = { flightId: FLIGHT, airlineIata: 'XX', flightNumber: 'XX100', date: '2023-11-14' };

  test('projects status and emits ProviderUpdated on first fetch', async () => {
    const repo = new FakeStatusRepo();
    const { service, emitted } = await makeService(repo);
    await service.process(job);

    expect(repo.upserts).toHaveLength(1);
    expect(repo.upserts[0]?.gate).toBe('A12');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.type).toBe('ProviderUpdated');
    const payload = emitted[0]?.payload as ProviderUpdatedPayload;
    expect(payload.providerKey).toBe('fixture');
    expect(payload.before).toBeNull();
    expect(payload.changed).toContain('gate');
  });

  test('does nothing when no provider serves the airline (no fallback)', async () => {
    const repo = new FakeStatusRepo();
    const { service, emitted } = await makeService(repo);
    await service.process({ ...job, airlineIata: 'ZZ' });
    expect(repo.upserts).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  test('falls back to a position-derived status when no provider serves the airline', async () => {
    const repo = new FakeStatusRepo();
    const { service, emitted } = await makeService(repo, { deriveStatus: async () => 'active' });
    await service.process({ ...job, airlineIata: 'ZZ' });
    expect(repo.upserts).toHaveLength(1);
    expect(repo.upserts[0]?.providerKey).toBe('derived');
    expect(repo.upserts[0]?.status).toBe('active');
    expect((emitted[0]?.payload as ProviderUpdatedPayload).providerKey).toBe('derived');
  });

  test('records a provider log entry per fetch', async () => {
    const repo = new FakeStatusRepo();
    const { service, logs } = await makeService(repo);
    await service.process(job);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual({ providerKey: 'fixture', success: true });
  });

  test('enriches the flight with resolved catalog FKs', async () => {
    const repo = new FakeStatusRepo();
    const { service, enriched } = await makeService(repo);
    await service.process(job);

    expect(enriched).toHaveLength(1);
    const { flightId, patch } = enriched[0] ?? { flightId: '', patch: {} };
    expect(flightId).toBe(FLIGHT);
    expect(patch.flightNumber).toBe('XX100');
    expect(patch.airlineId).toBe('airline-xx');
    expect(patch.originAirportId).toBe('ap-ist'); // IST resolves
    expect(patch.destinationAirportId).toBeUndefined(); // LHR uncatalogued → omitted
    expect(patch.aircraftId).toBeUndefined(); // no registration in fixture
  });

  // AircraftChanged (docs/07): provider reports a tail whose icao24 differs from
  // the aircraft currently attached to the flight.
  const buildTail =
    (registration: string): Parameters<typeof fixtureProviderFactory>[0]['build'] =>
    (_q, c, key) => ({
      flightNumber: 'XX100',
      airlineIata: 'XX',
      origin: 'IST',
      destination: 'ESB',
      status: 'active',
      registration,
      source: key,
      fetchedAt: c.nowIso(),
      confidence: 0.9,
    });
  const swapCatalog = (newIcao: string | null) =>
    ({
      getAirlineByIcao: async () => null,
      getAirlineIdByIata: async () => 'airline-xx',
      getAirportIdByIata: async () => null,
      getAircraftIdByRegistration: async () => 'ac-new',
      getFlightIcao24: async () => 'aaaaaa',
      getIcao24ByRegistration: async () => newIcao,
    }) as unknown as CatalogRepo;

  test('emits AircraftChanged when the provider reports a different tail', async () => {
    const repo = new FakeStatusRepo();
    const { service, emitted } = await makeService(repo, {
      build: buildTail('TC-NEW'),
      catalog: swapCatalog('bbbbbb'),
    });
    await service.process(job);

    const ev = emitted.find((e) => e.type === 'AircraftChanged');
    expect(ev).toBeDefined();
    const p = ev?.payload as AircraftChangedPayload;
    expect(p.previousIcao24).toBe('aaaaaa');
    expect(p.newIcao24).toBe('bbbbbb');
    expect(p.flightNumber).toBe('XX100');
    expect(ev?.dedupeKey).toBe('XX100:2023-11-14:aircraftChange');
  });

  test('does not emit AircraftChanged when the tail is unchanged', async () => {
    const repo = new FakeStatusRepo();
    const { service, emitted } = await makeService(repo, {
      build: buildTail('TC-SAME'),
      catalog: swapCatalog('aaaaaa'), // same as the flight's current icao24
    });
    await service.process(job);
    expect(emitted.some((e) => e.type === 'AircraftChanged')).toBe(false);
  });
});
