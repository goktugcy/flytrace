import { describe, expect, test } from 'bun:test';
import { ProviderRegistry } from './registry.ts';
import { FakeProvider, fakeProviderContext } from './testing/index.ts';
import type { FlightProvider, ProviderFactory } from './types.ts';

function factory(key: string, iata: string[]): ProviderFactory {
  return {
    key,
    airlineIata: iata,
    create: (): FlightProvider => {
      const p = new FakeProvider();
      // Override identity fields for the test.
      Object.defineProperty(p, 'key', { value: key });
      Object.defineProperty(p, 'airlineIata', { value: iata });
      return p;
    },
  };
}

describe('ProviderRegistry', () => {
  test('activates only enabled providers and maps by airline IATA', async () => {
    const reg = await ProviderRegistry.build([factory('thy', ['TK']), factory('pegasus', ['PC'])], {
      enabled: new Set(['thy']),
      ctx: fakeProviderContext(),
    });
    expect(reg.get('thy')).not.toBeNull();
    expect(reg.get('pegasus')).toBeNull(); // not enabled
    expect(reg.forAirline('tk')?.key).toBe('thy'); // case-insensitive
    expect(reg.forAirline('PC')).toBeNull();
    expect(reg.all()).toHaveLength(1);
  });

  test('resolves airline conflicts by priority', async () => {
    const reg = await ProviderRegistry.build([factory('a', ['TK']), factory('b', ['TK'])], {
      enabled: new Set(['a', 'b']),
      priority: { b: 10, a: 1 },
      ctx: fakeProviderContext(),
    });
    expect(reg.forAirline('TK')?.key).toBe('b'); // higher priority wins
  });

  test('uses a wildcard provider as fallback for unmapped airlines', async () => {
    const reg = await ProviderRegistry.build([factory('aerodatabox', ['*'])], {
      enabled: new Set(['aerodatabox']),
      ctx: fakeProviderContext(),
    });
    expect(reg.forAirline('XQ')?.key).toBe('aerodatabox');
    expect(reg.get('aerodatabox')?.key).toBe('aerodatabox');
  });

  test('reports per-provider health', async () => {
    const reg = await ProviderRegistry.build([factory('thy', ['TK'])], {
      enabled: new Set(['thy']),
      ctx: fakeProviderContext(),
    });
    expect(await reg.health()).toEqual({ thy: 'up' });
  });
});
