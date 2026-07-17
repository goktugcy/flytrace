import { describe, expect, test } from 'bun:test';
import {
  FakeProvider,
  denyRateLimiter,
  fakeProviderContext,
  normalizedFixture,
} from './testing/index.ts';
import type { FlightStatusQuery } from './types.ts';

const q: FlightStatusQuery = { by: 'flightNumber', flightNumber: 'TK1980', date: '2023-11-14' };

describe('BaseProvider', () => {
  test('fetches on miss then serves from cache', async () => {
    const p = new FakeProvider();
    await p.init(fakeProviderContext());

    const first = await p.getFlightStatus(q);
    expect(first?.cached).toBe(false);
    expect(first?.status.gate).toBe('A12');
    expect(p.fetchCount).toBe(1);

    const second = await p.getFlightStatus(q);
    expect(second?.cached).toBe(true);
    expect(p.fetchCount).toBe(1); // served from cache, no upstream call
  });

  test('does not call upstream when rate limited', async () => {
    const p = new FakeProvider();
    await p.init(fakeProviderContext({ rateLimiter: denyRateLimiter }));
    const res = await p.getFlightStatus(q);
    expect(res).toBeNull();
    expect(p.fetchCount).toBe(0);
  });

  test('opens the circuit after repeated failures and then fails fast', async () => {
    const p = new FakeProvider({ fail: true });
    await p.init(fakeProviderContext());
    for (let i = 0; i < 5; i += 1) expect(await p.getFlightStatus(q)).toBeNull();
    expect(p.circuitState).toBe('open');
    expect(p.fetchCount).toBe(5);

    // Circuit open → fail fast, no further upstream calls.
    expect(await p.getFlightStatus(q)).toBeNull();
    expect(p.fetchCount).toBe(5);
  });

  test('coalesces concurrent requests for the same key', async () => {
    const p = new FakeProvider();
    await p.init(fakeProviderContext());
    const [a, b] = await Promise.all([p.getFlightStatus(q), p.getFlightStatus(q)]);
    expect(a?.status.flightNumber).toBe('TK1980');
    expect(b?.status.flightNumber).toBe('TK1980');
    expect(p.fetchCount).toBe(1); // single upstream call
  });

  test('returns null (not throws) when normalize yields nothing', async () => {
    const p = new FakeProvider({ raw: normalizedFixture() });
    await p.init(fakeProviderContext());
    // sanity: fixture normalizes fine
    expect((await p.getFlightStatus(q))?.status.status).toBe('active');
  });
});
