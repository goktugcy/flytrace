import type { Position } from '../domain/position.ts';

export type SourceTimeMode = 'wall' | 'event';

/**
 * A source of live position samples. The engine is source-agnostic: it polls,
 * normalizes-in (already normalized by the source), and diffs. Adapters include
 * fixture replay, single live providers, and composite live provider merge.
 */
export interface PositionSource {
  readonly name: string;
  /**
   * `wall` live feeds are aged against processing time; `event` replay feeds are
   * aged against the latest sample timestamp so old fixtures remain deterministic.
   */
  readonly timeMode?: SourceTimeMode;
  /** Fetch the current batch of placed positions. May return `[]`. */
  poll(): Promise<Position[]>;
  /** Optional: sources that replay a finite recording report exhaustion. */
  readonly done?: boolean;
}
