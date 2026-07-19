import { type Clock, systemClock } from '@flytrace/shared';

/**
 * Heartbeat / liveness manager for WebSocket connections (docs/12 §12.8).
 *
 * The hub sends `ping` frames on an interval and marks a connection alive on the
 * client's `pong`. {@link HeartbeatManager.tick} runs on the same interval and
 * evicts any connection that has missed `maxMissed` consecutive pings — the
 * horizontally-scaled backstop for the half-open TCP connections that Bun's idle
 * timeout would otherwise leak node-by-node.
 *
 * Timer and clock are injected so the whole thing is deterministic in tests.
 */

/** Injectable interval source; `set` returns a disposer. */
export interface IntervalTimer {
  set(fn: () => void, ms: number): () => void;
}

/** Real timer backed by the host `setInterval` (unref'd so it never blocks exit). */
export const realIntervalTimer: IntervalTimer = {
  set(fn, ms) {
    const handle = setInterval(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return () => clearInterval(handle);
  },
};

export interface HeartbeatDeps {
  /** Ping interval in ms (config `WS_HEARTBEAT_INTERVAL_MS`). */
  intervalMs: number;
  /** Consecutive missed pings before eviction (default 2). */
  maxMissed?: number;
  /** Called with the connection id when it is evicted as stale. */
  onTimeout: (connId: string) => void;
  clock?: Clock;
  timer?: IntervalTimer;
}

export class HeartbeatManager {
  private readonly intervalMs: number;
  private readonly maxMissed: number;
  private readonly onTimeout: (connId: string) => void;
  private readonly clock: Clock;
  private readonly timer: IntervalTimer;
  private readonly lastSeen = new Map<string, number>();
  private stop: (() => void) | null = null;

  constructor(deps: HeartbeatDeps) {
    this.intervalMs = deps.intervalMs;
    this.maxMissed = Math.max(1, deps.maxMissed ?? 2);
    this.onTimeout = deps.onTimeout;
    this.clock = deps.clock ?? systemClock;
    this.timer = deps.timer ?? realIntervalTimer;
  }

  /** Begin the periodic {@link tick}. Idempotent. */
  start(): void {
    if (this.stop) return;
    this.stop = this.timer.set(() => this.tick(), this.intervalMs);
  }

  /** Stop the periodic tick (does not clear tracked connections). */
  close(): void {
    this.stop?.();
    this.stop = null;
  }

  /** Track a new connection, or refresh liveness on a `pong`. */
  markAlive(connId: string): void {
    this.lastSeen.set(connId, this.clock.now());
  }

  /** Stop tracking a connection (on close). */
  remove(connId: string): void {
    this.lastSeen.delete(connId);
  }

  get size(): number {
    return this.lastSeen.size;
  }

  /**
   * Evict connections silent for longer than `maxMissed` intervals. Returns the
   * evicted ids (also passed to `onTimeout`). Safe to call directly in tests.
   */
  tick(): string[] {
    const now = this.clock.now();
    const deadline = this.maxMissed * this.intervalMs;
    const evicted: string[] = [];
    for (const [connId, seen] of this.lastSeen) {
      if (now - seen > deadline) evicted.push(connId);
    }
    for (const connId of evicted) {
      this.lastSeen.delete(connId);
      this.onTimeout(connId);
    }
    return evicted;
  }
}
