import { describe, expect, test } from 'bun:test';
import { resolveEmailDelivery } from './email-delivery.ts';

const base = { EMAIL_API_URL: 'https://api.resend.com/emails' };

describe('resolveEmailDelivery', () => {
  test('builds an HTTP transport when a key is configured', () => {
    const decision = resolveEmailDelivery({
      ...base,
      APP_ENV: 'production',
      EMAIL_API_KEY: 'k'.repeat(20),
    });
    expect(decision.mode).toBe('http');
    expect(decision.transport).not.toBeNull();
  });

  for (const env of ['production', 'staging']) {
    test(`refuses to boot in ${env} without a key`, () => {
      // Silently undeliverable account recovery is worse than a failed deploy.
      expect(() => resolveEmailDelivery({ ...base, APP_ENV: env })).toThrow(
        /EMAIL_API_KEY is required/,
      );
    });

    test(`refuses in ${env} when the key is only whitespace`, () => {
      expect(() => resolveEmailDelivery({ ...base, APP_ENV: env, EMAIL_API_KEY: '   ' })).toThrow(
        /EMAIL_API_KEY is required/,
      );
    });
  }

  test('local development degrades instead, so the app runs with no external services', () => {
    const decision = resolveEmailDelivery({ ...base, APP_ENV: 'local' });
    expect(decision.mode).toBe('unavailable-local');
    expect(decision.transport).toBeNull();
  });

  test('the error names the real delivery path, not the notifier-only settings', () => {
    // Someone who set SMTP_URL and saw the API still refuse needs to know why.
    let message = '';
    try {
      resolveEmailDelivery({ ...base, APP_ENV: 'production' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('SMTP_URL');
    expect(message).toContain('notifier');
  });
});
