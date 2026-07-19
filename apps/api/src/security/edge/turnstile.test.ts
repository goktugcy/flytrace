import { describe, expect, it } from 'bun:test';
import { type AppError, isAppError } from '@flytrace/shared';
import type { Context } from 'hono';
import {
  CloudflareTurnstile,
  MockTurnstile,
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
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as typeof fetch;
    const v = new CloudflareTurnstile({ secret: 's3cret', fetchImpl });
    const result = await v.verify('token-abc', '203.0.113.7');
    expect(result.success).toBe(true);
    expect(seenUrl).toContain('siteverify');
    expect(seenBody).toContain('secret=s3cret');
    expect(seenBody).toContain('response=token-abc');
    expect(seenBody).toContain('remoteip=203.0.113.7');
  });

  it('fails closed on non-ok response', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const v = new CloudflareTurnstile({ secret: 's', fetchImpl });
    expect((await v.verify('t')).success).toBe(false);
  });

  it('fails closed when fetch throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const v = new CloudflareTurnstile({ secret: 's', fetchImpl });
    expect((await v.verify('t')).success).toBe(false);
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
});
