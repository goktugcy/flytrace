import { describe, expect, it } from 'bun:test';
import { type AppError, isAppError } from '@flytrace/shared';
import type { Context } from 'hono';
import {
  CloudflareTurnstile,
  MockTurnstile,
  type TurnstileVerifier,
  createTurnstileVerifier,
  turnstileMiddleware,
} from './turnstile.ts';

describe('MockTurnstile', () => {
  it('succeeds for any token except "fail"', async () => {
    const v = new MockTurnstile();
    expect((await v.verify('ok')).success).toBe(true);
    expect((await v.verify('anything')).success).toBe(true);
    expect((await v.verify('fail')).success).toBe(false);
  });
});

describe('CloudflareTurnstile', () => {
  it('POSTs the token and returns the siteverify success flag', async () => {
    let seenUrl = '';
    let seenBody = '';
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = String(init?.body);
      return new Response(
        JSON.stringify({
          success: true,
          hostname: 'app.flytrace.local',
          action: 'turnstile-spin-v1',
          'error-codes': [],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const v = new CloudflareTurnstile({ secret: 's3cret', fetchImpl });
    const result = await v.verify('token-abc', '203.0.113.7');
    expect(result.success).toBe(true);
    expect(result.hostname).toBe('app.flytrace.local');
    expect(result.action).toBe('turnstile-spin-v1');
    expect(result.errorCodes).toEqual([]);
    expect(seenUrl).toContain('siteverify');
    expect(seenBody).toContain('secret=s3cret');
    expect(seenBody).toContain('response=token-abc');
    expect(seenBody).toContain('remoteip=203.0.113.7');
  });

  it('fails closed on non-ok response', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const v = new CloudflareTurnstile({ secret: 's', fetchImpl });
    const result = await v.verify('t');
    expect(result.success).toBe(false);
    expect(result.errorCodes).toEqual(['provider_http_error']);
  });

  it('fails closed when fetch throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const v = new CloudflareTurnstile({ secret: 's', fetchImpl });
    const result = await v.verify('t');
    expect(result.success).toBe(false);
    expect(result.errorCodes).toEqual(['provider_error']);
  });
});

describe('createTurnstileVerifier', () => {
  it('defaults to the mock when no secret is set', async () => {
    const v = await createTurnstileVerifier({});
    expect(v).toBeInstanceOf(MockTurnstile);
  });

  it('selects Cloudflare when TURNSTILE_SECRET is present', async () => {
    const v = await createTurnstileVerifier({ TURNSTILE_SECRET: 'x' });
    expect(v).toBeInstanceOf(CloudflareTurnstile);
  });
});

/** Build a minimal Hono-ish context exposing just what the middleware reads. */
function fakeContext(headers: Record<string, string>): Context {
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
      parseBody: async () => ({}),
    },
  } as unknown as Context;
}

describe('turnstileMiddleware', () => {
  const nextNoop = async () => {};

  it('bypasses verification when disabled', async () => {
    const mw = turnstileMiddleware(new MockTurnstile(), { enabled: false });
    const c = fakeContext({});
    let called = false;
    await mw(c, async () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it('403s when no token is present', async () => {
    const mw = turnstileMiddleware(new MockTurnstile());
    const c = fakeContext({});
    let caught: unknown;
    await mw(c, nextNoop).catch((e) => {
      caught = e;
    });
    expect(isAppError(caught)).toBe(true);
    expect((caught as AppError).httpStatus).toBe(403);
  });

  it('403s when verification fails', async () => {
    const mw = turnstileMiddleware(new MockTurnstile());
    const c = fakeContext({ 'cf-turnstile-response': 'fail' });
    let caught: unknown;
    await mw(c, nextNoop).catch((e) => {
      caught = e;
    });
    expect((caught as AppError).code).toBe('FORBIDDEN');
  });

  it('calls next when verification succeeds', async () => {
    const mw = turnstileMiddleware(new MockTurnstile());
    const c = fakeContext({ 'cf-turnstile-response': 'good' });
    let called = false;
    await mw(c, async () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it('enforces expected action and hostname', async () => {
    const verifier: TurnstileVerifier = {
      verify: async () => ({
        success: true,
        action: 'turnstile-spin-v1',
        hostname: 'app.flytrace.local',
      }),
    };
    const pass = turnstileMiddleware(verifier, {
      expectedAction: 'turnstile-spin-v1',
      expectedHostname: 'app.flytrace.local',
    });
    let called = false;
    await pass(fakeContext({ 'cf-turnstile-response': 'good' }), async () => {
      called = true;
    });
    expect(called).toBe(true);

    const fail = turnstileMiddleware(verifier, {
      expectedAction: 'wrong-action',
      expectedHostname: 'app.flytrace.local',
    });
    let caught: unknown;
    await fail(fakeContext({ 'cf-turnstile-response': 'good' }), nextNoop).catch((e) => {
      caught = e;
    });
    expect((caught as AppError).code).toBe('FORBIDDEN');
    expect((caught as AppError).message).toContain('action');
  });

  it('fails open only for provider errors when configured', async () => {
    const providerError: TurnstileVerifier = {
      verify: async () => ({ success: false, errorCodes: ['provider_error'] }),
    };
    let called = false;
    await turnstileMiddleware(providerError, { failOpen: true })(
      fakeContext({ 'cf-turnstile-response': 'good' }),
      async () => {
        called = true;
      },
    );
    expect(called).toBe(true);

    const invalidToken: TurnstileVerifier = {
      verify: async () => ({ success: false, errorCodes: ['invalid-input-response'] }),
    };
    let caught: unknown;
    await turnstileMiddleware(invalidToken, { failOpen: true })(
      fakeContext({ 'cf-turnstile-response': 'bad' }),
      nextNoop,
    ).catch((e) => {
      caught = e;
    });
    expect((caught as AppError).code).toBe('FORBIDDEN');
  });
});
