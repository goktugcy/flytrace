import type { DbEventTypeName } from '@flytrace/shared';

/**
 * Delivery rules (docs/10 §10.7): quiet hours + a per-flight frequency cap.
 * Critical, time-sensitive events (delay / gate change / cancelled) always
 * deliver, bypassing both. Pure + clock-injected for deterministic tests.
 */
export const CRITICAL_TYPES: ReadonlySet<DbEventTypeName> = new Set([
  'delay',
  'gate_change',
  'cancelled',
]);

export interface QuietHours {
  tz: string; // IANA tz, e.g. "Europe/Istanbul"
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

export interface RuleInput {
  dbType: DbEventTypeName;
  nowMs: number;
  quietHours: QuietHours | null;
  /** Non-critical notifications already sent for this flight in the window. */
  recentCount: number;
  /** Max non-critical notifications per flight per window. */
  cap: number;
}

export type RuleDecision =
  | { deliver: true }
  | { deliver: false; reason: 'quiet_hours' | 'frequency_cap' };

export function isCritical(dbType: DbEventTypeName): boolean {
  return CRITICAL_TYPES.has(dbType);
}

/** Local "HH:MM" in the given tz for an instant (Intl-based, no deps). */
export function localHhMm(nowMs: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hh === '24' ? '00' : hh}:${mm}`;
}

/** Is `hhmm` within [start, end), handling windows that wrap past midnight? */
export function inQuietHours(nowMs: number, q: QuietHours): boolean {
  const now = localHhMm(nowMs, q.tz);
  if (q.start === q.end) return false;
  return q.start < q.end ? now >= q.start && now < q.end : now >= q.start || now < q.end;
}

export function evaluate(input: RuleInput): RuleDecision {
  if (isCritical(input.dbType)) return { deliver: true }; // always deliver critical
  if (input.quietHours && inQuietHours(input.nowMs, input.quietHours)) {
    return { deliver: false, reason: 'quiet_hours' };
  }
  if (input.recentCount >= input.cap) return { deliver: false, reason: 'frequency_cap' };
  return { deliver: true };
}
