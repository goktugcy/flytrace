/**
 * Per-request tracing middleware (docs/14 observability). Wraps every request in
 * a span from the foundation `Tracer` ('@flytrace/shared' createTracer/Tracer),
 * annotating it with `http.method`, `http.route`, `http.status`, and the
 * request id. The tracer is injected so the exporter (noop/console/otlp) is
 * chosen once at composition from OTEL_* config; the middleware itself is pure.
 *
 * Route and status are read AFTER `next()` so the matched route pattern (not the
 * wildcard the middleware was mounted on) and the final response code are
 * captured, even when a downstream handler throws.
 */
import type { Tracer } from '@flytrace/shared';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app.ts';

export function tracingMiddleware(tracer: Tracer): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const method = c.req.method;
    const requestId = c.get('requestId') ?? c.req.header('x-request-id');

    await tracer.withSpan('http.request', async (span) => {
      span.setAttribute('http.method', method);
      if (requestId) span.setAttribute('request.id', requestId);
      try {
        await next();
      } finally {
        // routePath is the matched pattern (e.g. /airports/:iata); fall back to
        // the concrete path if routing never resolved (404 / early throw).
        const route = c.req.routePath ?? c.req.path;
        const status = c.res?.status ?? 0;
        span.setAttribute('http.route', route);
        span.setAttribute('http.status', status);
        if (status >= 500) span.setStatus('error');
      }
    });
  };
}
