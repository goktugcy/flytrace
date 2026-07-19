import { describe, expect, test } from 'bun:test';
import { isAppError } from '@flytrace/shared';
import type { AppContext } from '../context.ts';
import { readFlightDebug } from './flight-debug.ts';

function fakeCtx(
  entries: Record<string, string | string[] | null>,
): Pick<AppContext, 'redis' | 'redisPrefix'> {
  return {
    redisPrefix: 'test:',
    redis: {
      get: async (key: string) => {
        const value = entries[key];
        return typeof value === 'string' ? value : null;
      },
      smembers: async (key: string) => {
        const value = entries[key];
        return Array.isArray(value) ? value : [];
      },
      mget: async (keys: string[]) =>
        keys.map((key) => {
          const value = entries[key];
          return typeof value === 'string' ? value : null;
        }),
    },
  } as unknown as Pick<AppContext, 'redis' | 'redisPrefix'>;
}

function state(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    flightId: 'F1',
    icao24: '4bb1a2',
    callsign: 'THY1',
    lat: 41,
    lon: 29,
    lastTs: '2026-01-01T00:00:00.000Z',
    qualityState: 'stale',
    selectedProvider: 'adsb',
    candidateProviders: ['adsb', 'opensky'],
    providerCandidates: [{ provider: 'adsb', selected: true }],
    sourceTimestamp: '2026-01-01T00:00:00.000Z',
    receivedAt: '2026-01-01T00:00:01.000Z',
    ageMs: 1000,
    lastAcceptedAt: '2026-01-01T00:00:01.000Z',
    lastRejectedAt: '2026-01-01T00:00:02.000Z',
    rejectionReason: 'duplicate_timestamp',
    rejectionHistory: [{ reason: 'duplicate_timestamp' }],
    qualityScore: 0.95,
    lastQualityTransitionAt: '2026-01-01T00:00:30.000Z',
    transitionHistory: [{ to: 'stale' }],
    sequence: 3,
    websocketPublishedAt: '2026-01-01T00:00:03.000Z',
    ...over,
  });
}

describe('readFlightDebug', () => {
  test('reads the active flight from the ICAO24 registry mapping', async () => {
    const debug = await readFlightDebug(
      fakeCtx({
        'test:flight:key:4bb1a2': 'F1',
        'test:flight:state:F1': state(),
      }),
      '4BB1A2',
    );

    expect(debug.flightId).toBe('F1');
    expect(debug.currentState.state).toBe('stale');
    expect(debug.currentState.selectedProvider).toBe('adsb');
    expect(debug.currentState.candidateProviders).toEqual(['adsb', 'opensky']);
    expect(debug.providerCandidates).toHaveLength(1);
    expect(debug.rejectionHistory).toHaveLength(1);
    expect(debug.transitionHistory).toHaveLength(1);
    expect(debug.currentState.websocketPublishedAt).toBe('2026-01-01T00:00:03.000Z');
  });

  test('falls back to scanning active states when the registry key is missing', async () => {
    const debug = await readFlightDebug(
      fakeCtx({
        'test:flights:active': ['F1'],
        'test:flight:state:F1': state(),
      }),
      '4bb1a2',
    );

    expect(debug.flightId).toBe('F1');
  });

  test('throws NOT_FOUND when no active state exists', async () => {
    try {
      await readFlightDebug(fakeCtx({}), '4bb1a2');
      throw new Error('expected readFlightDebug to throw');
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) expect(err.code).toBe('NOT_FOUND');
    }
  });
});
