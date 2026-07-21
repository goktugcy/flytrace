import { describe, expect, test } from 'bun:test';
import { handleMetricsRequest } from './metrics-server.ts';

const registry = { render: () => 'tracker_provider_requests_total 3\n' };

describe('handleMetricsRequest', () => {
  test('GET /metrics returns the rendered registry as Prometheus text', async () => {
    const res = handleMetricsRequest(new Request('http://x/metrics'), registry);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('tracker_provider_requests_total 3');
  });

  test('GET /health and /ready report ok', async () => {
    for (const path of ['/health', '/ready']) {
      const res = handleMetricsRequest(new Request(`http://x${path}`), registry);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok', service: 'tracker' });
    }
  });

  test('unknown paths 404', () => {
    expect(handleMetricsRequest(new Request('http://x/nope'), registry).status).toBe(404);
  });
});
