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
      idleTimeoutSec: 30,
      connectTimeoutSec: 5,
      maxLifetimeSec: 1800,
      statementTimeoutMs: 30_000,
      prepare: true,
    });
  });

  test('transaction mode ALWAYS forces prepare:false, even if PG_PREPARE=true', () => {
    expect(resolvePoolConfig({ PG_POOL_MODE: 'transaction', PG_PREPARE: 'true' })).toEqual({
      poolMode: 'transaction',
      max: 10,
      idleTimeoutSec: 30,
      connectTimeoutSec: 5,
      maxLifetimeSec: 1800,
      statementTimeoutMs: 30_000,
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

  test('DB_POOL_* aliases win over legacy PG_POOL_* values', () => {
    expect(
      resolvePoolConfig({
        DB_POOL_MODE: 'transaction',
        DB_POOL_MAX: '4',
        DB_POOL_IDLE_TIMEOUT_MS: '1250',
        DB_POOL_CONNECTION_TIMEOUT_MS: '5001',
        DB_POOL_MAX_LIFETIME_MS: '61000',
        DB_STATEMENT_TIMEOUT_MS: '9000',
        PG_POOL_MODE: 'session',
        PG_POOL_MAX: '20',
        PG_PREPARE: true,
      }),
    ).toEqual({
      poolMode: 'transaction',
      max: 4,
      idleTimeoutSec: 2,
      connectTimeoutSec: 6,
      maxLifetimeSec: 61,
      statementTimeoutMs: 9000,
      prepare: false,
    });
  });
});
