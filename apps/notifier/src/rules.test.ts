import { describe, expect, test } from 'bun:test';
import { evaluate, inQuietHours, isCritical, localHhMm } from './rules.ts';

const AT_2213_UTC = 1_700_000_000_000; // 2023-11-14T22:13:20Z

describe('rules helpers', () => {
  test('isCritical covers time-sensitive types', () => {
    expect(isCritical('delay')).toBe(true);
    expect(isCritical('gate_change')).toBe(true);
    expect(isCritical('cancelled')).toBe(true);
    expect(isCritical('takeoff')).toBe(false);
  });

  test('localHhMm formats in the given tz', () => {
    expect(localHhMm(AT_2213_UTC, 'UTC')).toBe('22:13');
    expect(localHhMm(AT_2213_UTC, 'Europe/Istanbul')).toBe('01:13'); // +3
  });

  test('inQuietHours handles wrap past midnight', () => {
    expect(inQuietHours(AT_2213_UTC, { tz: 'UTC', start: '22:00', end: '07:00' })).toBe(true);
    expect(inQuietHours(AT_2213_UTC, { tz: 'UTC', start: '08:00', end: '17:00' })).toBe(false);
    expect(inQuietHours(AT_2213_UTC, { tz: 'UTC', start: '00:00', end: '00:00' })).toBe(false);
  });
});

describe('evaluate', () => {
  const q = { tz: 'UTC', start: '22:00', end: '07:00' };

  test('critical always delivers', () => {
    expect(
      evaluate({ dbType: 'delay', nowMs: AT_2213_UTC, quietHours: q, recentCount: 99, cap: 5 }),
    ).toEqual({ deliver: true });
  });

  test('non-critical suppressed in quiet hours', () => {
    expect(
      evaluate({ dbType: 'takeoff', nowMs: AT_2213_UTC, quietHours: q, recentCount: 0, cap: 5 }),
    ).toEqual({
      deliver: false,
      reason: 'quiet_hours',
    });
  });

  test('non-critical suppressed over the cap', () => {
    expect(
      evaluate({ dbType: 'takeoff', nowMs: AT_2213_UTC, quietHours: null, recentCount: 5, cap: 5 }),
    ).toEqual({
      deliver: false,
      reason: 'frequency_cap',
    });
  });

  test('delivers when clear of quiet hours and under cap', () => {
    expect(
      evaluate({ dbType: 'takeoff', nowMs: AT_2213_UTC, quietHours: null, recentCount: 1, cap: 5 }),
    ).toEqual({ deliver: true });
  });
});
