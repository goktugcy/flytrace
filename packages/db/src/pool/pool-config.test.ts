import { describe, expect, test } from 'bun:test';
import { resolvePoolConfig, resolvePoolMode } from './pool-config.ts';

describe('resolvePoolMode', () => {
  test('defaults to session when unset or blank', () => {
    expect(resolvePoolMode(undefined)).toBe('session');
    expect(resolvePoolMode('')).toBe('session');
    expect(resolvePoolMode('   ')).toBe('session');
  });

  test('parses transaction case-insensitively, trimming whitespace', () => {
    expect(resolvePoolMode('transaction')).toBe('transaction');
    expect(resolvePoolMode('TRANSACTION')).toBe('transaction');
    expect(resolvePoolMode('  Transaction  ')).toBe('transaction');
  });

  test('any other value falls back to session', () => {
    expect(resolvePoolMode('statement')).toBe('session');
    expect(resolvePoolMode('nonsense')).toBe('session');
  });
});

describe('resolvePoolConfig', () => {
  test('empty env → session defaults, prepare on', () => {
    expect(resolvePoolConfig({})).toEqual({
      poolMode: 'session',
      max: 10,
      prepare: true,
    });
  });

  test('transaction mode ALWAYS forces prepare:false, even if PG_PREPARE=true', () => {
    expect(resolvePoolConfig({ PG_POOL_MODE: 'transaction', PG_PREPARE: 'true' })).toEqual({
      poolMode: 'transaction',
      max: 10,
      prepare: false,
    });
    // ...and when PG_PREPARE is unset.
    expect(resolvePoolConfig({ PG_POOL_MODE: 'transaction' }).prepare).toBe(false);
  });

  test('session mode honours PG_PREPARE', () => {
    expect(resolvePoolConfig({ PG_POOL_MODE: 'session', PG_PREPARE: 'false' }).prepare).toBe(false);
    expect(resolvePoolConfig({ PG_POOL_MODE: 'session', PG_PREPARE: '0' }).prepare).toBe(false);
    expect(resolvePoolConfig({ PG_POOL_MODE: 'session', PG_PREPARE: 'no' }).prepare).toBe(false);
    expect(resolvePoolConfig({ PG_POOL_MODE: 'session', PG_PREPARE: 'true' }).prepare).toBe(true);
    expect(resolvePoolConfig({ PG_POOL_MODE: 'session', PG_PREPARE: '1' }).prepare).toBe(true);
  });

  test('PG_POOL_MAX parses positive ints, else falls back to 10', () => {
    expect(resolvePoolConfig({ PG_POOL_MAX: '25' }).max).toBe(25);
    expect(resolvePoolConfig({ PG_POOL_MAX: '0' }).max).toBe(10);
    expect(resolvePoolConfig({ PG_POOL_MAX: '-5' }).max).toBe(10);
    expect(resolvePoolConfig({ PG_POOL_MAX: 'abc' }).max).toBe(10);
    expect(resolvePoolConfig({ PG_POOL_MAX: '' }).max).toBe(10);
  });
});
