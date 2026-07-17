import type { Position } from '../domain/position.ts';

/**
 * A source of live position samples. The engine is source-agnostic: it polls,
 * normalizes-in (already normalized by the source), and diffs. Adapters:
 * {@link FixturePositionSource} (offline/tests) and the live OpenSky client.
 */
export interface PositionSource {
  readonly name: string;
  /** Fetch the current batch of placed positions. May return `[]`. */
  poll(): Promise<Position[]>;
  /** Optional: sources that replay a finite recording report exhaustion. */
  readonly done?: boolean;
}
