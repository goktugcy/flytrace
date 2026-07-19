import { describe, expect, test } from 'bun:test';
import {
  base32Decode,
  base32Encode,
  generateSecret,
  otpauthUri,
  totp,
  verifyTotp,
} from './totp.ts';

// RFC 6238 Appendix B uses the ASCII seed "12345678901234567890" (SHA-1).
const RFC_SEED = base32Encode(new TextEncoder().encode('12345678901234567890'));

describe('base32', () => {
  test('round-trips arbitrary bytes', () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255, 128, 64, 32]);
    expect(Array.from(base32Decode(base32Encode(bytes)))).toEqual(Array.from(bytes));
  });

  test('decode is case-insensitive and ignores spaces/padding', () => {
    const encoded = base32Encode(new TextEncoder().encode('hello'));
    const lower = encoded.toLowerCase();
    expect(Array.from(base32Decode(`${lower}  ===`))).toEqual(Array.from(base32Decode(encoded)));
  });

  test('rejects invalid characters', () => {
    expect(() => base32Decode('01890')).toThrow();
  });
});

describe('totp — RFC 6238 known vectors (SHA-1, 8 digits, step 30)', () => {
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [t, expected] of vectors) {
    test(`t=${t} → ${expected}`, () => {
      expect(totp(RFC_SEED, { t, step: 30, digits: 8 })).toBe(expected);
    });
  }
});

describe('verifyTotp', () => {
  test('accepts the current code', () => {
    const code = totp(RFC_SEED, { t: 1111111109, step: 30, digits: 8 });
    expect(verifyTotp(RFC_SEED, code, { t: 1111111109, step: 30, digits: 8, window: 1 })).toBe(
      true,
    );
  });

  test('accepts a code from ±1 step within the window', () => {
    const prev = totp(RFC_SEED, { t: 1111111109 - 30, step: 30, digits: 8 });
    const next = totp(RFC_SEED, { t: 1111111109 + 30, step: 30, digits: 8 });
    const opts = { t: 1111111109, step: 30, digits: 8, window: 1 } as const;
    expect(verifyTotp(RFC_SEED, prev, opts)).toBe(true);
    expect(verifyTotp(RFC_SEED, next, opts)).toBe(true);
  });

  test('rejects a code outside the window', () => {
    const old = totp(RFC_SEED, { t: 1111111109 - 90, step: 30, digits: 8 });
    expect(verifyTotp(RFC_SEED, old, { t: 1111111109, step: 30, digits: 8, window: 1 })).toBe(
      false,
    );
  });

  test('window:0 accepts only the exact step', () => {
    const prev = totp(RFC_SEED, { t: 1111111109 - 30, step: 30, digits: 8 });
    expect(verifyTotp(RFC_SEED, prev, { t: 1111111109, step: 30, digits: 8, window: 0 })).toBe(
      false,
    );
  });

  test('tolerates whitespace and rejects non-numeric input', () => {
    const code = totp(RFC_SEED, { t: 59, step: 30, digits: 8 });
    expect(verifyTotp(RFC_SEED, ` ${code} `, { t: 59, step: 30, digits: 8 })).toBe(true);
    expect(verifyTotp(RFC_SEED, 'notacode', { t: 59, step: 30, digits: 8 })).toBe(false);
  });
});

describe('generateSecret / otpauthUri', () => {
  test('generateSecret yields a decodable 20-byte secret by default', () => {
    const secret = generateSecret();
    expect(base32Decode(secret).length).toBe(20);
  });

  test('otpauthUri encodes issuer/account and params', () => {
    const uri = otpauthUri('ABCDEF', { issuer: 'FlyTrace', account: 'a@b.com' });
    expect(uri.startsWith('otpauth://totp/FlyTrace%3Aa%40b.com?')).toBe(true);
    const query = new URLSearchParams(uri.split('?')[1]);
    expect(query.get('secret')).toBe('ABCDEF');
    expect(query.get('issuer')).toBe('FlyTrace');
    expect(query.get('algorithm')).toBe('SHA1');
    expect(query.get('digits')).toBe('6');
    expect(query.get('period')).toBe('30');
  });
});
