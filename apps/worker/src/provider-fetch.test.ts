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
    };
  }
}

/** Catalog fake: resolves a couple of known codes, everything else misses. */
const fakeCatalog = {
  getAirlineByIcao: async () => null,
  getAirlineIdByIata: async (iata: string) => (iata === 'XX' ? 'airline-xx' : null),
  getAirportIdByIata: async (iata: string) => ({ IST: 'ap-ist', ESB: 'ap-esb' })[iata] ?? null,
  getAircraftIdByRegistration: async (reg: string) => (reg === 'TC-XXX' ? 'ac-1' : null),
} as unknown as CatalogRepo;

async function makeService(statusRepo: FakeStatusRepo) {
  const emitted: EventEnvelope[] = [];
  const enriched: { flightId: string; patch: FlightEnrichment }[] = [];
  const registry = await ProviderRegistry.build(
    [fixtureProviderFactory({ key: 'fixture', airlineIata: ['XX'] })],
    { enabled: new Set(['fixture']), ctx: providerCtx() },
  );
  const service = new ProviderFetchService({
    registry,
    statusRepo,
    catalog: fakeCatalog,
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
  });
  return { service, emitted, enriched };
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

  test('does nothing when no provider serves the airline', async () => {
    const repo = new FakeStatusRepo();
    const { service, emitted } = await makeService(repo);
    await service.process({ ...job, airlineIata: 'ZZ' });
    expect(repo.upserts).toHaveLength(0);
    expect(emitted).toHaveLength(0);
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
});
