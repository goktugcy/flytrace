/**
 * openAIP airspace provider (https://www.openaip.net). Parses openAIP's airspace
 * export — either their native JSON records or a GeoJSON FeatureCollection
 * derived from them — when `OPENAIP_DATASET_PATH` points at a file or URL.
 * Un-configured ⇒ no-op (empty dataset).
 *
 * The parser is deliberately tolerant: openAIP has revised its type/class enums
 * over time, so we normalize from numeric codes AND string labels AND fall back
 * to a name-based heuristic. Records we can't place (no polygon) are skipped,
 * never fabricated.
 */
import type { Logger } from '@flytrace/shared';
import { z } from 'zod';
import type { Airspace, AirspaceGeometry, AirspaceType } from '../types.ts';
import { parseJson, readDatasetText } from './_source.ts';
import { BaseAirspaceProvider } from './index.ts';

/** openAIP vertical limit: value + unit (1=ft, 6=FL) + reference datum. */
const limitSchema = z
  .object({
    value: z.number().nullish(),
    unit: z.union([z.number(), z.string()]).nullish(),
  })
  .nullish();

const geometrySchema = z.object({
  type: z.enum(['Polygon', 'MultiPolygon']),
  coordinates: z.array(z.unknown()),
});

/** A native openAIP airspace record (also matches GeoJSON Feature.properties). */
const airspaceRecordSchema = z
  .object({
    _id: z.string().nullish(),
    id: z.string().nullish(),
    name: z.string().nullish(),
    type: z.union([z.number(), z.string()]).nullish(),
    icaoClass: z.union([z.number(), z.string()]).nullish(),
    upperLimit: limitSchema,
    lowerLimit: limitSchema,
    frequency: z
      .union([z.string(), z.object({ value: z.string().nullish() }).passthrough()])
      .nullish(),
    geometry: geometrySchema.nullish(),
  })
  .passthrough();

/** openAIP numeric type code → our coarse type. Covers the codes we model. */
const NUMERIC_TYPE: Record<number, AirspaceType> = {
  4: 'CTR',
  1: 'TMA', // TMA in newer schema
  10: 'FIR',
  13: 'CTA',
  2: 'RESTRICTED',
  3: 'DANGER',
  6: 'PROHIBITED',
};

/** openAIP numeric ICAO class code (0=A … 6=G). */
const NUMERIC_CLASS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

function normalizeType(raw: unknown, name: string): AirspaceType {
  if (typeof raw === 'number' && NUMERIC_TYPE[raw]) return NUMERIC_TYPE[raw] as AirspaceType;
  const s = String(raw ?? '').toUpperCase();
  if (s.includes('PROHIBITED')) return 'PROHIBITED';
  if (s.includes('DANGER')) return 'DANGER';
  if (s.includes('RESTRICTED')) return 'RESTRICTED';
  if (s.includes('CTR')) return 'CTR';
  if (s.includes('TMA')) return 'TMA';
  if (s.includes('FIR')) return 'FIR';
  if (s.includes('CTA')) return 'CTA';
  // Heuristic from the airspace name.
  const n = name.toUpperCase();
  if (n.includes('PROHIBITED')) return 'PROHIBITED';
  if (n.includes('DANGER')) return 'DANGER';
  if (n.includes('RESTRICTED')) return 'RESTRICTED';
  if (n.includes('CTR')) return 'CTR';
  if (n.includes('FIR')) return 'FIR';
  if (n.includes('CTA')) return 'CTA';
  return 'TMA';
}

function normalizeClass(raw: unknown): string | null {
  if (typeof raw === 'number') return NUMERIC_CLASS[raw] ?? null;
  const s = String(raw ?? '')
    .trim()
    .toUpperCase();
  return /^[A-G]$/.test(s) ? s : null;
}

/** Convert an openAIP vertical limit to feet. FL (unit 6/"FL") → ×100. */
function limitToFt(
  limit:
    | { value?: number | null | undefined; unit?: number | string | null | undefined }
    | null
    | undefined,
): number | null {
  if (!limit || limit.value === null || limit.value === undefined) return null;
  const unit = limit.unit;
  const isFl = unit === 6 || String(unit).toUpperCase() === 'FL';
  return isFl ? limit.value * 100 : limit.value;
}

function normalizeFrequency(raw: unknown): string | null {
  if (typeof raw === 'string') return raw || null;
  if (raw && typeof raw === 'object' && 'value' in raw) {
    const v = (raw as { value?: string | null }).value;
    return v || null;
  }
  return null;
}

/**
 * Normalize an openAIP-style record (or GeoJSON feature) into an {@link Airspace}.
 * Returns `null` when there is no usable polygon geometry.
 */
export function normalizeOpenAipRecord(raw: unknown): Airspace | null {
  // Accept a GeoJSON Feature by flattening {properties, geometry}.
  const record =
    raw && typeof raw === 'object' && 'properties' in raw
      ? {
          ...(raw as { properties: object }).properties,
          geometry: (raw as { geometry?: unknown }).geometry,
        }
      : raw;
  const parsed = airspaceRecordSchema.safeParse(record);
  if (!parsed.success || !parsed.data.geometry) return null;
  const d = parsed.data;
  const name = d.name ?? 'UNKNOWN';
  return {
    id: d._id ?? d.id ?? `openaip:${name}`,
    name,
    type: normalizeType(d.type, name),
    icaoClass: normalizeClass(d.icaoClass),
    lowerFt: limitToFt(d.lowerLimit),
    upperFt: limitToFt(d.upperLimit),
    frequency: normalizeFrequency(d.frequency),
    source: 'openaip',
    provider: 'openaip',
    sourceId: d._id ?? d.id ?? `openaip:${name}`,
    polygon: d.geometry as AirspaceGeometry,
  };
}

/** Extract the record array from the various shapes an export can take. */
function extractRecords(root: unknown): unknown[] {
  if (Array.isArray(root)) return root;
  if (root && typeof root === 'object') {
    const o = root as Record<string, unknown>;
    if (Array.isArray(o.features)) return o.features; // GeoJSON FeatureCollection
    if (Array.isArray(o.items)) return o.items; // openAIP API paged response
    if (Array.isArray(o.airspaces)) return o.airspaces;
  }
  return [];
}

/** Parse a raw openAIP dataset text into normalized airspaces. */
export function parseOpenAipDataset(text: string | null, logger?: Logger): Airspace[] {
  const root = parseJson(text, 'openaip', logger);
  if (root === null) return [];
  const out: Airspace[] = [];
  for (const rec of extractRecords(root)) {
    const a = normalizeOpenAipRecord(rec);
    if (a) out.push(a);
  }
  return out;
}

export class OpenAipAirspaceProvider extends BaseAirspaceProvider {
  constructor(
    private readonly datasetPath: string | undefined,
    cellDeg?: number,
    private readonly logger?: Logger,
  ) {
    super(cellDeg);
  }

  protected async fetch(): Promise<Airspace[]> {
    const text = await readDatasetText(this.datasetPath, 'openaip', this.logger);
    return parseOpenAipDataset(text, this.logger);
  }
}
