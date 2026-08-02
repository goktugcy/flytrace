import { describe, expect, it } from 'bun:test';
import { MIN_INTERNAL_TOKEN_LENGTH, resolveInternalAccess } from './internal-auth.ts';

const GOOD_TOKEN = 'x'.repeat(MIN_INTERNAL_TOKEN_LENGTH);

describe('resolveInternalAccess', () => {
  it('uses the token when one is configured', () => {
    const decision = resolveInternalAccess({
      APP_ENV: 'production',
      INTERNAL_API_TOKEN: GOOD_TOKEN,
    });
    expect(decision).toEqual({ enabled: true, token: GOOD_TOKEN, mode: 'token' });
  });

  it('rejects a token that is too short to be worth having', () => {
    expect(() =>
      resolveInternalAccess({ APP_ENV: 'production', INTERNAL_API_TOKEN: 'short' }),
    ).toThrow(/at least 32 characters/);
  });

  it('refuses to boot in production without a token', () => {
    expect(() => resolveInternalAccess({ APP_ENV: 'production' })).toThrow(
      /INTERNAL_API_TOKEN is required/,
    );
  });

  it('refuses to boot in staging without a token', () => {
    expect(() => resolveInternalAccess({ APP_ENV: 'staging' })).toThrow(
      /INTERNAL_API_TOKEN is required/,
    );
  });

  it('allows an explicit network-only opt-out', () => {
    const decision = resolveInternalAccess({
      APP_ENV: 'production',
      INTERNAL_ENDPOINTS_NETWORK_ONLY: true,
    });
    expect(decision.mode).toBe('network-only');
    expect(decision.token).toBeNull();
  });

  it('stays open in local development', () => {
    expect(resolveInternalAccess({ APP_ENV: 'local' }).mode).toBe('open-local');
  });

  it('treats a whitespace-only token as absent', () => {
    expect(() =>
      resolveInternalAccess({ APP_ENV: 'production', INTERNAL_API_TOKEN: '   ' }),
    ).toThrow(/INTERNAL_API_TOKEN is required/);
  });
});
