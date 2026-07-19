/**
 * Cloudflare Turnstile bot-verification behind an interface so route handlers
 * never bind to a concrete CAPTCHA provider. The DEFAULT adapter is a mock that
 * accepts every token except the literal `'fail'`, so the whole app runs and is
 * fully testable with zero external services. Setting `TURNSTILE_SECRET` flips
 * the factory to the real Cloudflare siteverify adapter.
 */
import { type AdapterFactory, AppError, selectAdapter } from '@flytrace/shared';
import type { MiddlewareHandler } from 'hono';

type Fetcher = typeof fetch;

export interface TurnstileVerifyResult {
  success: boolean;
}

/** Port every verifier implements. */
export interface TurnstileVerifier {
  verify(token: string, ip?: string): Promise<TurnstileVerifyResult>;
}

/**
 * Local/CI default: no network. Succeeds for any token except `'fail'`, which
 * lets tests and manual QA deterministically exercise the rejection path.
 */
export class MockTurnstile implements TurnstileVerifier {
  async verify(token: string): Promise<TurnstileVerifyResult> {
    return { success: token !== 'fail' };
  }
}

/** Cloudflare's public siteverify endpoint. */
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface CloudflareTurnstileOptions {
  secret: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: Fetcher | undefined;
  /** Override the siteverify endpoint (tests / self-hosted proxy). */
  endpoint?: string | undefined;
}

/**
 * Production adapter: POSTs the token to Cloudflare's siteverify endpoint.
 * Any network/parse failure degrades to `{ success: false }` (fail-closed) so a
 * broken CAPTCHA backend rejects rather than silently admits traffic.
 */
export class CloudflareTurnstile implements TurnstileVerifier {
  private readonly secret: string;
  private readonly fetchImpl: Fetcher;
  private readonly endpoint: string;

  constructor(opts: CloudflareTurnstileOptions) {
    this.secret = opts.secret;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.endpoint = opts.endpoint ?? SITEVERIFY_URL;
  }

  async verify(token: string, ip?: string): Promise<TurnstileVerifyResult> {
    const body = new URLSearchParams();
    body.set('secret', this.secret);
    body.set('response', token);
    if (ip) body.set('remoteip', ip);
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { success: false };
      const json = (await res.json()) as { success?: boolean };
      return { success: json.success === true };
    } catch {
      return { success: false };
    }
  }
}

export interface TurnstileConfig {
  TURNSTILE_SECRET?: string | undefined;
}

export interface TurnstileFactoryDeps {
  fetchImpl?: Fetcher | undefined;
  logger?:
    | {
        warn: (msg: string, meta?: unknown) => void;
        info?: (msg: string, meta?: unknown) => void;
      }
    | undefined;
}

/**
 * Build the configured verifier. Chooses the Cloudflare adapter when
 * `TURNSTILE_SECRET` is present, otherwise falls back to the mock — via the
 * shared `selectAdapter` convention so behaviour matches every other module.
 */
export function createTurnstileVerifier(
  cfg: TurnstileConfig,
  deps: TurnstileFactoryDeps = {},
): Promise<TurnstileVerifier> {
  const adapters: Record<string, AdapterFactory<TurnstileVerifier>> = {
    mock: () => new MockTurnstile(),
    cloudflare: () =>
      new CloudflareTurnstile({
        secret: cfg.TURNSTILE_SECRET ?? '',
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      }),
  };
  return selectAdapter({
    label: 'turnstile',
    kind: cfg.TURNSTILE_SECRET ? 'cloudflare' : 'mock',
    adapters,
    fallback: 'mock',
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
}

export interface TurnstileMiddlewareOptions {
  /** Request header carrying the token (default `cf-turnstile-response`). */
  header?: string | undefined;
  /** Optional form field to read the token from when the header is absent. */
  field?: string | undefined;
  /** Header carrying the client IP (default `cf-connecting-ip`). */
  ipHeader?: string | undefined;
}

/**
 * Hono middleware that verifies a Turnstile token and 403s (FORBIDDEN) when it
 * is missing or invalid. Reads the token from a header by default; if `field`
 * is set it also inspects the parsed form body as a fallback.
 */
export function turnstileMiddleware(
  verifier: TurnstileVerifier,
  opts: TurnstileMiddlewareOptions = {},
): MiddlewareHandler {
  const header = opts.header ?? 'cf-turnstile-response';
  const ipHeader = opts.ipHeader ?? 'cf-connecting-ip';
  const field = opts.field;
  return async (c, next) => {
    let token = c.req.header(header);
    if (!token && field) {
      const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
      const value = (body as Record<string, unknown>)[field];
      if (typeof value === 'string') token = value;
    }
    if (!token) throw new AppError('FORBIDDEN', 'turnstile token required');
    const ip = c.req.header(ipHeader) ?? c.req.header('x-forwarded-for');
    const result = await verifier.verify(token, ip);
    if (!result.success) throw new AppError('FORBIDDEN', 'turnstile verification failed');
    await next();
  };
}
