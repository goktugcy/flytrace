import { describe, expect, test } from 'bun:test';
import { selectAdapter } from './provider-kit.ts';
import { EnvSecretProvider, RemoteSecretProvider, createSecretProvider } from './secret.ts';
import { NoopTracer, createTracer } from './tracing.ts';

describe('selectAdapter', () => {
  const adapters = { mock: () => 'MOCK', real: () => 'REAL' };
  test('uses the requested adapter', async () => {
    expect(await selectAdapter({ label: 't', kind: 'real', adapters, fallback: 'mock' })).toBe(
      'REAL',
    );
  });
  test('falls back on unknown/missing kind', async () => {
    expect(await selectAdapter({ label: 't', kind: 'nope', adapters, fallback: 'mock' })).toBe(
      'MOCK',
    );
    expect(await selectAdapter({ label: 't', kind: undefined, adapters, fallback: 'mock' })).toBe(
      'MOCK',
    );
  });
  test('throws only if the fallback itself is absent', async () => {
    await expect(
      selectAdapter({ label: 't', kind: 'x', adapters, fallback: 'gone' }),
    ).rejects.toThrow();
  });
});

describe('EnvSecretProvider', () => {
  test('reads from the injected source and enforces required', async () => {
    const p = new EnvSecretProvider({ FOO: 'bar' });
    expect(await p.get('FOO')).toBe('bar');
    expect(await p.get('MISSING')).toBeUndefined();
    await expect(p.getRequired('MISSING')).rejects.toThrow(/missing required secret/);
  });
});

describe('RemoteSecretProvider', () => {
  test('serves from the resolver, caches, and falls back to env', async () => {
    let calls = 0;
    const p = new RemoteSecretProvider(
      'test',
      async (k) => {
        calls += 1;
        return k === 'REMOTE' ? 'value' : undefined;
      },
      new EnvSecretProvider({ LOCAL: 'fromEnv' }),
    );
    expect(await p.get('REMOTE')).toBe('value');
    expect(await p.get('REMOTE')).toBe('value'); // cached
    expect(calls).toBe(1);
    expect(await p.get('LOCAL')).toBe('fromEnv'); // resolver miss → env fallback
  });

  test('resolver errors fall back to env, never throw', async () => {
    const p = new RemoteSecretProvider(
      'test',
      async () => {
        throw new Error('remote down');
      },
      new EnvSecretProvider({ K: 'safe' }),
    );
    expect(await p.get('K')).toBe('safe');
  });
});

describe('createSecretProvider', () => {
  test('defaults to env', async () => {
    const p = await createSecretProvider({}, { source: { A: '1' } });
    expect(p.name).toBe('env');
    expect(await p.get('A')).toBe('1');
  });
  test('selects infisical and still falls back to env locally (no token)', async () => {
    const p = await createSecretProvider(
      { SECRET_PROVIDER: 'infisical' },
      { source: { A: 'envval' } },
    );
    expect(p.name).toBe('infisical');
    expect(await p.get('A')).toBe('envval'); // no INFISICAL_TOKEN → env fallback
  });
});

describe('createTracer', () => {
  test('noop by default; withSpan returns the value', async () => {
    const t = createTracer({});
    expect(t).toBeInstanceOf(NoopTracer);
    expect(await t.withSpan('op', () => 42)).toBe(42);
  });
  test('console exporter emits finished spans with duration', async () => {
    const spans: unknown[] = [];
    let clock = 1000;
    const t = createTracer(
      { OTEL_TRACES_EXPORTER: 'console' },
      { logger: { info: (_m, meta) => spans.push(meta) }, tracerDeps: { now: () => clock } },
    );
    await t.withSpan('work', () => {
      clock += 25;
    });
    expect(spans).toHaveLength(1);
    expect((spans[0] as { durationMs: number }).durationMs).toBe(25);
    expect((spans[0] as { status: string }).status).toBe('ok');
  });
  test('records exceptions and rethrows', async () => {
    const t = createTracer({ OTEL_TRACES_EXPORTER: 'console' }, { logger: { info: () => {} } });
    await expect(
      t.withSpan('boom', () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
  });
});
