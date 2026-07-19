/**
 * Digest preferences (docs/10, docs/17 §17.5). Pure helpers that decide a user's
 * effective digest frequency and whether a digest is due now — no I/O, so they
 * are trivially testable and reusable by the scheduler's `listDueUsers`.
 */

export type DigestFrequency = 'daily' | 'weekly' | 'off';

export interface DigestPreferences {
  /** Explicit user choice; when absent, `enabled` decides the default. */
  frequency?: DigestFrequency;
  /** Master switch; false forces 'off' regardless of `frequency`. */
  enabled?: boolean;
}

/** Default frequency when a user has enabled digests but not picked a cadence. */
export const DEFAULT_FREQUENCY: DigestFrequency = 'weekly';

const FREQUENCIES = new Set<DigestFrequency>(['daily', 'weekly', 'off']);

/** Milliseconds between sends for each cadence (off = never). */
const INTERVAL_MS: Record<DigestFrequency, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  off: Number.POSITIVE_INFINITY,
};

/**
 * Resolve the effective frequency from possibly-partial preferences.
 * - `enabled === false` → 'off'
 * - a valid explicit `frequency` wins
 * - otherwise the default cadence (when enabled) or 'off'
 */
export function resolveDigestFrequency(
  prefs: DigestPreferences | null | undefined,
): DigestFrequency {
  if (!prefs) return 'off';
  if (prefs.enabled === false) return 'off';
  if (prefs.frequency && FREQUENCIES.has(prefs.frequency)) return prefs.frequency;
  return prefs.enabled ? DEFAULT_FREQUENCY : 'off';
}

function toMs(t: Date | number): number {
  return t instanceof Date ? t.getTime() : t;
}

/**
 * Whether a digest should be sent at `now` given the last send time and cadence.
 * - 'off' → never
 * - never sent before → due immediately (for daily/weekly)
 * - otherwise due once the cadence interval has elapsed
 */
export function shouldSend(
  now: Date | number,
  lastSentAt: Date | number | null | undefined,
  freq: DigestFrequency,
): boolean {
  if (freq === 'off') return false;
  if (lastSentAt === null || lastSentAt === undefined) return true;
  return toMs(now) - toMs(lastSentAt) >= INTERVAL_MS[freq];
}
