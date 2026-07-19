import { describe, expect, test } from 'bun:test';
import { ReconnectPolicy, exponentialBackoff } from './reconnect.ts';

describe('exponentialBackoff', () => {
  test('doubles per attempt without jitter', () => {
    expect(exponentialBackoff({ base: 100, max: 10_000, attempt: 0 })).toBe(100);
    expect(exponentialBackoff({ base: 100, max: 10_000, attempt: 1 })).toBe(200);
    expect(exponentialBackoff({ base: 100, max: 10_000, attempt: 2 })).toBe(400);
    expect(exponentialBackoff({ base: 100, max: 10_000, attempt: 3 })).toBe(800);
  });

  test('clamps at max (and survives huge attempts)', () => {
    expect(exponentialBackoff({ base: 100, max: 1000, attempt: 10 })).toBe(1000);
    expect(exponentialBackoff({ base: 100, max: 1000, attempt: 100000 })).toBe(1000);
  });

  test('jitter draws within [raw*(1-jitter), raw]', () => {
    const raw = 800; // base 100, attempt 3
    expect(
      exponentialBackoff({ base: 100, max: 10_000, attempt: 3, jitter: 0.5, rng: () => 0 }),
    ).toBe(Math.round(raw * 0.5));
    expect(
      exponentialBackoff({ base: 100, max: 10_000, attempt: 3, jitter: 0.5, rng: () => 1 }),
    ).toBe(raw);
    expect(
      exponentialBackoff({ base: 100, max: 10_000, attempt: 3, jitter: 0.5, rng: () => 0.5 }),
    ).toBe(Math.round(raw * 0.75));
  });
});

describe('ReconnectPolicy', () => {
  test('onClose escalates the delay, onOpen resets', () => {
    const p = new ReconnectPolicy({ base: 100, max: 10_000 });
    expect(p.currentState).toBe('connected');
    const d1 = p.onClose();
    expect(d1).toMatchObject({ retry: true, delayMs: 100, attempt: 1, state: 'reconnecting' });
    const d2 = p.onClose();
    expect(d2).toMatchObject({ retry: true, delayMs: 200, attempt: 2 });
    p.onOpen();
    expect(p.currentState).toBe('connected');
    expect(p.attempts).toBe(0);
    expect(p.onClose().delayMs).toBe(100); // back to base
  });

  test('gives up after maxAttempts', () => {
    const p = new ReconnectPolicy({ base: 100, max: 10_000, maxAttempts: 2 });
    expect(p.onClose().retry).toBe(true); // attempt 1
    expect(p.onClose().retry).toBe(true); // attempt 2
    const giveUp = p.onClose(); // attempt 3 refused
    expect(giveUp).toMatchObject({ retry: false, delayMs: 0, state: 'given_up' });
    expect(p.currentState).toBe('given_up');
  });

  test('unlimited attempts when maxAttempts omitted', () => {
    const p = new ReconnectPolicy({ base: 1, max: 5 });
    for (let i = 0; i < 50; i += 1) expect(p.onClose().retry).toBe(true);
    expect(p.currentState).toBe('reconnecting');
  });

  test('reset returns to the initial state', () => {
    const p = new ReconnectPolicy({ base: 100, max: 10_000, maxAttempts: 1 });
    p.onClose();
    p.onClose(); // given_up
    p.reset();
    expect(p.currentState).toBe('connected');
    expect(p.attempts).toBe(0);
    expect(p.onClose().retry).toBe(true);
  });
});
