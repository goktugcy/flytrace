import { describe, expect, test } from 'bun:test';
import { resolveDigestFrequency, shouldSend } from './preferences.ts';

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

describe('resolveDigestFrequency', () => {
  test('null/undefined prefs → off', () => {
    expect(resolveDigestFrequency(null)).toBe('off');
    expect(resolveDigestFrequency(undefined)).toBe('off');
  });

  test('enabled === false forces off even with a frequency', () => {
    expect(resolveDigestFrequency({ enabled: false, frequency: 'daily' })).toBe('off');
  });

  test('explicit valid frequency wins when enabled', () => {
    expect(resolveDigestFrequency({ enabled: true, frequency: 'daily' })).toBe('daily');
    expect(resolveDigestFrequency({ frequency: 'weekly' })).toBe('weekly');
  });

  test('enabled without a frequency uses the default cadence', () => {
    expect(resolveDigestFrequency({ enabled: true })).toBe('weekly');
  });

  test('no enabled flag and no frequency → off', () => {
    expect(resolveDigestFrequency({})).toBe('off');
  });
});

describe('shouldSend', () => {
  const now = new Date('2026-07-19T12:00:00Z');

  test('off is never due', () => {
    expect(shouldSend(now, null, 'off')).toBe(false);
    expect(shouldSend(now, new Date(0), 'off')).toBe(false);
  });

  test('never-sent is due immediately for daily/weekly', () => {
    expect(shouldSend(now, null, 'daily')).toBe(true);
    expect(shouldSend(now, undefined, 'weekly')).toBe(true);
  });

  test('daily is due once 24h elapsed', () => {
    expect(shouldSend(now.getTime(), now.getTime() - DAY, 'daily')).toBe(true);
    expect(shouldSend(now.getTime(), now.getTime() - (DAY - 1000), 'daily')).toBe(false);
  });

  test('weekly is due once 7d elapsed', () => {
    expect(shouldSend(now.getTime(), now.getTime() - WEEK, 'weekly')).toBe(true);
    expect(shouldSend(now.getTime(), now.getTime() - (WEEK - 1000), 'weekly')).toBe(false);
  });

  test('accepts Date and epoch-ms interchangeably', () => {
    const last = new Date(now.getTime() - DAY);
    expect(shouldSend(now, last, 'daily')).toBe(true);
  });
});
