/**
 * @flytrace/airport-ops — pure ground-movement domain. Given an aircraft
 * observation + preloaded airport geometry (from OSM), it classifies the
 * ground/flight phase (AT_GATE → PUSHBACK → TAXI_OUT → HOLD_SHORT → LINE_UP →
 * TAKEOFF_ROLL → AIRBORNE, and the arrival mirror). No I/O — the tracker feeds
 * it positions and persists the returned track.
 */
export type GroundState =
  | 'AT_GATE'
  | 'PUSHBACK'
  | 'TAXI_OUT'
  | 'HOLD_SHORT'
  | 'LINE_UP'
  | 'TAKEOFF_ROLL'
  | 'AIRBORNE'
  | 'CLIMB'
  | 'CRUISE'
  | 'DESCENT'
  | 'APPROACH'
  | 'LANDING'
  | 'TAXI_IN'
  | 'ARRIVED_GATE'
  | 'PARKED_REMOTE'
  | 'UNKNOWN';

export type AeroFeatureKind =
  | 'runway'
  | 'taxiway'
  | 'apron'
  | 'terminal'
  | 'gate'
  | 'hangar'
  | 'parking';

export type Lon = number;
export type Lat = number;
export type Position2D = [Lon, Lat];

export interface GeoPoint {
  type: 'Point';
  coordinates: Position2D;
}
export interface GeoLineString {
  type: 'LineString';
  coordinates: Position2D[];
}
export interface GeoPolygon {
  type: 'Polygon';
  coordinates: Position2D[][];
}
export interface GeoMultiPolygon {
  type: 'MultiPolygon';
  coordinates: Position2D[][][];
}
export type GeoGeometry = GeoPoint | GeoLineString | GeoPolygon | GeoMultiPolygon;

/** One airport feature as read from the DB (ST_AsGeoJSON). */
export interface AirportFeature {
  id: string;
  kind: AeroFeatureKind;
  ref: string | null;
  name: string | null;
  geojson: GeoGeometry | null;
}

/** A single aircraft observation the state machine consumes. */
export interface GroundObs {
  lat: number;
  lon: number;
  altFt: number | null;
  gsKt: number | null;
  verticalRateFpm: number | null;
  headingDeg: number | null;
  onGround: boolean;
  tsMs: number;
}

/** Persistent per-aircraft track carried between steps. */
export interface GroundTrack {
  state: GroundState;
  /** When the current state was entered (ms epoch). */
  sinceMs: number;
  /** ts of the observation that produced this track. */
  atMs: number;
  gateRef: string | null;
  runwayRef: string | null;
  lastHeadingDeg: number | null;
  lastGsKt: number | null;
  /** True once this leg has been airborne (distinguishes departure vs arrival). */
  everAirborne: boolean;
  /** When the aircraft first became stationary at a gate (for the dwell rule). */
  gateStationarySinceMs: number | null;
}

export interface GroundConfig {
  gateRadiusM: number;
  gateDwellMs: number;
  parkedSpeedKt: number;
  taxiMinKt: number;
  taxiMaxKt: number;
  pushbackHeadingDeltaDeg: number;
  onFeatureToleranceM: number;
  holdShortRunwayDistM: number;
  lineUpRunwayDistM: number;
  takeoffRollKt: number;
  airborneAltFt: number;
  climbVrateFpm: number;
  descentVrateFpm: number;
  approachAltFt: number;
}

export const DEFAULT_GROUND_CONFIG: GroundConfig = {
  gateRadiusM: 25,
  gateDwellMs: 180_000, // 3 min stationary → arrived/at gate
  parkedSpeedKt: 2,
  taxiMinKt: 3,
  taxiMaxKt: 40,
  pushbackHeadingDeltaDeg: 12,
  onFeatureToleranceM: 30, // within this of a taxiway/runway line = "on" it
  holdShortRunwayDistM: 120,
  lineUpRunwayDistM: 25,
  takeoffRollKt: 55, // accelerating past this on a runway = takeoff roll
  airborneAltFt: 75,
  climbVrateFpm: 400,
  descentVrateFpm: -400,
  approachAltFt: 6_000,
};
