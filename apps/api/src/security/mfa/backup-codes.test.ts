import { describe, expect, test } from 'bun:test';
import {
  type CodeHasher,
  generateBackupCodes,
  hashCode,
  normalizeCode,
  scryptCodeHasher,
  verifyCode,
} from './backup-codes.ts';

describe('generateBackupCodes', () => {
  test('generates the requested count, all unique and formatted', () => {
    const codes = generateBackupCodes(10);
    expect(codes.length).toBe(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    }
  });

  test('excludes ambiguous characters', () => {
    const codes = generateBackupCodes(50).join('');
    expect(codes).not.toMatch(/[01OILU]/);
  });
});

describe('normalizeCode', () => {
  test('strips dashes/spaces and uppercases', () => {
    expect(normalizeCode(' ab2c-de3f ')).toBe('AB2CDE3F');
  });
});

describe('scryptCodeHasher (real KDF)', () => {
  test('hash then verify succeeds and is format-insensitive', async () => {
    const code = 'ABCD-2345';
    const hash = await scryptCodeHasher.hash(code);
    expect(hash.startsWith('scrypt:')).toBe(true);
    expect(await scryptCodeHasher.verify(code, hash)).toBe(true);
    // Same code, different formatting → still verifies.
    expect(await scryptCodeHasher.verify(' abcd2345 ', hash)).toBe(true);
  });

  test('rejects a wrong code and malformed hashes', async () => {
    const hash = await scryptCodeHasher.hash('ABCD-2345');
    expect(await scryptCodeHasher.verify('ZZZZ-9999', hash)).toBe(false);
    expect(await scryptCodeHasher.verify('ABCD-2345', 'garbage')).toBe(false);
  });

  test('salts differ across hashes of the same code', async () => {
    const a = await scryptCodeHasher.hash('ABCD-2345');
    const b = await scryptCodeHasher.hash('ABCD-2345');
    expect(a).not.toBe(b);
  });
});

describe('hashCode / verifyCode with injected hasher', () => {
  // Fast reversible fake — only for tests.
  const fake: CodeHasher = {
    hash: async (c) => `fake:${normalizeCode(c)}`,
    verify: async (c, h) => h === `fake:${normalizeCode(c)}`,
  };

  test('delegates to the injected hasher', async () => {
    const hash = await hashCode('ab2c-de3f', fake);
    expect(hash).toBe('fake:AB2CDE3F');
    expect(await verifyCode('AB2C-DE3F', hash, fake)).toBe(true);
    expect(await verifyCode('xxxx-yyyy', hash, fake)).toBe(false);
  });
});
