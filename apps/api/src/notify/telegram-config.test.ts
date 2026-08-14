import { describe, expect, test } from 'bun:test';
import { resolveTelegram } from './telegram-config.ts';

const SECRET = 's'.repeat(32);
const BOT = { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_BOT_USERNAME: 'FlyTraceBot' };

describe('resolveTelegram', () => {
  test('is disabled, and demands nothing, when no bot token is set', () => {
    const d = resolveTelegram({ APP_ENV: 'production' });
    expect(d.enabled).toBe(false);
    expect(d.botToken).toBeNull();
  });

  for (const env of ['production', 'staging']) {
    test(`refuses to boot in ${env} when the bot is enabled without a webhook secret`, () => {
      // The webhook is public: without the secret anyone can forge a /stop and
      // silence a user, or drive the bot into messaging arbitrary chats.
      expect(() => resolveTelegram({ APP_ENV: env, ...BOT })).toThrow(
        /TELEGRAM_WEBHOOK_SECRET is required/,
      );
    });

    test(`refuses a short secret in ${env}`, () => {
      expect(() =>
        resolveTelegram({ APP_ENV: env, ...BOT, TELEGRAM_WEBHOOK_SECRET: 'short' }),
      ).toThrow(/at least 16 characters/);
    });

    test(`refuses in ${env} without a bot username`, () => {
      // The deep link is built from it — otherwise it reads t.me/undefined.
      expect(() =>
        resolveTelegram({
          APP_ENV: env,
          TELEGRAM_BOT_TOKEN: '123:abc',
          TELEGRAM_WEBHOOK_SECRET: SECRET,
        }),
      ).toThrow(/TELEGRAM_BOT_USERNAME is required/);
    });
  }

  test('accepts a complete production configuration', () => {
    const d = resolveTelegram({ APP_ENV: 'production', ...BOT, TELEGRAM_WEBHOOK_SECRET: SECRET });
    expect(d).toEqual({
      enabled: true,
      botToken: '123:abc',
      botUsername: 'FlyTraceBot',
      webhookSecret: SECRET,
    });
  });

  test('strips a leading @ from the username', () => {
    // BotFather displays the handle as "@FlyTraceBot", and a pasted @ would
    // produce https://t.me/@FlyTraceBot?start=… which does not resolve.
    const d = resolveTelegram({
      APP_ENV: 'production',
      ...BOT,
      TELEGRAM_BOT_USERNAME: '@FlyTraceBot',
      TELEGRAM_WEBHOOK_SECRET: SECRET,
    });
    expect(d.botUsername).toBe('FlyTraceBot');
  });

  test('local development may run without a secret — the webhook then rejects everything', () => {
    const d = resolveTelegram({ APP_ENV: 'local', ...BOT });
    expect(d.enabled).toBe(true);
    expect(d.webhookSecret).toBeNull();
  });

  test('treats a whitespace-only secret as absent', () => {
    expect(() =>
      resolveTelegram({ APP_ENV: 'production', ...BOT, TELEGRAM_WEBHOOK_SECRET: '   ' }),
    ).toThrow(/TELEGRAM_WEBHOOK_SECRET is required/);
  });
});
