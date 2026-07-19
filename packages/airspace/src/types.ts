/**
 * Airspace domain model for the EnteredAirspace feature (docs/07 §7 — event
 * `entered_airspace`). An airspace is a named 3-D volume: a horizontal polygon
 * (GeoJSON, [lon, lat] order — RFC 7946) bounded vertically by a lower/upper
 * altitude band in feet. Providers (openAIP / open-flightmaps / AIXM / mock)
 * all normalize their native formats into this shape so the rest of the tracker
 * is provider-agnostic.
 */

/** Controlled/special-use airspace kinds normalized across providers. */
export type AirspaceType = 'FIR' | 'TMA' | 'CTA' | 'CTR' | 'RESTRICTED' | 'DANGER' | 'PROHIBITED';

/** GeoJSON position — [longitude, latitude] (RFC 7946 §3.1.1). Altitude ignored. */
export type Position2D = [number, number];

/** A linear ring: first and last position SHOULD coincide (RFC 7946 §3.1.6). */
export type LinearRing = Position2D[];

/** GeoJSON Polygon: an outer ring followed by zero or more hole rings. */
export interface GeoJsonPolygon {
  type: 'Polygon';
  coordinates: LinearRing[];
}

/** GeoJSON MultiPolygon: an array of Polygon coordinate arrays. */
export interface GeoJsonMultiPolygon {
  type: 'MultiPolygon';
  coordinates: LinearRing[][];
}

export type AirspaceGeometry = GeoJsonPolygon | GeoJsonMultiPolygon;

/**
 * A normalized airspace volume. `lowerFt`/`upperFt` describe the vertical band;
 * `null` means unbounded (ground / unlimited). Altitude filtering is optional at
 * the service layer — horizontal containment alone is enough to raise an entry
 * event when altitude is unknown.
 */
export interface Airspace {
  id: string;
  name: string;
  type: AirspaceType;
  /** ICAO airspace class (A–G) when known. */
  icaoClass: string | null;
  /** Lower vertical bound in feet (null = ground / unbounded below). */
  lowerFt: number | null;
  /** Upper vertical bound in feet (null = unlimited above). */
  upperFt: number | null;
  /** Primary radio frequency (MHz as string, e.g. "121.300") when published. */
  frequency?: string | null;
  polygon: AirspaceGeometry;
  /** Provenance: which provider/dataset the record came from. */
  source?: string;
  provider?: string;
  sourceId?: string;
  datasetVersion?: string;
  importedAt?: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

/** Axis-aligned bounding box in [minLon, minLat, maxLon, maxLat] order. */
export type Bbox2D = [number, number, number, number];

/** The shape a spatial index / cache stores: an airspace plus its cached bbox. */
export interface IndexedAirspace {
  airspace: Airspace;
  bbox: Bbox2D;
}
