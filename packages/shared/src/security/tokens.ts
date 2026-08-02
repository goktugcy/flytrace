/**
 * Shared security-token primitives (docs/15 §15.1, §7b).
 *
 * ONE hashing convention for every bearer-style secret in the platform — session
 * cookies, refresh tokens, email-verification links, Telegram deep links, MFA
 * challenges. Modules must import from here instead of reaching for
 * `node:crypto` themselves so that "what is stored at rest" is a single,
 * auditable decision.
 *
 * Design notes
 * ------------
 * - Tokens are minted from a CSPRNG with ≥ 256 bits of entropy, so a *fast*
 *   digest (SHA-256) is the correct primitive: there is nothing to brute-force.
 *   A password KDF (argon2/scrypt) would be actively wrong here — lookups are
 *   by hash, which a salted KDF cannot do. Password hashing stays in
 *   `apps/api/src/auth/service.ts` and must never be conflated with this.
 * - Low-entropy secrets (MFA backup codes, which are human-typable) keep their
 *   scrypt KDF in `security/mfa/backup-codes.ts` — that is the deliberate
 *   exception, not an inconsistency.
 * - Every token this module hashes carries full entropy, so a plain digest is
 *   sufficient. If a *low*-entropy value ever needs constant-cost lookup, add a
 *   peppered HMAC variant here rather than in the calling module — do not reach
 *   for `createHmac` at the call site.
 * - Comparisons go through {@link timingSafeEqualHex}. Equality on a hash is
 *   already hard to exploit, but the constant-time path costs nothing.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** Default entropy for a minted token: 32 bytes = 256 bits. */
export const TOKEN_BYTES = 32;

/** Hex length of a SHA-256 digest — the width every `*_token_hash` column uses. */
export const TOKEN_HASH_HEX_LENGTH = 64;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Mint an opaque bearer token: `bytes` of CSPRNG output, hex-encoded. The raw
 * value is returned to the caller exactly once and must never be persisted or
 * logged — persist {@link hashToken} of it instead.
 */
export function randomToken(bytes: number = TOKEN_BYTES): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

/** Deterministic at-rest digest of a token. Lowercase hex, 64 chars. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex digests. Returns false (without leaking
 * which) when the inputs differ in length or are not valid hex.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, 'hex');
    bufB = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Constant-time comparison of two arbitrary UTF-8 strings (e.g. an internal
 * bearer token from a header against the configured value). Both sides are
 * digested first so differing *lengths* do not short-circuit and leak.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

/**
 * Derive a stable, non-reversible cache/rate-limit key component from a
 * user-controlled value (IP, email, user id). Callers MUST route every
 * untrusted value through this before it becomes part of a Redis key, so that
 * neither key-injection (`:` / newline smuggling) nor PII-at-rest is possible.
 *
 * Truncated to 32 hex chars (128 bits) — collision-free in practice for
 * counter keys and keeps Redis memory bounded.
 */
export function hashKeyComponent(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
}

/** Deterministic token hasher port — injectable so tests stay deterministic. */
export interface TokenHasher {
  hash(token: string): string;
}

/** Production hasher: bare SHA-256 (see module notes on why not a KDF). */
export const sha256TokenHasher: TokenHasher = { hash: hashToken };
