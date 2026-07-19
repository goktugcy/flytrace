import { describe, expect, test } from 'bun:test';
import { createUnsubscribeTokens } from './unsubscribe.ts';

describe('createUnsubscribeTokens', () => {
  const tokens = createUnsubscribeTokens({ secret: 'super-secret-value' });

  test('round-trips a userId', () => {
    const token = tokens.generate('user-123');
    const result = tokens.validate(token);
    expect(result).toEqual({ ok: true, userId: 'user-123' });
  });

  test('round-trips userIds with special characters', () => {
    const id = 'a.b/c+d=e';
    const result = tokens.validate(tokens.generate(id));
    expect(result).toEqual({ ok: true, userId: id });
  });

  test('rejects a tampered signature', () => {
    const token = tokens.generate('user-123');
    const tampered = `${token.slice(0, -1)}${token.at(-1) === 'A' ? 'B' : 'A'}`;
    expect(tokens.validate(tampered)).toEqual({ ok: false, reason: 'invalid-signature' });
  });

  test('rejects a token signed with a different secret', () => {
    const other = createUnsubscribeTokens({ secret: 'different-secret' });
    const foreign = other.generate('user-123');
    expect(tokens.validate(foreign)).toEqual({ ok: false, reason: 'invalid-signature' });
  });

  test('rejects malformed tokens', () => {
    expect(tokens.validate('no-dot')).toEqual({ ok: false, reason: 'malformed' });
    expect(tokens.validate('.sig')).toEqual({ ok: false, reason: 'malformed' });
    expect(tokens.validate('payload.')).toEqual({ ok: false, reason: 'malformed' });
  });

  test('is deterministic for the same secret + user', () => {
    expect(tokens.generate('u')).toBe(tokens.generate('u'));
  });

  test('accepts an injected signer', () => {
    const custom = createUnsubscribeTokens({
      secret: 's',
      signer: (message, secret) => `${secret}:${message}`,
    });
    const token = custom.generate('abc');
    expect(custom.validate(token)).toEqual({ ok: true, userId: 'abc' });
  });

  test('throws when constructed without a secret', () => {
    expect(() => createUnsubscribeTokens({ secret: '' })).toThrow();
  });
});
