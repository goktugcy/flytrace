/**
 * UUID v7 generator (time-ordered, index-friendly).
 * No external deps — builds the layout per RFC 9562 §5.7 using crypto random.
 */

export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // 48-bit big-endian Unix timestamp (ms)
  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  // version 7 in the high nibble of byte 6
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  // variant (10xx) in the high bits of byte 8
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const s = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Short opaque id for correlation/tracing (not a UUID). */
export function correlationId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
