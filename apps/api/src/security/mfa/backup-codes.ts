import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * One-time MFA recovery codes (docs/15 §7a). Generation is pure-random; hashing
 * goes through an injectable {@link CodeHasher} so tests can swap in a fast fake
 * while production uses a real KDF. The one-time ("consume") semantics live in
 * {@link MfaService} + repo (a `used_at` stamp); these helpers are stateless.
 */

/** Hasher port for backup codes — mirrors the auth module's `Hasher` shape. */
export interface CodeHasher {
  hash(code: string): Promise<string>;
  verify(code: string, hash: string): Promise<boolean>;
}

// Crockford-ish alphabet: no 0/O/1/I/L/U to avoid transcription errors.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const GROUP_LEN = 4;
const GROUPS = 2; // → "XXXX-XXXX"

/** Normalise user input: strip whitespace/dashes, uppercase. */
export function normalizeCode(code: string): string {
  return code.replace(/[\s-]+/g, '').toUpperCase();
}

function randomCode(): string {
  const chars: string[] = [];
  const raw = randomBytes(GROUP_LEN * GROUPS);
  for (let i = 0; i < raw.length; i++) {
    const idx = (raw[i] ?? 0) % CODE_ALPHABET.length;
    chars.push(CODE_ALPHABET[idx] ?? '');
  }
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    groups.push(chars.slice(g * GROUP_LEN, (g + 1) * GROUP_LEN).join(''));
  }
  return groups.join('-');
}

/** Generate `n` fresh, formatted backup codes (plaintext — shown once). */
export function generateBackupCodes(n = 10): string[] {
  const codes = new Set<string>();
  while (codes.size < n) {
    codes.add(randomCode());
  }
  return Array.from(codes);
}

const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT_BYTES = 16;

function scryptAsync(code: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(code, salt, SCRYPT_KEYLEN, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/**
 * Default production hasher: node:crypto scrypt with a per-code random salt.
 * Codes are normalised before hashing so formatting is irrelevant on verify.
 */
export const scryptCodeHasher: CodeHasher = {
  async hash(code) {
    const salt = randomBytes(SCRYPT_SALT_BYTES);
    const derived = await scryptAsync(normalizeCode(code), salt);
    return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
  },
  async verify(code, hash) {
    const parts = hash.split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1] ?? '', 'hex');
    const expected = Buffer.from(parts[2] ?? '', 'hex');
    const derived = await scryptAsync(normalizeCode(code), salt);
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  },
};

/** Hash a single code with the given hasher. */
export function hashCode(code: string, hasher: CodeHasher = scryptCodeHasher): Promise<string> {
  return hasher.hash(code);
}

/** Verify a code against a stored hash with the given hasher. */
export function verifyCode(
  code: string,
  hash: string,
  hasher: CodeHasher = scryptCodeHasher,
): Promise<boolean> {
  return hasher.verify(code, hash);
}
