import { z } from 'zod';

/**
 * Short-lived, signed WebSocket ticket (docs/12 §12.7). Cookies can't be relied
 * on cross-origin for WS, so the client fetches a ticket over authenticated
 * HTTP and presents it on the handshake as `?token=`. HMAC-SHA256 over a compact
 * `base64url(payload).base64url(sig)` token — no external JWT dependency.
 *
 * Single-use (jti) enforcement is stateful and lives in the gateway (a Redis
 * SET NX on the jti); this module is pure sign/verify.
 */
export const ticketRoleSchema = z.enum(['guest', 'user', 'admin']);
export type TicketRole = z.infer<typeof ticketRoleSchema>;

export const ticketPayloadSchema = z.object({
  uid: z.string().nullable(), // null for guests
  role: ticketRoleSchema,
  iat: z.number().int(), // issued-at (epoch ms)
  exp: z.number().int(), // expiry (epoch ms)
  jti: z.string(), // unique id (single-use)
  bind: z.string(), // hash binding (ip+ua), '' if unbound
});
export type TicketPayload = z.infer<typeof ticketPayloadSchema>;

const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(s, 'base64url');
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signTicket(payload: TicketPayload, secret: string): Promise<string> {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** Verify signature + expiry. Returns the payload, or null if invalid/expired. */
export async function verifyTicket(
  token: string,
  secret: string,
  nowMs: number,
): Promise<TicketPayload | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const key = await hmacKey(secret);
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(sig), enc.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(b64urlDecode(body)).toString('utf8'));
  } catch {
    return null;
  }
  const parsed = ticketPayloadSchema.safeParse(json);
  if (!parsed.success) return null;
  if (parsed.data.exp <= nowMs) return null;
  return parsed.data;
}
