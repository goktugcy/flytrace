/**
 * Pure IP helpers for session-security (docs §7b). No I/O, no globals — every
 * function is deterministic given its inputs so detectors stay unit-testable.
 */

/** A minimal read view over incoming request headers (Headers or a plain map). */
export type HeaderSource =
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>;

function headerValue(headers: HeaderSource, name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(n: string): string | null }).get(name);
  }
  const rec = headers as Record<string, string | string[] | undefined>;
  const v = rec[name] ?? rec[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/**
 * Canonicalize an IP: trim, lowercase, strip brackets/zone-id, and unwrap
 * IPv4-mapped IPv6 (`::ffff:1.2.3.4` → `1.2.3.4`). Best-effort — unknown shapes
 * are returned trimmed/lowercased so callers still get a stable string.
 */
export function normalizeIp(ip: string): string {
  let s = ip.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  // Drop a scope/zone id (fe80::1%eth0) and any :port only when unambiguous.
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  const mapped = s.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped?.[1]) return mapped[1];
  return s;
}

function v4Prefix(ip: string, bits: number): string {
  const octets = ip.split('.').map((x) => Number.parseInt(x, 10));
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
    return `${ip}/${bits}`; // fallback: not a parseable v4
  }
  const b = Math.max(0, Math.min(32, bits));
  const int = octets.reduce((acc, o) => (acc * 256 + o) >>> 0, 0);
  const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
  const masked = (int & mask) >>> 0;
  const out = [(masked >>> 24) & 255, (masked >>> 16) & 255, (masked >>> 8) & 255, masked & 255];
  return `${out.join('.')}/${b}`;
}

function expandV6(ip: string): number[] | null {
  const dbl = ip.indexOf('::');
  let groups: string[];
  if (dbl >= 0) {
    const head = ip.slice(0, dbl).split(':').filter(Boolean);
    const tail = ip
      .slice(dbl + 2)
      .split(':')
      .filter(Boolean);
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...new Array<string>(missing).fill('0'), ...tail];
  } else {
    groups = ip.split(':');
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => Number.parseInt(g || '0', 16));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

function v6Prefix(ip: string, bits: number): string {
  const nums = expandV6(ip);
  if (!nums) return `${ip}/${bits}`;
  const b = Math.max(0, Math.min(128, bits));
  const out = nums.map((g, i) => {
    const keep = Math.min(16, Math.max(0, b - i * 16));
    const mask = keep === 0 ? 0 : keep >= 16 ? 0xffff : (0xffff << (16 - keep)) & 0xffff;
    return (g & mask).toString(16);
  });
  return `${out.join(':')}/${b}`;
}

/**
 * Network prefix of an IP: `/24` for IPv4, `/48` for IPv6 by default. Used to
 * group logins by rough network origin (a stable-per-ISP signal) rather than by
 * exact address, which churns constantly (CGNAT / mobile).
 */
export function ipPrefix(ip: string, v4bits = 24, v6bits = 48): string {
  const n = normalizeIp(ip);
  return n.includes(':') ? v6Prefix(n, v6bits) : v4Prefix(n, v4bits);
}

/**
 * How much of a client address is allowed to be persisted.
 *
 * `prefix` (the default) is the project's data-minimisation position: an exact
 * IP is personal data with a real retention cost, while the /24 (v4) or /48
 * (v6) network keeps every signal session-security actually needs — "is this a
 * network we have seen this user on?" — and survives the CGNAT/mobile address
 * churn that makes exact addresses noisy anyway.
 *
 * `full` is available for deployments with a regulatory reason to keep exact
 * addresses (fraud investigation, incident forensics). `none` drops the value
 * entirely for the strictest environments; new-device detection still works
 * because it also keys on the user-agent fingerprint.
 */
export type IpStoragePolicy = 'prefix' | 'full' | 'none';

/**
 * Apply the configured storage policy to an address before it is written to the
 * database. Returns null when there is nothing safe (or nothing at all) to store.
 */
export function applyIpPolicy(
  ip: string | null | undefined,
  policy: IpStoragePolicy,
  v4bits = 24,
  v6bits = 48,
): string | null {
  if (!ip) return null;
  if (policy === 'none') return null;
  const normalized = normalizeIp(ip);
  if (!normalized) return null;
  return policy === 'full' ? normalized : ipPrefix(normalized, v4bits, v6bits);
}

/**
 * Extract the client IP from request headers, honoring `x-forwarded-for` (the
 * left-most entry is the original client) then `x-real-ip`. Returns a normalized
 * IP or null when none is present.
 */
export function extractClientIp(headers: HeaderSource): string | null {
  const xff = headerValue(headers, 'x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return normalizeIp(first);
  }
  const real = headerValue(headers, 'x-real-ip');
  if (real?.trim()) return normalizeIp(real.trim());
  return null;
}
