import { describe, expect, test } from 'bun:test';
import { bunHasher, randomToken } from './service.ts';

describe('bunHasher (argon2id)', () => {
  test('verifies the correct password and rejects a wrong one', async () => {
    const hash = await bunHasher.hash('correct horse battery');
    expect(hash).not.toContain('correct horse'); // not stored in plaintext
    expect(await bunHasher.verify('correct horse battery', hash)).toBe(true);
    expect(await bunHasher.verify('wrong password', hash)).toBe(false);
  });
});

describe('randomToken', () => {
  test('produces distinct 64-hex-char tokens', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
