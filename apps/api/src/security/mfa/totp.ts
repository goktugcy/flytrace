import { createHmac, randomBytes } from 'node:crypto';

/**
 * RFC 6238 TOTP + RFC 4648 base32, built on node:crypto (HMAC-SHA1) with no npm
 * dependency. Everything here is pure and deterministic: callers inject the
 * time (`t`, epoch seconds) so tests can pin the RFC known-answer vectors.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Encode bytes to an (unpadded) RFC 4648 base32 string. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/** Decode an RFC 4648 base32 string (case-insensitive; padding/spaces ignored). */
export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export interface TotpOptions {
  /** Time-step in seconds (RFC default 30). */
  step?: number;
  /** Number of digits in the code (RFC default 6). */
  digits?: number;
  /** Current time as epoch seconds. Defaults to wall-clock. */
  t?: number;
}

export interface VerifyOptions extends TotpOptions {
  /** Accept codes ±window steps around `t` (RFC default 1). */
  window?: number;
}

export interface OtpauthOptions {
  issuer: string;
  account: string;
  digits?: number;
  step?: number;
}

const DEFAULT_STEP = 30;
const DEFAULT_DIGITS = 6;

/** Generate a fresh base32-encoded secret (default 20 bytes, RFC SHA-1 size). */
export function generateSecret(bytes = 20): string {
  return base32Encode(Uint8Array.from(randomBytes(bytes)));
}

function counterToBuffer(counter: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(counter)));
  return buf;
}

/** Compute the HOTP/TOTP code for a counter derived from `t`/`step`. */
export function totp(secret: string, opts: TotpOptions = {}): string {
  const step = opts.step ?? DEFAULT_STEP;
  const digits = opts.digits ?? DEFAULT_DIGITS;
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  const counter = Math.floor(t / step);

  const key = Buffer.from(base32Decode(secret));
  const hmac = createHmac('sha1', key).update(counterToBuffer(counter)).digest();

  // Dynamic truncation (RFC 4226 §5.3). SHA-1 digest is 20 bytes, so offset
  // (0–15) + 3 is always in range; the ?? 0 only satisfies noUncheckedIndexedAccess.
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const b0 = hmac[offset] ?? 0;
  const b1 = hmac[offset + 1] ?? 0;
  const b2 = hmac[offset + 2] ?? 0;
  const b3 = hmac[offset + 3] ?? 0;
  const binary = ((b0 & 0x7f) << 24) | ((b1 & 0xff) << 16) | ((b2 & 0xff) << 8) | (b3 & 0xff);

  const code = binary % 10 ** digits;
  return code.toString().padStart(digits, '0');
}

/** Constant-time-ish comparison of two equal-length codes. */
function codesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Verify a token, accepting drift of ±`window` steps around `t`. */
export function verifyTotp(secret: string, token: string, opts: VerifyOptions = {}): boolean {
  const window = opts.window ?? 1;
  const step = opts.step ?? DEFAULT_STEP;
  const digits = opts.digits ?? DEFAULT_DIGITS;
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  const candidate = token.replace(/\s+/g, '');
  if (!/^\d+$/.test(candidate)) return false;

  for (let offset = -window; offset <= window; offset++) {
    const expected = totp(secret, { step, digits, t: t + offset * step });
    if (codesEqual(expected, candidate)) return true;
  }
  return false;
}

/** Build an otpauth:// provisioning URI for QR enrolment. */
export function otpauthUri(secret: string, opts: OtpauthOptions): string {
  const digits = opts.digits ?? DEFAULT_DIGITS;
  const step = opts.step ?? DEFAULT_STEP;
  const label = encodeURIComponent(`${opts.issuer}:${opts.account}`);
  const params = new URLSearchParams({
    secret,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: String(digits),
    period: String(step),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
