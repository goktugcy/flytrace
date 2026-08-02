import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createApp } from '../app.ts';
import type { AppEnv } from '../app.ts';
import type { AppContext } from '../context.ts';
import { testContext } from '../testing/context.ts';
import { createAdminRoutes } from './routes.ts';

const fakeCtx = (): AppContext =>
  testContext({
    redis: { llen: async () => 0, zcard: async () => 0 } as unknown as AppContext['redis'],
  });

function adminApp(ctx: AppContext) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'test-request');
    c.set('user', {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'admin@example.com',
      name: null,
      role: 'admin',
    });
    await next();
  });
  app.route('/api/v1', createAdminRoutes(ctx));
  return app;
}

describe('admin routes', () => {
  for (const p of [
    'stats',
    'queues',
    'providers',
    'flights',
    'airspace/imports',
    'debug/flights/4bb1a2',
    'dlq',
    'logs',
    'audit',
  ]) {
    test(`GET /admin/${p} → 401 without a session`, async () => {
      const res = await createApp(fakeCtx()).request(`/api/v1/admin/${p}`);
      expect(res.status).toBe(401);
    });
  }

  test('POST /admin/airspace/imports/openaip-global → 401 without a session', async () => {
    const res = await createApp(fakeCtx()).request(
      '/api/v1/admin/airspace/imports/openaip-global',
      {
        method: 'POST',
      },
    );
    expect(res.status).toBe(401);
  });

  test('POST /admin/airspace/imports/openaip-global enqueues one OpenAIP import job', async () => {
    const added: unknown[] = [];
    const fakeJob = {
      id: 'job-1',
      name: 'openaip.global',
      data: null,
      progress: {},
      failedReason: null,
      attemptsMade: 0,
      timestamp: Date.now(),
      processedOn: null,
      finishedOn: null,
      returnvalue: null,
      getState: async () => 'waiting',
    };
    const ctx = {
      ...fakeCtx(),
      config: {
        ...fakeCtx().config,
        OPENAIP_API_KEY: 'test-key',
      },
      airspaceImportQueue: {
        getJobs: async () => [],
        add: async (_name: string, data: unknown, opts: unknown) => {
          added.push({ data, opts });
          return { ...fakeJob, data };
        },
      },
    } as unknown as AppContext;
    const app = adminApp(ctx);

    const res = await app.request('/api/v1/admin/airspace/imports/openaip-global', {
      method: 'POST',
      body: JSON.stringify({ datasetVersion: 'openaip-global-test' }),
    });
    expect(res.status).toBe(202);
    expect(added).toHaveLength(1);
    expect((added[0] as { data: { datasetVersion: string } }).data.datasetVersion).toBe(
      'openaip-global-test',
    );
  });

  test('GET /admin/airspace/imports degrades instead of failing when queue reads fail', async () => {
    const ctx = {
      ...fakeCtx(),
      config: {
        ...fakeCtx().config,
        OPENAIP_API_KEY: 'test-key',
      },
      airspaceImportQueue: {
        getJobCounts: async () => {
          throw new Error('redis unavailable');
        },
        getJobs: async () => [],
      },
    } as unknown as AppContext;
    const app = adminApp(ctx);

    const res = await app.request('/api/v1/admin/airspace/imports');
    const body = (await res.json()) as {
      data: {
        configured: boolean;
        counts: Record<'waiting' | 'active' | 'completed' | 'failed' | 'delayed', number>;
        jobs: unknown[];
        error?: string;
      };
    };

    expect(res.status).toBe(200);
    expect(body.data.configured).toBe(true);
    expect(body.data.counts).toEqual({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    });
    expect(body.data.jobs).toEqual([]);
    expect(body.data.error).toContain('redis unavailable');
  });
});
