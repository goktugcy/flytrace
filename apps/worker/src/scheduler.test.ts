import { describe, expect, test } from 'bun:test';
import type { AirlineRow, CatalogRepo } from '@flytrace/db';
import { type EventEnvelope, createLogger, fixedClock, makeEnvelope } from '@flytrace/shared';
import { type EnqueueQueue, ProviderScheduler, parseCallsign } from './scheduler.ts';

const clock = fixedClock(1_700_000_000_000);
const FLIGHT = '00000000-0000-7000-8000-000000000001';

function detected(callsign: string | null): EventEnvelope {
  return makeEnvelope(
    {
      type: 'FlightDetected',
      occurredAt: '2023-11-14T22:13:20.000Z',
      dedupeKey: `${FLIGHT}:detected`,
      partitionKey: FLIGHT,
      payload: {
        flightId: FLIGHT,
        icao24: '4bb1a2',
        callsign,
        firstPosition: { lat: 41, lon: 29, ts: '2023-11-14T22:13:20.000Z' },
        source: 'fixture',
      },
    },
    { producer: 'tracker', clock },
  );
}

class FakeQueue implements EnqueueQueue {
  added: { data: unknown; opts: { jobId?: string } | undefined }[] = [];
  async add(_name: string, data: unknown, opts?: { jobId?: string }) {
    this.added.push({ data, opts });
    return {};
  }
}

function catalog(map: Record<string, string>): CatalogRepo {
  return {
    getAirlineByIcao: async (icao: string): Promise<AirlineRow | null> => {
      const iata = map[icao.toUpperCase()];
      return iata ? { id: 'a', iata, icao, name: icao, providerKey: null } : null;
    },
    getAirlineIdByIata: async () => null,
    getIcaoByIata: async () => null,
    getAirportIdByIata: async () => null,
    getAircraftIdByRegistration: async () => null,
    getFlightIcao24: async () => null,
    getIcao24ByRegistration: async () => null,
  };
}

function make(map: Record<string, string> = { THY: 'TK' }) {
  const queue = new FakeQueue();
  const scheduler = new ProviderScheduler({
    queue,
    catalog: catalog(map),
    logger: createLogger({ level: 'error', base: {} }),
  });
  return { queue, scheduler };
}

describe('parseCallsign', () => {
  test('splits ICAO prefix + flight digits', () => {
    expect(parseCallsign('THY1TG')).toEqual({ icao: 'THY', number: '1' });
    expect(parseCallsign('thy1234')).toEqual({ icao: 'THY', number: '1234' });
    expect(parseCallsign('N12345')).toBeNull(); // not a 3-letter airline prefix
    expect(parseCallsign('TK')).toBeNull();
  });
});

describe('ProviderScheduler', () => {
  test('enqueues a provider fetch for a known airline', async () => {
    const { queue, scheduler } = make();
    await scheduler.onEvent(detected('THY1TG'));
    expect(queue.added).toHaveLength(1);
    expect(queue.added[0]?.data).toEqual({
      flightId: FLIGHT,
      airlineIata: 'TK',
      flightNumber: 'TK1',
      date: '2023-11-14',
    });
    expect(queue.added[0]?.opts?.jobId).toBe(`pf-${FLIGHT}`);
  });

  test('skips unknown airlines, missing callsigns, and non-detection events', async () => {
    const { queue, scheduler } = make();
    await scheduler.onEvent(detected('ZZZ1')); // unknown ICAO
    await scheduler.onEvent(detected(null)); // no callsign
    await scheduler.onEvent(detected('N123')); // unparseable
    expect(queue.added).toHaveLength(0);
  });
});
