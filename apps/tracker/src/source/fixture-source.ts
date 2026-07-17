import { normalizeStatesResponse } from '../domain/position.ts';
import type { Position } from '../domain/position.ts';
import type { PositionSource } from './port.ts';

/**
 * Replays a recorded sequence of OpenSky `/states/all` responses, one per
 * `poll()`. Deterministic and network-free — the substrate for golden-file and
 * end-to-end tracker tests (docs/07 §7.9). Each frame is a raw response object
 * so the real normalization path is exercised.
 */
export class FixturePositionSource implements PositionSource {
  readonly name = 'fixture';
  private index = 0;

  constructor(private readonly frames: unknown[]) {}

  get done(): boolean {
    return this.index >= this.frames.length;
  }

  async poll(): Promise<Position[]> {
    if (this.done) return [];
    const frame = this.frames[this.index];
    this.index += 1;
    return normalizeStatesResponse(frame);
  }
}
