import { type Counter, type Gauge, type Histogram, MetricsRegistry } from '@flytrace/shared';

/** The api's metric set (docs/14 §observability). One registry per process. */
export interface ApiMetrics {
  registry: MetricsRegistry;
  httpRequests: Counter;
  httpDuration: Histogram;
  wsConnections: Gauge;
}

export function createApiMetrics(): ApiMetrics {
  const registry = new MetricsRegistry();
  return {
    registry,
    httpRequests: registry.counter('http_requests_total', 'Total HTTP requests'),
    httpDuration: registry.histogram('http_request_duration_seconds', 'HTTP request duration (s)'),
    wsConnections: registry.gauge('ws_connections', 'Active WebSocket connections'),
  };
}
