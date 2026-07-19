/**
 * Digest unsubscribe tokens (docs/10, docs/17 §17.5). A token is an HMAC over
 * the userId with an injected secret, so it is stateless (no DB lookup), tamper-
 * evident, and pure/deterministic — the sign function is injectable and defaults
 * to HMAC-SHA256 from node:crypto (no network, no external service).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Sign a message into a hex/base64 digest. Injectable for tests. */
export type HmacSigner = (message: string, secret: string) => string;

const defaultSigner: HmacSigner = (message, secret) =>
  createHmac('sha256', secret).update(message).digest('base64url');

export type UnsubscribeResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'malformed' | 'invalid-signature' };

export interface UnsubscribeTokens {
  /** Produce an opaque token for a user. */
  generate(userId: string): string;
  /** Validate a token, returning the userId when the signature matches. */
  validate(token: string): UnsubscribeResult;
}

export interface CreateUnsubscribeTokensOpts {
  secret: string;
  signer?: HmacSigner;
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function b64urlDecode(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

/** Constant-time string compare that tolerates unequal lengths. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Build an {@link UnsubscribeTokens} pair. Token format is
 * `base64url(userId).signature`, keeping the userId recoverable for logging
 * while the signature makes forgery infeasible without the secret.
 */
export function createUnsubscribeTokens(opts: CreateUnsubscribeTokensOpts): UnsubscribeTokens {
  const signer = opts.signer ?? defaultSigner;
  if (!opts.secret) throw new Error('unsubscribe: secret is required');

  const sign = (userId: string): string => signer(userId, opts.secret);

  return {
    generate(userId: string): string {
      return `${b64urlEncode(userId)}.${sign(userId)}`;
    },
    validate(token: string): UnsubscribeResult {
      const dot = token.lastIndexOf('.');
      if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };
      const encoded = token.slice(0, dot);
      const sig = token.slice(dot + 1);
      let userId: string;
      try {
        userId = b64urlDecode(encoded);
      } catch {
        return { ok: false, reason: 'malformed' };
      }
      if (!userId) return { ok: false, reason: 'malformed' };
      if (!safeEqual(sig, sign(userId))) return { ok: false, reason: 'invalid-signature' };
      return { ok: true, userId };
    },
  };
}
