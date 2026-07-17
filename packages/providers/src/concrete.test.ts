import { describe, expect, test } from 'bun:test';
import { createLogger, fixedClock } from '@flytrace/shared';
import {
  type AjetRaw,
  type PegasusRaw,
  type ThyRaw,
  concreteProviderFactories,
  normalizeAjet,
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
  test('register thy/pegasus/ajet with their IATA codes', () => {
    const keys = concreteProviderFactories().map((f) => f.key);
    expect(keys).toEqual(['thy', 'pegasus', 'ajet']);
    const iatas = concreteProviderFactories().flatMap((f) => f.airlineIata);
    expect(iatas).toEqual(['TK', 'PC', 'VF']);
  });

  test('THY fetches + normalizes through the base pipeline when configured', async () => {
    const factory = concreteProviderFactories()[0];
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
    const factory = concreteProviderFactories()[1]; // pegasus
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
});
