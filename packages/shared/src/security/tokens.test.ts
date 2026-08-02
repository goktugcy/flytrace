import { describe, expect, test } from 'bun:test';
import {
  TOKEN_HASH_HEX_LENGTH,
  hashKeyComponent,
  hashToken,
  randomToken,
  sha256TokenHasher,
  timingSafeEqualHex,
  timingSafeEqualString,
} from './tokens.ts';

describe('security tokens', () => {
  test('randomToken yields 256 bits of hex and never repeats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const t = randomToken();
      expect(t).toMatch(/^[0-9a-f]{64}$/);
      expect(seen.has(t)).toBe(false);
      seen.add(t);
    }
  });

  test('randomToken honours a custom byte width', () => {
    expect(randomToken(16)).toMatch(/^[0-9a-f]{32}$/);
  });

  test('hashToken is deterministic, one-way and fixed width', () => {
    const token = randomToken();
    const digest = hashToken(token);
    expect(digest).toHaveLength(TOKEN_HASH_HEX_LENGTH);
    expect(hashToken(token)).toBe(digest);
    expect(digest).not.toContain(token);
    expect(hashToken(`${token}x`)).not.toBe(digest);
  });

  test('known-answer vectors pin the digest convention', () => {
    // NIST SHA-256 vectors — guard against a silent algorithm swap that would
    // orphan every hash already written to the database.
    expect(hashToken('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('sha256TokenHasher matches hashToken', () => {
    expect(sha256TokenHasher.hash('abc')).toBe(hashToken('abc'));
  });

  test('timingSafeEqualHex compares digests safely', () => {
    const a = hashToken('a');
    expect(timingSafeEqualHex(a, a)).toBe(true);
    expect(timingSafeEqualHex(a, hashToken('b'))).toBe(false);
    expect(timingSafeEqualHex(a, '')).toBe(false);
    expect(timingSafeEqualHex('', '')).toBe(false);
    expect(timingSafeEqualHex(a, a.slice(0, 10))).toBe(false);
  });

  test('timingSafeEqualString handles unequal lengths without throwing', () => {
    expect(timingSafeEqualString('internal-token', 'internal-token')).toBe(true);
    expect(timingSafeEqualString('internal-token', 'nope')).toBe(false);
    expect(timingSafeEqualString('', '')).toBe(true);
  });

  test('hashKeyComponent normalises untrusted key material', () => {
    const key = hashKeyComponent('user@example.com');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).not.toContain('@');
    // Injection attempts cannot escape into the key namespace.
    expect(hashKeyComponent('a:b\nc')).toMatch(/^[0-9a-f]{32}$/);
    expect(hashKeyComponent('a')).not.toBe(hashKeyComponent('b'));
  });
});
