import { describe, expect, test } from 'bun:test';
import type { Span, SpanAttributes, SpanStatus, Tracer } from '@flytrace/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import { tracingMiddleware } from './request-tracing.ts';

interface Recorded {
  name: string;
  attributes: SpanAttributes;
  status: SpanStatus;
  exceptions: unknown[];
  ended: boolean;
}

/** Minimal in-memory Tracer capturing everything the middleware sets. */
function fakeTracer(): { tracer: Tracer; spans: Recorded[] } {
  const spans: Recorded[] = [];
  const makeSpan = (name: string, attrs?: SpanAttributes): { span: Span; rec: Recorded } => {
    const rec: Recorded = {
      name,
      attributes: { ...(attrs ?? {}) },
      status: 'unset',
      exceptions: [],
      ended: false,
    };
    const span: Span = {
      traceId: 'trace',
      spanId: 'span',
      setAttribute(key, value) {
        rec.attributes[key] = value;
        return this;
      },
      recordException(err) {
        rec.exceptions.push(err);
        rec.status = 'error';
        return this;
      },
      setStatus(status) {
        rec.status = status;
        return this;
      },
      end() {
        rec.ended = true;
      },
    };
    return { span, rec };
  };

  const tracer: Tracer = {
    name: 'fake',
    startSpan(name, attributes) {
      const { span, rec } = makeSpan(name, attributes);
      spans.push(rec);
      return span;
    },
    async withSpan(name, fn, attributes) {
      const { span, rec } = makeSpan(name, attributes);
      spans.push(rec);
      try {
        return await fn(span);
      } catch (err) {
        rec.exceptions.push(err);
        rec.status = 'error';
        throw err;
      } finally {
        rec.ended = true;
      }
    },
  };
  return { tracer, spans };
}

const appWith = (tracer: Tracer) => {
  const app = new Hono<AppEnv>();
  app.use('*', tracingMiddleware(tracer));
  app.get('/airports/:iata', (c) => c.json({ iata: c.req.param('iata') }));
  app.get('/boom', (c) => c.json({ error: true }, 500));
  return app;
};

describe('tracingMiddleware', () => {
  test('emits a span with method, matched route, status and ends it', async () => {
    const { tracer, spans } = fakeTracer();
    const res = await appWith(tracer).request('/airports/IST');
    expect(res.status).toBe(200);
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.attributes['http.method']).toBe('GET');
    expect(span.attributes['http.route']).toBe('/airports/:iata');
    expect(span.attributes['http.status']).toBe(200);
    expect(span.status).not.toBe('error');
    expect(span.ended).toBe(true);
  });

  test('propagates the request id when present', async () => {
    const { tracer, spans } = fakeTracer();
    await appWith(tracer).request('/airports/IST', {
      headers: { 'x-request-id': 'req-123' },
    });
    expect(spans[0]?.attributes['request.id']).toBe('req-123');
  });

  test('marks 5xx responses as error', async () => {
    const { tracer, spans } = fakeTracer();
    const res = await appWith(tracer).request('/boom');
    expect(res.status).toBe(500);
    expect(spans[0]?.attributes['http.status']).toBe(500);
    expect(spans[0]?.status).toBe('error');
  });
});
