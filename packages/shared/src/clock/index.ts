/**
 * Injectable time source. Business logic depends on a Clock, never Date.now()
 * directly — enabling deterministic tests (fixed/advanceable clocks).
 */

export interface Clock {
  now(): number; // epoch ms
  nowIso(): string; // ISO-8601 UTC
}

export const systemClock: Clock = {
  now: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

/** A controllable clock for tests. */
export function fixedClock(
  startMs = 0,
): Clock & { advance(ms: number): void; set(ms: number): void } {
  let current = startMs;
  return {
    now: () => current,
    nowIso: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
}
