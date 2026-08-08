import { describe, expect, test } from 'bun:test';
import { createLogger } from '@flytrace/shared';
import { SecurityJanitor } from './security-janitor.ts';

const logger = createLogger({ level: 'error' });

function make(
  over: {
    sessions?: () => Promise<number>;
    links?: () => Promise<number>;
    resets?: () => Promise<number>;
  } = {},
) {
  const calls = { sessions: 0, links: 0, resets: 0 };
  const janitor = new SecurityJanitor({
    auth: {
      deleteExpiredSessions: async () => {
        calls.sessions += 1;
        return over.sessions ? over.sessions() : 3;
      },
      deleteExpiredPasswordResetTokens: async () => {
        calls.resets += 1;
        return over.resets ? over.resets() : 1;
      },
    },
    notify: {
      expireStaleLinkTokens: async () => {
        calls.links += 1;
        return over.links ? over.links() : 2;
      },
    },
    logger,
    intervalMs: 10,
  });
  return { janitor, calls };
}

describe('SecurityJanitor', () => {
  test('reaps expired sessions and stale link tokens', async () => {
    const { janitor, calls } = make();
    expect(await janitor.runOnce()).toEqual({ sessions: 3, linkTokens: 2, resetTokens: 1 });
    expect(calls).toEqual({ sessions: 1, links: 1, resets: 1 });
  });

  test('a failing session reap does not prevent the link-token reap', async () => {
    const { janitor } = make({
      sessions: () => Promise.reject(new Error('deadlock')),
    });
    // Housekeeping must never throw into the worker's event loop, and one
    // broken sweep must not block the other.
    expect(await janitor.runOnce()).toEqual({ sessions: 0, linkTokens: 2, resetTokens: 1 });
  });

  test('a failing sweep never throws', async () => {
    const { janitor } = make({
      sessions: () => Promise.reject(new Error('boom')),
      links: () => Promise.reject(new Error('boom')),
      resets: () => Promise.reject(new Error('boom')),
    });
    expect(await janitor.runOnce()).toEqual({ sessions: 0, linkTokens: 0, resetTokens: 0 });
  });

  test('start() schedules sweeps and stop() halts them', async () => {
    const { janitor, calls } = make();
    janitor.start();
    janitor.start(); // idempotent — must not double-schedule
    await new Promise((r) => setTimeout(r, 35));
    janitor.stop();
    const afterStop = calls.sessions;
    expect(afterStop).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 25));
    expect(calls.sessions).toBe(afterStop);
  });

  test('does not sweep on start — only on the interval', async () => {
    const { janitor, calls } = make();
    janitor.start();
    // A rolling deploy would otherwise have every replica fire the same DELETE
    // at the same instant.
    expect(calls.sessions).toBe(0);
    janitor.stop();
  });
});
