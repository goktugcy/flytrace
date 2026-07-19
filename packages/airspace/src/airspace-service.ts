import { TtlCache } from './cache.ts';
/**
 * AirspaceService — the tracker-facing facade over an {@link AirspaceProvider}.
 * It loads the dataset once at start (memoized behind a TTL cache so a periodic
 * refresh is cheap), answers "what airspace is this point in?" for the API, and
 * computes airspace-entry transitions that the tracker turns into
 * `entered_airspace` domain events (docs/07).
 *
 * Entry detection is a pure set-difference: given the set of airspace ids the
 * flight was already inside and its new position, it returns the ids it has
 * *newly* entered (and, symmetrically, the ones it exited) so the caller emits
 * one event per boundary crossing rather than one per position sample.
 */
import type { AirspaceProvider } from './providers/index.ts';
import type { Airspace, AirspaceType } from './types.ts';

/** Default provider-load TTL (10 min): airspace datasets change slowly. */
const DEFAULT_LOAD_TTL_MS = 10 * 60 * 1000;

export interface AirspaceServiceOptions {
  /** Provider-load memoization TTL in ms. Default 10 min; 0 disables. */
  loadTtlMs?: number;
  /** Clock for the TTL cache (tests inject a fake). */
  now?: () => number;
  /**
   * When a position's altitude is known, only count an airspace as "entered"
   * if the altitude falls within its [lowerFt, upperFt] band. Defaults to true;
   * unknown altitude always matches (horizontal containment alone).
   */
  altitudeFilter?: boolean;
}

/** The newly-entered / newly-exited airspaces for one position step. */
export interface EntryDelta {
  /** Airspaces the flight has just entered (not in `prevInsideIds`). */
  entered: Airspace[];
  /** Ids the flight has just left (in `prevInsideIds`, no longer inside). */
  exitedIds: string[];
  /** The full set of ids the flight is inside after this step. */
  insideIds: Set<string>;
  /** The full list of matches (superset of `entered`) for this position. */
  current: Airspace[];
}

export class AirspaceService {
  private readonly cache: TtlCache<string, true>;
  private readonly altitudeFilter: boolean;
  private loaded = false;

  constructor(
    private readonly provider: AirspaceProvider,
    opts: AirspaceServiceOptions = {},
  ) {
    this.cache = new TtlCache<string, true>({
      ttlMs: opts.loadTtlMs ?? DEFAULT_LOAD_TTL_MS,
      ...(opts.now ? { now: opts.now } : {}),
    });
    this.altitudeFilter = opts.altitudeFilter ?? true;
  }

  /**
   * Ensure the provider's dataset is loaded. Memoized behind the TTL cache:
   * within the TTL this is a no-op; after expiry the next call refreshes. Safe
   * to call on every tick.
   */
  async load(): Promise<void> {
    await this.cache.getOrLoad('dataset', async () => {
      await this.provider.load();
      this.loaded = true;
      return true;
    });
  }

  /** Whether an initial load has completed at least once. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * All airspaces containing (lat, lon). When `altFt` is provided and the
   * altitude filter is on, matches are further constrained to their vertical
   * band. Larger volumes (FIR) and smaller (CTR) can all match at once.
   */
  currentAirspace(lat: number, lon: number, altFt?: number | null): Airspace[] {
    const matches = this.provider.findContainingAirspace(lat, lon);
    if (!this.altitudeFilter || altFt === undefined || altFt === null) return matches;
    return matches.filter((a) => withinBand(altFt, a.lowerFt, a.upperFt));
  }

  /**
   * Compute the airspace-entry transition for a position given the set of ids
   * the flight was already inside. Pure w.r.t. the loaded dataset.
   */
  detectEntry(
    prevInsideIds: ReadonlySet<string>,
    lat: number,
    lon: number,
    altFt?: number | null,
  ): EntryDelta {
    const current = this.currentAirspace(lat, lon, altFt);
    const insideIds = new Set<string>(current.map((a) => a.id));
    const entered = current.filter((a) => !prevInsideIds.has(a.id));
    const exitedIds: string[] = [];
    for (const id of prevInsideIds) {
      if (!insideIds.has(id)) exitedIds.push(id);
    }
    return { entered, exitedIds, insideIds, current };
  }
}

/** Inclusive vertical-band test; null bounds are open (ground / unlimited). */
export function withinBand(altFt: number, lowerFt: number | null, upperFt: number | null): boolean {
  if (lowerFt !== null && altFt < lowerFt) return false;
  if (upperFt !== null && altFt > upperFt) return false;
  return true;
}

/** Group matches into the `{ fir, tma, cta, ctr }` buckets the API returns. */
export function groupByType(matches: Airspace[]): Record<Lowercase<AirspaceType>, Airspace[]> {
  const out = {
    fir: [] as Airspace[],
    tma: [] as Airspace[],
    cta: [] as Airspace[],
    ctr: [] as Airspace[],
  };
  for (const a of matches) {
    out[a.type.toLowerCase() as Lowercase<AirspaceType>].push(a);
  }
  return out;
}
