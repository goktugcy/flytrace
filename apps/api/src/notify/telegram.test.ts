import { describe, expect, test } from 'bun:test';
import { createApp } from '../app.ts';
import { testContext } from '../testing/context.ts';

const SECRET = 'telegram-webhook-secret-32-chars-x';
const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/** A context with Telegram fully configured, as a deployment would have it. */
const configuredCtx = () =>
  testContext({
    config: {
      TELEGRAM_BOT_TOKEN: '123:abc',
      TELEGRAM_BOT_USERNAME: 'FlyTraceBot',
      TELEGRAM_WEBHOOK_SECRET: SECRET,
    },
  });

function post(app: ReturnType<typeof createApp>, headers: Record<string, string> = {}) {
  return app.request('/api/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ message: { chat: { id: 123 }, text: '/start sometoken' } }),
  });
}

describe('telegram routes', () => {
  test('link requires auth (401)', async () => {
    const res = await createApp(configuredCtx()).request('/api/v1/channels/telegram/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  test('webhook accepts a correctly-signed update (unknown token → no crash)', async () => {
    const res = await post(createApp(configuredCtx()), { [SECRET_HEADER]: SECRET });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
  });

  test('webhook rejects an update with no secret header', async () => {
    expect((await post(createApp(configuredCtx()))).status).toBe(403);
  });

  test('webhook rejects an update with the wrong secret', async () => {
    const res = await post(createApp(configuredCtx()), { [SECRET_HEADER]: 'not-the-secret' });
    expect(res.status).toBe(403);
  });

  test('webhook fails CLOSED when no secret is configured', async () => {
    // The endpoint is public. It used to skip verification entirely when the
    // secret was unset, so anyone could forge a /stop and silence a user, or
    // make the bot message arbitrary chats. Now it refuses everything instead.
    const app = createApp(
      testContext({ config: { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_BOT_USERNAME: 'B' } }),
    );
    expect((await post(app)).status).toBe(403);
    expect((await post(app, { [SECRET_HEADER]: '' })).status).toBe(403);
  });
});
