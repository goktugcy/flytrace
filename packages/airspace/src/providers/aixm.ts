/**
 * AIXM airspace provider (AIXM 5.1 / GML). Parses an AIXM airspace dataset when
 * `AIXM_DATASET_PATH` points at a file or URL. Un-configured ⇒ no-op.
 *
 * AIXM is a large XML/GML schema; a full parser needs a heavy XML dependency we
 * deliberately avoid here. This is a pragmatic, dependency-free extractor that
 * pulls the fields the tracker needs — name, type, class, vertical limits, and
 * the airspace's outer ring from the first `<gml:posList>` — from each
 * `<aixm:Airspace>` element. It handles the common single-polygon case; complex
 * multi-surface geometries are approximated by their first ring. Records with no
 * usable geometry are skipped, never fabricated.
 *
 * GML axis order for EPSG:4326 is latitude,longitude; posList values are read as
 * `lat lon lat lon …` and emitted as GeoJSON `[lon, lat]`.
 */
import type { Logger } from '@flytrace/shared';
import type { Airspace, AirspaceType, LinearRing, Position2D } from '../types.ts';
import { readDatasetText } from './_source.ts';
import { BaseAirspaceProvider } from './index.ts';

/** Grab the first captured group of a regex against `xml`, trimmed, or null. */
function first(xml: string, re: RegExp): string | null {
  const m = xml.match(re);
  return m?.[1] ? m[1].trim() : null;
}

function normalizeType(typeStr: string | null, name: string): AirspaceType {
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

function normalizeClass(raw: string | null): string | null {
  const s = (raw ?? '').trim().toUpperCase();
  return /^[A-G]$/.test(s) ? s : null;
}

/** Parse an AIXM vertical limit value + uom into feet. FL → ×100. */
export function aixmLimitToFt(value: string | null, uom: string | null): number | null {
  if (value === null) return null;
  const s = value.trim().toUpperCase();
  if (s === 'GND' || s === 'SFC') return 0;
  if (s === 'UNL' || s === 'UNLTD') return null;
  const num = Number(s.replace(/[^\d.-]/g, ''));
  if (Number.isNaN(num)) return null;
  const u = (uom ?? '').toUpperCase();
  return u === 'FL' ? num * 100 : num;
}

/** Parse a GML posList "lat lon lat lon …" into a closed GeoJSON ring. */
export function parsePosList(posList: string): LinearRing {
  const nums = posList
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
  const ring: LinearRing = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const lat = nums[i] as number;
    const lon = nums[i + 1] as number;
    ring.push([lon, lat] as Position2D);
  }
  // Close the ring if the parser didn't (GeoJSON requires first === last).
  const n = ring.length;
  if (n >= 3) {
    const f = ring[0] as Position2D;
    const l = ring[n - 1] as Position2D;
    if (f[0] !== l[0] || f[1] !== l[1]) ring.push([f[0], f[1]]);
  }
  return ring;
}

const NAME_RE = /<(?:\w+:)?name>([^<]+)<\/(?:\w+:)?name>/i;
const TYPE_RE = /<(?:\w+:)?type>([^<]+)<\/(?:\w+:)?type>/i;
const CLASS_RE = /<(?:\w+:)?class>([^<]+)<\/(?:\w+:)?class>/i;
const POSLIST_RE = /<(?:\w+:)?posList[^>]*>([^<]+)<\/(?:\w+:)?posList>/i;
const UPPER_RE = /<(?:\w+:)?upperLimit(?:\s+uom="([^"]*)")?[^>]*>([^<]+)<\/(?:\w+:)?upperLimit>/i;
const LOWER_RE = /<(?:\w+:)?lowerLimit(?:\s+uom="([^"]*)")?[^>]*>([^<]+)<\/(?:\w+:)?lowerLimit>/i;
const FREQ_RE = /<(?:\w+:)?frequencyTransmission>([^<]+)<\/(?:\w+:)?frequencyTransmission>/i;
const ID_RE = /gml:id="([^"]+)"/i;

/** Normalize a single `<aixm:Airspace>…</aixm:Airspace>` XML block. */
export function normalizeAixmBlock(block: string, seq: number): Airspace | null {
  const posMatch = block.match(POSLIST_RE);
  if (!posMatch?.[1]) return null;
  const ring = parsePosList(posMatch[1]);
  if (ring.length < 3) return null;

  const name = first(block, NAME_RE) ?? 'UNKNOWN';
  const upper = block.match(UPPER_RE);
  const lower = block.match(LOWER_RE);
  return {
    id: first(block, ID_RE) ?? `aixm:${seq}`,
    name,
    type: normalizeType(first(block, TYPE_RE), name),
    icaoClass: normalizeClass(first(block, CLASS_RE)),
    lowerFt: aixmLimitToFt(lower?.[2] ?? null, lower?.[1] ?? null),
    upperFt: aixmLimitToFt(upper?.[2] ?? null, upper?.[1] ?? null),
    frequency: first(block, FREQ_RE),
    source: 'aixm',
    provider: 'aixm',
    sourceId: first(block, ID_RE) ?? `aixm:${seq}`,
    polygon: { type: 'Polygon', coordinates: [ring] },
  };
}

/** Parse an AIXM XML document into normalized airspaces. */
export function parseAixmDataset(text: string | null): Airspace[] {
  if (!text) return [];
  const out: Airspace[] = [];
  const blockRe = /<(?:\w+:)?Airspace\b[\s\S]*?<\/(?:\w+:)?Airspace>/gi;
  let m: RegExpExecArray | null;
  let seq = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((m = blockRe.exec(text)) !== null) {
    const a = normalizeAixmBlock(m[0], seq);
    seq += 1;
    if (a) out.push(a);
  }
  return out;
}

export class AixmAirspaceProvider extends BaseAirspaceProvider {
  constructor(
    private readonly datasetPath: string | undefined,
    cellDeg?: number,
    private readonly logger?: Logger,
  ) {
    super(cellDeg);
  }

  protected async fetch(): Promise<Airspace[]> {
    const text = await readDatasetText(this.datasetPath, 'aixm', this.logger);
    return parseAixmDataset(text);
  }
}
