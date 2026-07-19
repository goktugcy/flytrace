import { describe, expect, test } from 'bun:test';
import {
  type CheckOutcome,
  type HealthCheck,
  HealthChecker,
  dbCheck,
  memoryCheck,
  queueCheck,
  redisCheck,
  wsCheck,
} from './health-checks.ts';

const fixed = (name: string, outcome: CheckOutcome): HealthCheck => ({
  name,
  check: async () => outcome,
});

describe('HealthChecker aggregation', () => {
  test('all ok → overall ok', async () => {
    const checker = new HealthChecker({
      checks: [fixed('a', { status: 'ok' }), fixed('b', { status: 'ok' })],
      version: '1.2.3',
      uptimeFn: () => 42.9,
    });
    const report = await checker.run();
    expect(report.status).toBe('ok');
    expect(report.version).toBe('1.2.3');
    expect(report.uptimeSec).toBe(42);
    expect(Object.keys(report.checks).sort()).toEqual(['a', 'b']);
    expect(report.checks.a?.status).toBe('ok');
    expect(report.checks.a?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('a degraded check → overall degraded', async () => {
    const checker = new HealthChecker({
      checks: [fixed('a', { status: 'ok' }), fixed('b', { status: 'degraded', detail: 'slow' })],
    });
    const report = await checker.run();
    expect(report.status).toBe('degraded');
    expect(report.checks.b?.detail).toBe('slow');
  });

  test('a down check dominates degraded → overall down', async () => {
    const checker = new HealthChecker({
      checks: [
        fixed('a', { status: 'degraded' }),
        fixed('b', { status: 'down' }),
        fixed('c', { status: 'ok' }),
      ],
    });
    const report = await checker.run();
    expect(report.status).toBe('down');
  });

  test('a throwing check is caught and degraded, never bubbles', async () => {
    const checker = new HealthChecker({
      checks: [
        fixed('ok', { status: 'ok' }),
        {
          name: 'boom',
          check: async () => {
            throw new Error('kaboom');
          },
        },
      ],
    });
    const report = await checker.run();
    expect(report.status).toBe('degraded');
    expect(report.checks.boom?.status).toBe('degraded');
    expect(report.checks.boom?.detail).toContain('kaboom');
  });

  test('a hanging check is timeout-guarded → degraded', async () => {
    const checker = new HealthChecker({
      timeoutMs: 10,
      checks: [
        fixed('ok', { status: 'ok' }),
        { name: 'stuck', check: () => new Promise<CheckOutcome>(() => {}) },
      ],
    });
    const report = await checker.run();
    expect(report.status).toBe('degraded');
    expect(report.checks.stuck?.status).toBe('degraded');
    expect(report.checks.stuck?.detail).toContain('timeout');
  });

  test('latency is measured from the injected clock', async () => {
    let t = 1000;
    const checker = new HealthChecker({
      checks: [fixed('a', { status: 'ok' })],
      now: () => {
        const v = t;
        t += 5;
        return v;
      },
    });
    const report = await checker.run();
    expect(report.checks.a?.latencyMs).toBe(5);
  });
});

describe('check factories', () => {
  test('dbCheck ok when ping resolves', async () => {
    const c = dbCheck(async () => [{ '?column?': 1 }]);
    expect(await c.check()).toEqual({ status: 'ok' });
    expect(c.name).toBe('db');
  });

  test('dbCheck rejects propagate (aggregator degrades them)', async () => {
    const c = dbCheck(async () => {
      throw new Error('no db');
    });
    await expect(c.check()).rejects.toThrow('no db');
  });

  test('redisCheck ok on PONG, degraded otherwise', async () => {
    expect(await redisCheck(async () => 'PONG').check()).toEqual({ status: 'ok' });
    const bad = await redisCheck(async () => 'nope').check();
    expect(bad.status).toBe('degraded');
    expect(bad.detail).toContain('nope');
  });

  test('queueCheck thresholds', async () => {
    expect((await queueCheck(() => 0).check()).status).toBe('ok');
    expect((await queueCheck(() => 5, { warnDepth: 3 }).check()).status).toBe('degraded');
    expect((await queueCheck(() => 50, { warnDepth: 3, downDepth: 40 }).check()).status).toBe(
      'down',
    );
    expect((await queueCheck(() => 7).check()).detail).toBe('depth=7');
  });

  test('wsCheck is informational ok with count detail', async () => {
    const r = await wsCheck(() => 12).check();
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('12');
  });

  test('memoryCheck ratio thresholds', async () => {
    const ok = await memoryCheck({ usageFn: () => ({ heapUsed: 10, heapTotal: 100 }) }).check();
    expect(ok.status).toBe('ok');
    const deg = await memoryCheck({
      warnRatio: 0.9,
      usageFn: () => ({ heapUsed: 95, heapTotal: 100 }),
    }).check();
    expect(deg.status).toBe('degraded');
    const down = await memoryCheck({
      warnRatio: 0.9,
      downRatio: 0.98,
      usageFn: () => ({ heapUsed: 99, heapTotal: 100 }),
    }).check();
    expect(down.status).toBe('down');
  });
});
