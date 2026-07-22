import { describe, expect, test } from 'bun:test';
import { createLogger, fixedClock } from '@flytrace/shared';
import {
  type AeroDataBoxRaw,
  type AjetRaw,
  type BaRaw,
  type LhRaw,
  type PegasusRaw,
  type ThyRaw,
  concreteProviderFactories,
  normalizeAeroDataBox,
  normalizeAjet,
  normalizeBa,
  normalizeLufthansa,
  normalizePegasus,
  normalizeThy,
} from './concrete.ts';
import type { FlightProvider, ProviderContext } from './types.ts';

const clock = fixedClock(1_700_000_000_000);
const FETCHED = clock.nowIso();

// ── Golden raw → normalized (pure, no HTTP) ──

describe('normalizeThy', () => {
  const raw: ThyRaw = {
    flightNo: 'TK1965',
    origin: 'ist',
    destination: 'lhr',
    status: 'Departed',
    gate: 'A12',
    terminal: '1',
    scheduledDeparture: '2023-11-14T09:00:00Z',
    actualDeparture: '2023-11-14T09:07:00Z',
    aircraftType: 'B77W',
    tail: 'TC-JJE',
  };
  test('maps vocabulary, uppercases codes, carries gate/tail', () => {
    const n = normalizeThy(raw, FETCHED);
    expect(n.airlineIata).toBe('TK');
    expect(n.status).toBe('active'); // "Departed" → active
    expect(n.origin).toBe('IST');
    expect(n.destination).toBe('LHR');
    expect(n.gate).toBe('A12');
    expect(n.registration).toBe('TC-JJE');
    expect(n.actualDeparture).toBe('2023-11-14T09:07:00Z');
    expect(n.estimatedDeparture).toBeUndefined(); // absent → omitted
  });
  test('unknown status token degrades to unknown', () => {
    expect(normalizeThy({ ...raw, status: 'Zorp' }, FETCHED).status).toBe('unknown');
  });
});

describe('normalizePegasus', () => {
  const raw: PegasusRaw = {
    flightNumber: 'PC2100',
    from: 'saw',
    to: 'esb',
    state: 'arrived',
    std: '2023-11-14T06:00:00Z',
    ata: '2023-11-14T07:10:00Z',
    equipment: 'A320',
  };
  test('maps state → canonical + schedule times', () => {
    const n = normalizePegasus(raw, FETCHED);
    expect(n.airlineIata).toBe('PC');
    expect(n.status).toBe('landed');
    expect(n.origin).toBe('SAW');
    expect(n.destination).toBe('ESB');
    expect(n.actualArrival).toBe('2023-11-14T07:10:00Z');
    expect(n.aircraftType).toBe('A320');
  });
});

describe('normalizeAjet', () => {
  const raw: AjetRaw = {
    flight: 'VF7001',
    dep: 'adb',
    arr: 'ist',
    flightStatus: 'DELAYED',
    gateNumber: 'C3',
    times: { schedOut: '2023-11-14T12:00:00Z', estOut: '2023-11-14T12:45:00Z' },
  };
  test('maps nested times + uppercase status', () => {
    const n = normalizeAjet(raw, FETCHED);
    expect(n.airlineIata).toBe('VF');
    expect(n.status).toBe('delayed');
    expect(n.gate).toBe('C3');
    expect(n.scheduledDeparture).toBe('2023-11-14T12:00:00Z');
    expect(n.estimatedDeparture).toBe('2023-11-14T12:45:00Z');
  });
  test('tolerates a missing times object', () => {
    const n = normalizeAjet({ ...raw, times: null }, FETCHED);
    expect(n.scheduledDeparture).toBeUndefined();
  });
});

describe('normalizeLufthansa', () => {
  const raw: LhRaw = {
    flightNumber: 'LH1300',
    status: 'Departed',
    departure: { airport: 'muc', scheduled: '2023-11-14T08:00:00Z', gate: 'G12', terminal: '2' },
    arrival: { airport: 'lhr', estimated: '2023-11-14T09:20:00Z' },
    aircraftType: 'A320',
  };
  test('maps nested departure/arrival + vocabulary', () => {
    const n = normalizeLufthansa(raw, FETCHED);
    expect(n.airlineIata).toBe('LH');
    expect(n.status).toBe('active');
    expect(n.origin).toBe('MUC');
    expect(n.destination).toBe('LHR');
    expect(n.gate).toBe('G12');
    expect(n.scheduledDeparture).toBe('2023-11-14T08:00:00Z');
    expect(n.estimatedArrival).toBe('2023-11-14T09:20:00Z');
  });
});

describe('normalizeBa', () => {
  const raw: BaRaw = {
    flight: 'BA117',
    from: 'lhr',
    to: 'jfk',
    flightStatus: 'Cancelled',
    depGate: 'A10',
    schedDep: '2023-11-14T10:00:00Z',
  };
  test('maps flat shape + vocabulary', () => {
    const n = normalizeBa(raw, FETCHED);
    expect(n.airlineIata).toBe('BA');
    expect(n.status).toBe('cancelled');
    expect(n.origin).toBe('LHR');
    expect(n.destination).toBe('JFK');
    expect(n.gate).toBe('A10');
  });
});

describe('normalizeAeroDataBox', () => {
  const raw: AeroDataBoxRaw = [
    {
      number: 'XQ 3',
      callSign: 'SXS3SB',
      status: 'Arrived',
      codeshareStatus: 'IsOperator',
      lastUpdatedUtc: '2026-07-19T22:10:00Z',
      departure: {
        airport: { iata: 'AYT', icao: 'LTAI', name: 'Antalya' },
        scheduledTime: { utc: '2026-07-19 20:35Z', local: '2026-07-19T23:35:00' },
        runwayTime: { utc: '2026-07-19 20:52:00Z', local: '2026-07-19T23:52:00' },
        gate: '211',
        terminal: '1',
      },
      arrival: {
        airport: { iata: 'IST', icao: 'LTFM', name: 'Istanbul' },
        scheduledTime: { utc: '2026-07-19T21:45:00Z', local: '2026-07-20T00:45:00' },
        revisedTime: { utc: '2026-07-19T21:58:00Z', local: '2026-07-20T00:58:00' },
        gate: 'A4',
        terminal: 'D',
        baggageBelt: '12',
      },
      airline: { iata: 'XQ', icao: 'SXS', name: 'SunExpress' },
      aircraft: { reg: 'TC-SOZ', model: 'Boeing 737-800' },
      isCargo: false,
    },
  ];

  test('maps AeroDataBox operations fields from callsign result', () => {
    const n = normalizeAeroDataBox(
      raw,
      {
        by: 'flightNumber',
        flightNumber: 'XQ3',
        date: '2026-07-19',
        callsign: 'SXS3SB',
        icao24: '4bce43',
      },
      FETCHED,
    );
    expect(n?.status).toBe('landed');
    expect(n?.flightNumber).toBe('XQ3');
    expect(n?.airlineIata).toBe('XQ');
    expect(n?.origin).toBe('AYT');
    expect(n?.destination).toBe('IST');
    expect(n?.gate).toBe('A4');
    expect(n?.terminal).toBe('D');
    expect(n?.baggageBelt).toBe('12');
    expect(n?.scheduledDeparture).toBe('2026-07-19T20:35:00Z');
    expect(n?.actualDeparture).toBe('2026-07-19T20:52:00Z');
    expect(n?.actualArrival).toBe('2026-07-19T21:58:00Z');
    expect(n?.registration).toBe('TC-SOZ');
  });

  test('rejects an unrelated result returned for a callsign lookup', () => {
    const n = normalizeAeroDataBox(
      raw,
      {
        by: 'flightNumber',
        flightNumber: 'XQ999',
        date: '2026-07-19',
        callsign: 'SXS9ZZ',
      },
      FETCHED,
    );
    expect(n).toBeNull();
  });
});

// ── Contract: registration list + through-the-base fetch/normalize ──

function ctxWith(raw: unknown, config: Record<string, unknown>): ProviderContext {
  return {
    http: { getJson: async () => raw },
    cache: { get: async () => null, set: async () => {} },
    rateLimiter: { tryAcquire: async () => true },
    logger: createLogger({ level: 'error', base: {} }),
    clock,
    config,
  };
}

describe('concrete provider factories', () => {
  test('register all concrete providers with their IATA codes', () => {
    const keys = concreteProviderFactories().map((f) => f.key);
    expect(keys).toEqual(['aerodatabox', 'thy', 'pegasus', 'ajet', 'lufthansa', 'ba']);
    const iatas = concreteProviderFactories().flatMap((f) => f.airlineIata);
    expect(iatas).toEqual(['*', 'TK', 'PC', 'VF', 'LH', 'BA']);
  });

  test('THY fetches + normalizes through the base pipeline when configured', async () => {
    const factory = concreteProviderFactories()[1];
    if (!factory) throw new Error('missing factory');
    const p: FlightProvider = factory.create();
    await p.init(
      ctxWith(
        { flightNo: 'TK1', origin: 'IST', destination: 'ESB', status: 'Landed' },
        {
          statusUrls: { thy: 'https://example.test/thy' },
        },
      ),
    );
    const res = await p.getFlightStatus({
      by: 'flightNumber',
      flightNumber: 'TK1',
      date: '2023-11-14',
    });
    expect(res?.status.status).toBe('landed');
    expect(res?.status.source).toBe('thy');
  });

  test('is inert (null) when statusUrl is not configured', async () => {
    const factory = concreteProviderFactories()[2]; // pegasus
    if (!factory) throw new Error('missing factory');
    const p = factory.create();
    await p.init(ctxWith({}, {})); // no statusUrl → fetchRaw throws → base returns null
    const res = await p.getFlightStatus({
      by: 'flightNumber',
      flightNumber: 'PC1',
      date: '2023-11-14',
    });
    expect(res).toBeNull();
  });

  test('AeroDataBox treats a null upstream response as a miss', async () => {
    const factory = concreteProviderFactories()[0];
    if (!factory) throw new Error('missing factory');
    const p = factory.create();
    await p.init(ctxWith(null, { aerodatabox: { apiKey: 'test-key' } }));
    const res = await p.getFlightStatus({
      by: 'flightNumber',
      flightNumber: 'XQ75',
      date: '2026-07-19',
    });
    expect(res).toBeNull();
  });
});
