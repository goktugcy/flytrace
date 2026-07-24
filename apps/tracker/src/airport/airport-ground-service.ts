import {
  type AirportFeature,
  AirportGroundIndex,
  DEFAULT_GROUND_CONFIG,
  type GroundConfig,
  type GroundObs,
  type GroundState,
  type GroundTrack,
  haversineM,
  stepGroundState,
} from '@flytrace/airport-ops';
import type { Logger } from '@flytrace/shared';

export interface AirportRecord {
  airportId: string;
  icao: string;
  lat: number;
  lon: number;
}

interface LoadedAirport extends AirportRecord {
  index: AirportGroundIndex;
}

export interface AirportGroundResult {
  airportId: string;
  airportIcao: string;
  state: GroundState;
  previousState: GroundState;
  gateRef: string | null;
  runwayRef: string | null;
  changed: boolean;
}

export interface AirportGroundServiceDeps {
  /** Airports that have imported geometry (id + icao + centroid). */
  listAirports: () => Promise<AirportRecord[]>;
  /** Load one airport's features (GeoJSON) for its RAM index. */
  loadFeatures: (airportId: string) => Promise<AirportFeature[]>;
  /** Max distance (km) an aircraft can be from an airport centroid to count. */
  maxKm?: number;
  /** Skip aircraft above this altitude (cruising, not ground ops). */
  groundAltFt?: number;
  config?: GroundConfig;
  logger?: Logger;
}

/**
 * Tracker-side airport ground engine: preloads each airport's geometry into a
 * RAM {@link AirportGroundIndex} once, keeps a per-aircraft {@link GroundTrack}
 * in memory, and classifies each low/near-airport observation. Pure geometry +
 * state logic lives in @flytrace/airport-ops; this only owns I/O + caching.
 */
export class AirportGroundService {
  private airports: LoadedAirport[] = [];
  private readonly tracks = new Map<string, GroundTrack>();
  private readonly maxKm: number;
  private readonly groundAltFt: number;
  private readonly config: GroundConfig;

  constructor(private readonly deps: AirportGroundServiceDeps) {
    this.maxKm = deps.maxKm ?? 8;
    this.groundAltFt = deps.groundAltFt ?? 10_000;
    this.config = deps.config ?? DEFAULT_GROUND_CONFIG;
  }

  /** One-time boot preload of all airport geometry indexes. */
  async preload(): Promise<void> {
    const records = await this.deps.listAirports();
    const loaded: LoadedAirport[] = [];
    for (const record of records) {
      const index = new AirportGroundIndex(await this.deps.loadFeatures(record.airportId));
      if (!index.isEmpty) loaded.push({ ...record, index });
    }
    this.airports = loaded;
    this.deps.logger?.info('airport-ground: preloaded geometry', { airports: loaded.length });
  }

  get airportCount(): number {
    return this.airports.length;
  }

  /**
   * Classify one observation. Returns null when the aircraft is cruising or not
   * near any airport with geometry (and forgets its track).
   */
  process(icao24: string, obs: GroundObs): AirportGroundResult | null {
    if (obs.altFt != null && obs.altFt > this.groundAltFt) {
      this.tracks.delete(icao24);
      return null;
    }
    const airport = this.nearest(obs.lat, obs.lon);
    if (!airport) {
      this.tracks.delete(icao24);
      return null;
    }
    const existing = this.tracks.get(icao24) ?? null;
    const { track, changed } = stepGroundState(existing, obs, airport.index, this.config);
    this.tracks.set(icao24, track);
    return {
      airportId: airport.airportId,
      airportIcao: airport.icao,
      state: track.state,
      previousState: existing?.state ?? 'UNKNOWN',
      gateRef: track.gateRef,
      runwayRef: track.runwayRef,
      changed,
    };
  }

  remove(icao24: string): void {
    this.tracks.delete(icao24);
  }

  private nearest(lat: number, lon: number): LoadedAirport | null {
    let best: LoadedAirport | null = null;
    let bestKm = this.maxKm;
    for (const a of this.airports) {
      const km = haversineM(lat, lon, a.lat, a.lon) / 1000;
      if (km <= bestKm) {
        bestKm = km;
        best = a;
      }
    }
    return best;
  }
}

export async function createAirportGroundService(
  deps: AirportGroundServiceDeps,
): Promise<AirportGroundService> {
  const service = new AirportGroundService(deps);
  await service.preload();
  return service;
}
