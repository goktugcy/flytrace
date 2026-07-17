import { describe, expect, test } from 'bun:test';
import { CircuitBreaker } from './circuit-breaker.ts';

describe('CircuitBreaker', () => {
  test('opens after the failure threshold, then blocks', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, openMs: 1000 });
    expect(cb.canRequest(0)).toBe(true);
    cb.recordFailure(0);
    cb.recordFailure(0);
    expect(cb.current).toBe('closed');
    cb.recordFailure(0); // 3rd → open
    expect(cb.current).toBe('open');
    expect(cb.canRequest(500)).toBe(false); // still cooling down
  });

  test('half-opens after cooldown and closes on success', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, openMs: 1000 });
    cb.recordFailure(0);
    expect(cb.current).toBe('open');
    expect(cb.canRequest(1000)).toBe(true); // cooldown elapsed → probe
    expect(cb.current).toBe('half-open');
    cb.recordSuccess();
    expect(cb.current).toBe('closed');
  });

  test('re-opens if the half-open probe fails', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, openMs: 1000 });
    cb.recordFailure(0);
    cb.canRequest(1000); // → half-open
    cb.recordFailure(1000); // probe failed → open again
    expect(cb.current).toBe('open');
    expect(cb.canRequest(1500)).toBe(false);
  });

  test('success resets the failure count', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, openMs: 1000 });
    cb.recordFailure(0);
    cb.recordSuccess();
    cb.recordFailure(0);
    expect(cb.current).toBe('closed'); // only 1 consecutive failure
  });
});
