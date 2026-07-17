import { describe, expect, test } from 'bun:test';
import * as schema from './index.ts';

describe('schema', () => {
  test('exposes all core tables', () => {
    const expected = [
      'airlines',
      'airports',
      'aircraft',
      'users',
      'accounts',
      'sessions',
      'userSettings',
      'flights',
      'flightPositions',
      'flightEvents',
      'flightStatusSnapshot',
      'watchlistItems',
      'favorites',
      'notificationChannels',
      'notifications',
      'providers',
      'providerCache',
      'providerLogs',
      'auditLogs',
      'settings',
      'outbox',
    ] as const;
    for (const name of expected) {
      expect(schema[name]).toBeDefined();
    }
  });

  test('enums are defined', () => {
    expect(schema.flightStatus.enumValues).toContain('active');
    expect(schema.channel.enumValues).toEqual(['telegram', 'webpush', 'email']);
  });
});
