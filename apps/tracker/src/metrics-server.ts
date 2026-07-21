import type { Logger, MetricsRegistry } from '@flytrace/shared';

/**
 * A tiny HTTP surface for the tracker (which is otherwise a headless poll loop)
 * so Prometheus can scrape its process-local metrics registry. Serves
 * GET /metrics (Prometheus text) plus /health and /ready for liveness.
 */
export interface MetricsServer {
  stop(): void;
  port: number;
}

/** Route a request to the metrics/health responses. Pure — unit-testable without binding a port. */
export function handleMetricsRequest(
  req: Request,
  registry: Pick<MetricsRegistry, 'render'>,
): Response {
  const { pathname } = new URL(req.url);
  if (pathname === '/metrics') {
    return new Response(registry.render(), {
      headers: { 'content-type': 'text/plain; version=0.0.4' },
    });
  }
  if (pathname === '/health' || pathname === '/ready') {
    return new Response(JSON.stringify({ status: 'ok', service: 'tracker' }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response('not found', { status: 404 });
}

/** Start the scrape server, or return null when disabled (port <= 0). */
export function startMetricsServer(opts: {
  port: number;
  host: string;
  registry: MetricsRegistry;
  logger: Logger;
}): MetricsServer | null {
  if (opts.port <= 0) return null;
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.host,
    fetch: (req) => handleMetricsRequest(req, opts.registry),
  });
  opts.logger.info('tracker metrics server listening', { port: server.port, path: '/metrics' });
  return {
    stop: () => server.stop(true),
    port: server.port ?? opts.port,
  };
}
