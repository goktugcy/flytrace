import { describe, expect, test } from 'bun:test';
import { MetricsRegistry } from './index.ts';

describe('MetricsRegistry', () => {
  test('counter accumulates per label set and renders', () => {
    const reg = new MetricsRegistry();
    const c = reg.counter('http_requests_total', 'reqs');
    c.inc({ method: 'GET', status: '200' });
    c.inc({ method: 'GET', status: '200' });
    c.inc({ method: 'POST', status: '201' });
    const out = reg.render();
    expect(out).toContain('# TYPE http_requests_total counter');
    expect(out).toContain('http_requests_total{method="GET",status="200"} 2');
    expect(out).toContain('http_requests_total{method="POST",status="201"} 1');
  });

  test('gauge set/inc/dec', () => {
    const reg = new MetricsRegistry();
    const g = reg.gauge('ws_connections', 'conns');
    g.inc();
    g.inc();
    g.dec();
    g.set(5);
    expect(reg.render()).toContain('ws_connections 5');
  });

  test('histogram emits cumulative buckets + sum + count', () => {
    const reg = new MetricsRegistry();
    const h = reg.histogram('dur_seconds', 'dur', [0.1, 1]);
    h.observe(0.05);
    h.observe(0.5);
    h.observe(2);
    const out = reg.render();
    expect(out).toContain('dur_seconds_bucket{le="0.1"} 1'); // only 0.05
    expect(out).toContain('dur_seconds_bucket{le="1"} 2'); // 0.05, 0.5
    expect(out).toContain('dur_seconds_bucket{le="+Inf"} 3');
    expect(out).toContain('dur_seconds_count 3');
    expect(out).toContain('dur_seconds_sum 2.55');
  });
});
