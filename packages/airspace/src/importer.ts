import { geometryBbox } from './point-in-polygon.ts';
import type { Airspace, AirspaceGeometry, AirspaceType, LinearRing } from './types.ts';

export const AIRSPACE_TYPES: readonly AirspaceType[] = [
  'FIR',
  'TMA',
  'CTA',
  'CTR',
  'RESTRICTED',
  'DANGER',
  'PROHIBITED',
];

export interface AirspaceImportMetadata {
  provider: string;
  datasetVersion: string;
  importedAt?: Date | undefined;
  effectiveFrom?: Date | null | undefined;
  effectiveTo?: Date | null | undefined;
  /** Close rows from older dataset versions for this provider after import. */
  retirePreviousVersions?: boolean | undefined;
  /** Close rows from this dataset version that are missing from the imported file. */
  retireMissing?: boolean | undefined;
  /** Number of valid rows to upsert per repository transaction. Default 500. */
  batchSize?: number | undefined;
}

export interface AirspaceImportRow {
  provider: string;
  sourceId: string;
  datasetVersion: string;
  importedAt: Date;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  name: string;
  type: AirspaceType;
  icaoClass: string | null;
  lowerFt: number | null;
  upperFt: number | null;
  frequency: string | null;
  geojson: AirspaceGeometry;
}

export interface AirspaceImportInvalid {
  sourceId: string;
  name: string;
  reason: string;
}

export interface AirspaceImportResult {
  provider: string;
  datasetVersion: string;
  upserted: number;
  retired: number;
  invalid: AirspaceImportInvalid[];
}

export interface AirspaceImportRepository {
  validateGeometry(geometry: AirspaceGeometry): Promise<{ valid: boolean; reason?: string }>;
  upsertBatch(rows: AirspaceImportRow[]): Promise<number>;
  retirePreviousVersions?(
    provider: string,
    activeDatasetVersion: string,
    retiredAt: Date,
  ): Promise<number>;
  retireMissing?(
    provider: string,
    datasetVersion: string,
    activeSourceIds: string[],
    retiredAt: Date,
  ): Promise<number>;
}

function isClosed(ring: LinearRing): boolean {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return Boolean(first && last && first[0] === last[0] && first[1] === last[1]);
}

function ringReason(ring: LinearRing): string | null {
  if (ring.length < 4) return 'ring must have at least 4 positions';
  if (!isClosed(ring)) return 'ring is not closed';
  for (const [lon, lat] of ring) {
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) return 'longitude out of range';
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return 'latitude out of range';
  }
  return null;
}

export function validateAirspaceGeometryShape(geometry: AirspaceGeometry): string | null {
  if (geometry.type === 'Polygon') {
    if (geometry.coordinates.length === 0) return 'polygon has no rings';
    for (const ring of geometry.coordinates) {
      const reason = ringReason(ring);
      if (reason) return reason;
    }
  } else {
    if (geometry.coordinates.length === 0) return 'multipolygon has no polygons';
    for (const polygon of geometry.coordinates) {
      if (polygon.length === 0) return 'multipolygon polygon has no rings';
      for (const ring of polygon) {
        const reason = ringReason(ring);
        if (reason) return reason;
      }
    }
  }
  const bbox = geometryBbox(geometry);
  if (!bbox.every(Number.isFinite)) return 'geometry bbox is invalid';
  return null;
}

function toRow(airspace: Airspace, meta: AirspaceImportMetadata): AirspaceImportRow {
  return {
    provider: meta.provider,
    sourceId: airspace.sourceId ?? airspace.id,
    datasetVersion: meta.datasetVersion,
    importedAt: meta.importedAt ?? new Date(),
    effectiveFrom: meta.effectiveFrom ?? null,
    effectiveTo: meta.effectiveTo ?? null,
    name: airspace.name,
    type: airspace.type,
    icaoClass: airspace.icaoClass,
    lowerFt: airspace.lowerFt,
    upperFt: airspace.upperFt,
    frequency: airspace.frequency ?? null,
    geojson: airspace.polygon,
  };
}

export async function importAirspaceDataset(
  repo: AirspaceImportRepository,
  airspaces: Airspace[],
  meta: AirspaceImportMetadata,
): Promise<AirspaceImportResult> {
  const batchSize = Math.max(1, meta.batchSize ?? 500);
  const rows: AirspaceImportRow[] = [];
  const invalid: AirspaceImportInvalid[] = [];
  const seen = new Set<string>();

  for (const airspace of airspaces) {
    const sourceId = airspace.sourceId ?? airspace.id;
    if (seen.has(sourceId)) {
      invalid.push({ sourceId, name: airspace.name, reason: 'duplicate source id in dataset' });
      continue;
    }
    seen.add(sourceId);
    if (!AIRSPACE_TYPES.includes(airspace.type)) {
      invalid.push({ sourceId, name: airspace.name, reason: `unsupported type ${airspace.type}` });
      continue;
    }
    const shapeReason = validateAirspaceGeometryShape(airspace.polygon);
    if (shapeReason) {
      invalid.push({ sourceId, name: airspace.name, reason: shapeReason });
      continue;
    }
    const postgis = await repo.validateGeometry(airspace.polygon);
    if (!postgis.valid) {
      invalid.push({
        sourceId,
        name: airspace.name,
        reason: postgis.reason ?? 'PostGIS rejected geometry',
      });
      continue;
    }
    rows.push(toRow(airspace, meta));
  }

  let upserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    upserted += await repo.upsertBatch(rows.slice(i, i + batchSize));
  }

  const retiredAt = meta.effectiveTo ?? meta.importedAt ?? new Date();
  let retired = 0;
  if (meta.retirePreviousVersions && repo.retirePreviousVersions) {
    retired += await repo.retirePreviousVersions(meta.provider, meta.datasetVersion, retiredAt);
  }
  if (meta.retireMissing && repo.retireMissing) {
    retired += await repo.retireMissing(meta.provider, meta.datasetVersion, [...seen], retiredAt);
  }

  return {
    provider: meta.provider,
    datasetVersion: meta.datasetVersion,
    upserted,
    retired,
    invalid,
  };
}
