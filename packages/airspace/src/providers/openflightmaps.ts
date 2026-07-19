/**
 * open-flightmaps airspace provider (https://www.openflightmaps.org). Parses an
 * open-flightmaps GeoJSON airspace export when `OPENFLIGHTMAPS_DATASET_PATH`
 * points at a file or URL. Un-configured ⇒ no-op (empty dataset).
 *
 * open-flightmaps encodes vertical limits as human strings ("FL245", "GND",
 * "1000 FT MSL", "2500 FT AGL"), so this provider carries a small altitude
 * string parser. Records without polygon geometry are skipped.
 */
import type { Logger } from '@flytrace/shared';
import { z } from 'zod';
import type { Airspace, AirspaceGeometry, AirspaceType } from '../types.ts';
import { parseJson, readDatasetText } from './_source.ts';
import { BaseAirspaceProvider } from './index.ts';

const featureSchema = z
  .object({
    type: z.literal('Feature').optional(),
    id: z.union([z.string(), z.number()]).nullish(),
    properties: z
      .object({
        name: z.string().nullish(),
        type: z.string().nullish(),
        class: z.string().nullish(),
        icaoClass: z.string().nullish(),
        upper: z.union([z.string(), z.number()]).nullish(),
        lower: z.union([z.string(), z.number()]).nullish(),
        frequency: z.union([z.string(), z.number()]).nullish(),
      })
      .passthrough()
      .nullish(),
    geometry: z
      .object({
        type: z.enum(['Polygon', 'MultiPolygon']),
        coordinates: z.array(z.unknown()),
      })
      .nullish(),
  })
  .passthrough();

/**
 * Parse an open-flightmaps altitude string into feet.
 * - "GND" / "SFC" / "0" → 0
 * - "UNL" / "UNLTD" → null (unlimited)
 * - "FL245" → 24500
 * - "2500 FT AGL" / "1000FT MSL" → 2500 / 1000 (datum ignored — planar model)
 */
export function parseOfmAltitude(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toUpperCase();
  if (s === '') return null;
  if (s === 'GND' || s === 'SFC' || s === 'GROUND') return 0;
  if (s === 'UNL' || s === 'UNLTD' || s === 'UNLIMITED') return null;
  const fl = s.match(/^FL\s*(\d+)/);
  if (fl) return Number(fl[1]) * 100;
  const ft = s.match(/(-?\d+(?:\.\d+)?)/);
  if (ft) return Math.round(Number(ft[1]));
  return null;
}

function normalizeType(typeStr: string | null | undefined, name: string): AirspaceType {
  const s = (typeStr ?? '').toUpperCase();
  if (s.includes('PROHIBITED')) return 'PROHIBITED';
  if (s.includes('DANGER')) return 'DANGER';
  if (s.includes('RESTRICTED')) return 'RESTRICTED';
  if (s.includes('CTR')) return 'CTR';
  if (s.includes('TMA')) return 'TMA';
  if (s.includes('FIR')) return 'FIR';
  if (s.includes('CTA')) return 'CTA';
  const n = name.toUpperCase();
  if (n.includes('PROHIBITED')) return 'PROHIBITED';
  if (n.includes('DANGER')) return 'DANGER';
  if (n.includes('RESTRICTED')) return 'RESTRICTED';
  if (n.includes('CTR')) return 'CTR';
  if (n.includes('FIR')) return 'FIR';
  if (n.includes('CTA')) return 'CTA';
  return 'TMA';
}

function normalizeClass(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().toUpperCase();
  return /^[A-G]$/.test(s) ? s : null;
}

/** Normalize one open-flightmaps GeoJSON feature into an {@link Airspace}. */
export function normalizeOfmFeature(raw: unknown): Airspace | null {
  const parsed = featureSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.geometry) return null;
  const f = parsed.data;
  const p = f.properties ?? {};
  const name = p.name ?? 'UNKNOWN';
  const freq = p.frequency;
  return {
    id: f.id != null ? `ofm:${f.id}` : `ofm:${name}`,
    name,
    type: normalizeType(p.type, name),
    icaoClass: normalizeClass(p.icaoClass ?? p.class),
    lowerFt: parseOfmAltitude(p.lower),
    upperFt: parseOfmAltitude(p.upper),
    frequency: freq === null || freq === undefined ? null : String(freq),
    source: 'openflightmaps',
    provider: 'openflightmaps',
    sourceId: f.id != null ? String(f.id) : `ofm:${name}`,
    polygon: f.geometry as AirspaceGeometry,
  };
}

/** Parse a raw open-flightmaps GeoJSON dataset into normalized airspaces. */
export function parseOfmDataset(text: string | null, logger?: Logger): Airspace[] {
  const root = parseJson<{ features?: unknown[] }>(text, 'openflightmaps', logger);
  if (root === null) return [];
  const features = Array.isArray(root) ? root : Array.isArray(root.features) ? root.features : [];
  const out: Airspace[] = [];
  for (const feat of features) {
    const a = normalizeOfmFeature(feat);
    if (a) out.push(a);
  }
  return out;
}

export class OpenFlightmapsAirspaceProvider extends BaseAirspaceProvider {
  constructor(
    private readonly datasetPath: string | undefined,
    cellDeg?: number,
    private readonly logger?: Logger,
  ) {
    super(cellDeg);
  }

  protected async fetch(): Promise<Airspace[]> {
    const text = await readDatasetText(this.datasetPath, 'openflightmaps', this.logger);
    return parseOfmDataset(text, this.logger);
  }
}
