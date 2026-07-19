import { describe, expect, test } from 'bun:test';
import { fixedClock } from '@flytrace/shared';
import type { Server } from 'bun';
import type { AppContext } from '../context.ts';
import { WsGateway } from './gateway.ts';
import type { TicketPayload } from './ticket.ts';

const ticket: TicketPayload = {
  uid: 'user-1',
  role: 'user',
  iat: 1_000,
  exp: 61_000,
  jti: 'ticket-1',
  bind: '',
};

const logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function fakeCtx(overrides: Partial<AppContext> = {}): AppContext {
  return {
    config: { AUTH_SECRET: 'test-auth-secret-at-least-16-chars' },
    logger,
    clock: fixedClock(1_000),
    redisPrefix: '',
    redis: {
      set: async () => 'OK',
    },
    db: {},
    metrics: undefined,
    close: async () => {},
    ...overrides,
  } as unknown as AppContext;
}

describe('WsGateway production guards', () => {
  test('rate-limits websocket connection attempts before upgrade', async () => {
    const gateway = new WsGateway(
      fakeCtx({
        wsRateLimiter: {
          allowConnect: () => false,
          allowMessage: () => true,
          release: () => {},
        },
      }),
    );
    const server = { upgrade: () => true } as unknown as Server<unknown>;

    const res = await gateway.handleUpgrade(new Request('http://api.test/ws'), server);
    expect(res?.status).toBe(429);
    expect(await res?.json()).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'too many websocket connection attempts',
      },
    });
  });

  test('tracks presence and blocks over-limit inbound messages', () => {
    const joined: string[] = [];
    const left: string[] = [];
    const gateway = new WsGateway(
      fakeCtx({
        wsPresence: {
          async join(connId) {
            joined.push(connId);
          },
          async leave(connId) {
            left.push(connId);
          },
          async count() {
            return joined.length - left.length;
          },
          async list() {
            return [];
          },
        },
        wsRateLimiter: {
          allowConnect: () => true,
          allowMessage: () => false,
          release: (connId) => left.push(`release:${connId}`),
        },
      }),
    );
    const sent: unknown[] = [];
    const ws = {
      data: { connId: 'conn-1', ticket },
      send: (raw: string) => sent.push(JSON.parse(raw)),
      close: () => {},
    };

    gateway.websocket.open?.(ws as never);
    gateway.websocket.message?.(ws as never, JSON.stringify({ t: 'ping' }));
    gateway.websocket.close?.(ws as never, 1000, '');

    expect(joined).toEqual(['conn-1']);
    expect(sent).toContainEqual({ t: 'error', code: 'RATE_LIMITED', message: 'too many messages' });
    expect(left).toEqual(['release:conn-1', 'conn-1']);
  });
});
