/**
 * Minimal OpenTelemetry-compatible tracing behind an interface, with no heavy
 * SDK dependency. Code calls `tracer.withSpan(...)`; the adapter is chosen by
 * env: `noop` (default, zero overhead), `console` (local visibility), or `otlp`
 * (buffers spans and ships them to an OTLP/HTTP collector). The span shape
 * matches OTel semantics so swapping in the real SDK later is mechanical.
 */
export type SpanAttributes = Record<string, string | number | boolean>;
export type SpanStatus = 'unset' | 'ok' | 'error';

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  setAttribute(key: string, value: string | number | boolean): this;
  recordException(err: unknown): this;
  setStatus(status: SpanStatus): this;
  end(): void;
}

export interface Tracer {
  readonly name: string;
  startSpan(name: string, attributes?: SpanAttributes): Span;
  /** Run `fn` in a span; auto-ends and records exceptions. */
  withSpan<T>(
    name: string,
    fn: (span: Span) => T | Promise<T>,
    attributes?: SpanAttributes,
  ): Promise<T>;
}

function hex(n: number, rand: () => number): string {
  let s = '';
  for (let i = 0; i < n; i += 1) s += Math.floor(rand() * 16).toString(16);
  return s;
}

export interface FinishedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  startMs: number;
  durationMs: number;
  attributes: SpanAttributes;
  status: SpanStatus;
  events: { name: string; attributes?: SpanAttributes }[];
}

class BasicSpan implements Span {
  readonly traceId: string;
  readonly spanId: string;
  private readonly attributes: SpanAttributes = {};
  private status: SpanStatus = 'unset';
  private readonly events: FinishedSpan['events'] = [];
  private readonly startMs: number;
  private ended = false;

  constructor(
    private readonly spanName: string,
    opts: {
      traceId: string;
      parentSpanId: string | null;
      now: () => number;
      rand: () => number;
      onEnd: (s: FinishedSpan) => void;
      attributes?: SpanAttributes;
    },
  ) {
    this.traceId = opts.traceId;
    this.spanId = hex(16, opts.rand);
    this.startMs = opts.now();
    if (opts.attributes) Object.assign(this.attributes, opts.attributes);
    this.now = opts.now;
    this.parentSpanId = opts.parentSpanId;
    this.onEnd = opts.onEnd;
  }
  private readonly now: () => number;
  private readonly parentSpanId: string | null;
  private readonly onEnd: (s: FinishedSpan) => void;

  setAttribute(key: string, value: string | number | boolean): this {
    this.attributes[key] = value;
    return this;
  }
  recordException(err: unknown): this {
    this.events.push({ name: 'exception', attributes: { message: String(err) } });
    this.status = 'error';
    return this;
  }
  setStatus(status: SpanStatus): this {
    this.status = status;
    return this;
  }
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.onEnd({
      name: this.spanName,
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      startMs: this.startMs,
      durationMs: this.now() - this.startMs,
      attributes: this.attributes,
      status: this.status === 'unset' ? 'ok' : this.status,
      events: this.events,
    });
  }
}

interface TracerDeps {
  now?: () => number;
  rand?: () => number;
}

class BasicTracer implements Tracer {
  private readonly now: () => number;
  private readonly rand: () => number;
  constructor(
    readonly name: string,
    private readonly onEnd: (s: FinishedSpan) => void,
    deps: TracerDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.rand = deps.rand ?? Math.random;
  }
  startSpan(name: string, attributes?: SpanAttributes): Span {
    return new BasicSpan(name, {
      traceId: hex(32, this.rand),
      parentSpanId: null,
      now: this.now,
      rand: this.rand,
      onEnd: this.onEnd,
      ...(attributes ? { attributes } : {}),
    });
  }
  async withSpan<T>(
    name: string,
    fn: (span: Span) => T | Promise<T>,
    attributes?: SpanAttributes,
  ): Promise<T> {
    const span = this.startSpan(name, attributes);
    try {
      const out = await fn(span);
      return out;
    } catch (err) {
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  }
}

/** No-op tracer — zero overhead, spans are discarded. */
export class NoopTracer extends BasicTracer {
  constructor(name = 'noop') {
    super(name, () => {});
  }
}

export interface TracingConfig {
  /** noop | console | otlp (default noop). */
  OTEL_TRACES_EXPORTER?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_SERVICE_NAME?: string;
}

/**
 * Build the configured tracer. `otlp` buffers finished spans and POSTs them to
 * the collector best-effort (never throws into the request path); without an
 * endpoint it degrades to `console`.
 */
export function createTracer(
  cfg: TracingConfig,
  deps: {
    logger?: {
      info: (m: string, meta?: unknown) => void;
      error?: (m: string, meta?: unknown) => void;
    };
    fetchImpl?: typeof fetch;
    tracerDeps?: TracerDeps;
  } = {},
): Tracer {
  const service = cfg.OTEL_SERVICE_NAME ?? 'flytrace';
  const kind = cfg.OTEL_TRACES_EXPORTER ?? 'noop';
  if (kind === 'console') {
    return new BasicTracer(
      service,
      (s) =>
        deps.logger?.info('span', {
          name: s.name,
          durationMs: Math.round(s.durationMs),
          traceId: s.traceId,
          status: s.status,
        }),
      deps.tracerDeps,
    );
  }
  if (kind === 'otlp' && cfg.OTEL_EXPORTER_OTLP_ENDPOINT) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const endpoint = cfg.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '');
    return new BasicTracer(
      service,
      (s) => {
        void fetchImpl(`${endpoint}/v1/traces`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ service, span: s }),
          signal: AbortSignal.timeout(3000),
        }).catch((err) => deps.logger?.error?.('otlp export failed', { err: String(err) }));
      },
      deps.tracerDeps,
    );
  }
  return new NoopTracer(service);
}
