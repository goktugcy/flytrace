import type { Bbox } from '../channels.ts';

/**
 * Region-based sharding for WebSocket position fan-out (docs/12 §12.8).
 *
 * The globe is divided into a deterministic lon/lat grid; each cell maps to a
 * shard id in `[0, shardCount)`. Publishers emit a position to the shard of its
 * point; subscribers (api nodes) subscribe only to the shards their clients'
 * viewports overlap. This keeps per-node bandwidth proportional to the regions
 * actually being watched instead of the global firehose.
 *
 * Pure and deterministic: the same coordinate always maps to the same shard, so
 * publishers and subscribers agree without coordination. Channel keys are built
 * with the environment prefix (`redisKeyPrefix(APP_ENV)`) so every app shares
 * one key-space, mirroring `busChannels`.
 */

/** Channels to (un)subscribe when a connection's viewport changes. */
export interface ChannelDiff {
  subscribe: string[];
  unsubscribe: string[];
}

export interface ShardManagerOptions {
  /** Number of shards (≥1). Config `WS_SHARD_COUNT`. */
  shardCount: number;
  /** Environment key prefix, e.g. `redisKeyPrefix('local')` → `flytrace:local:`. */
  prefix?: string;
}

/** Logical channel stem (env prefix is prepended by {@link ShardManager}). */
const CHANNEL_STEM = 'rt:positions:shard:';

function clampInt(value: number, lo: number, hi: number): number {
  if (Number.isNaN(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

export class ShardManager {
  readonly shardCount: number;
  private readonly prefix: string;
  private readonly cols: number;
  private readonly rows: number;
  /** Per-connection set of currently-subscribed channels (for viewport diffs). */
  private readonly assigned = new Map<string, Set<string>>();

  constructor(opts: ShardManagerOptions) {
    this.shardCount = Math.max(1, Math.floor(opts.shardCount));
    this.prefix = opts.prefix ?? '';
    // A near-square grid whose cell count covers every shard; overflow cells
    // wrap back onto shard ids via modulo so the mapping stays deterministic.
    this.cols = Math.max(1, Math.ceil(Math.sqrt(this.shardCount)));
    this.rows = Math.max(1, Math.ceil(this.shardCount / this.cols));
  }

  /** Column index for a longitude in [-180, 180]. */
  private colOf(lon: number): number {
    const frac = (lon + 180) / 360;
    return clampInt(Math.floor(frac * this.cols), 0, this.cols - 1);
  }

  /** Row index for a latitude in [-90, 90]. */
  private rowOf(lat: number): number {
    const frac = (lat + 90) / 180;
    return clampInt(Math.floor(frac * this.rows), 0, this.rows - 1);
  }

  private shardOfCell(col: number, row: number): number {
    return (row * this.cols + col) % this.shardCount;
  }

  /** Deterministic shard id for a single point. */
  shardForPoint(lat: number, lon: number): number {
    return this.shardOfCell(this.colOf(lon), this.rowOf(lat));
  }

  /** Deterministic shard id for a bbox, keyed on its center point. */
  shardForBbox(bbox: Bbox): number {
    const [w, s, e, n] = bbox;
    const lat = (s + n) / 2;
    // Center longitude, handling the antimeridian wrap (west > east).
    const lon = w <= e ? (w + e) / 2 : normalizeLon((w + e + 360) / 2);
    return this.shardForPoint(lat, lon);
  }

  /** Every shard id whose grid cell overlaps the viewport (sorted, unique). */
  shardsForViewport(bbox: Bbox): number[] {
    const [w, s, e, n] = bbox;
    const rowLo = this.rowOf(Math.min(s, n));
    const rowHi = this.rowOf(Math.max(s, n));
    const shards = new Set<number>();
    for (const col of this.colRange(w, e)) {
      for (let row = rowLo; row <= rowHi; row += 1) {
        shards.add(this.shardOfCell(col, row));
      }
    }
    return [...shards].sort((a, b) => a - b);
  }

  /** Columns covered from west→east longitude, splitting on the antimeridian. */
  private colRange(west: number, east: number): number[] {
    const cols: number[] = [];
    if (west <= east) {
      for (let c = this.colOf(west); c <= this.colOf(east); c += 1) cols.push(c);
    } else {
      for (let c = this.colOf(west); c <= this.cols - 1; c += 1) cols.push(c);
      for (let c = 0; c <= this.colOf(east); c += 1) cols.push(c);
    }
    return cols;
  }

  /** Fully-qualified pub/sub channel key for a shard. */
  channelFor(shardId: number): string {
    return `${this.prefix}${CHANNEL_STEM}${((shardId % this.shardCount) + this.shardCount) % this.shardCount}`;
  }

  /** All channel keys a viewport must be subscribed to. */
  channelsForViewport(bbox: Bbox): string[] {
    return this.shardsForViewport(bbox).map((id) => this.channelFor(id));
  }

  /**
   * Update a connection's viewport and return the channel delta to apply. The
   * manager remembers the connection's current channels so a moving viewport
   * only (un)subscribes the difference.
   */
  assign(connId: string, bbox: Bbox): ChannelDiff {
    const next = new Set(this.channelsForViewport(bbox));
    const prev = this.assigned.get(connId) ?? new Set<string>();
    const subscribe: string[] = [];
    const unsubscribe: string[] = [];
    for (const ch of next) if (!prev.has(ch)) subscribe.push(ch);
    for (const ch of prev) if (!next.has(ch)) unsubscribe.push(ch);
    this.assigned.set(connId, next);
    return { subscribe, unsubscribe };
  }

  /** Drop a connection, returning every channel it was subscribed to. */
  release(connId: string): string[] {
    const prev = this.assigned.get(connId);
    this.assigned.delete(connId);
    return prev ? [...prev] : [];
  }

  /** Channels a connection is currently assigned to (test/introspection). */
  channelsOf(connId: string): string[] {
    const set = this.assigned.get(connId);
    return set ? [...set] : [];
  }
}

/** Wrap a longitude into [-180, 180). */
function normalizeLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}
