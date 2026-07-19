import {
  type Airspace,
  type AirspaceProvider,
  AirspaceService,
  BaseAirspaceProvider,
  type Bbox2D,
  geometryBbox,
  groupByType,
  selectAirspaceProvider,
} from '@flytrace/airspace';
import { createAirspaceReadRepo } from '@flytrace/db';
import { AppError } from '@flytrace/shared';
import { type Context, Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import type { AppContext } from '../context.ts';

class DbAirspaceProvider extends BaseAirspaceProvider {
  constructor(
    private readonly ctx: AppContext,
    private readonly sourceProvider = 'openaip',
  ) {
    super();
  }

  protected async fetch(): Promise<Airspace[]> {
    const airspaces = await createAirspaceReadRepo(this.ctx.db).listActive({
      provider: this.sourceProvider,
    });
    this.ctx.logger.info('airspace(db): loaded active geofences', {
      provider: this.sourceProvider,
      count: airspaces.length,
    });
    return airspaces;
  }
}

/**
 * Airspace lookup endpoint (docs/07). `GET /airspace/current?lat=&lon=[&alt=]`
 * returns every controlled-airspace volume containing the point, grouped by
 * kind plus a flat `matches` list. Backed by the same {@link AirspaceService}
 * the tracker uses; defaults to the in-repo mock dataset so it works locally
 * with no external services.
 *
 * The provider is selected from config/env (AIRSPACE_PROVIDER / *_DATASET_PATH),
 * defaulting to the mock fallback. `AIRSPACE_PROVIDER=db` reads imported
 * geofences from Postgres, which is the production path for admin-imported
 * OpenAIP data.
 */
function summarize(a: Airspace) {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    class: a.icaoClass,
    frequency: a.frequency ?? null,
    lowerFt: a.lowerFt,
    upperFt: a.upperFt,
  };
}

interface AirspaceFeatureCollection {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    id: string;
    geometry: Airspace['polygon'];
    properties: ReturnType<typeof summarize> & {
      provider: string | null;
      datasetVersion: string | null;
    };
  }[];
}

function toFeature(a: Airspace): AirspaceFeatureCollection['features'][number] {
  return {
    type: 'Feature',
    id: a.id,
    geometry: a.polygon,
    properties: {
      id: a.id,
      name: a.name,
      type: a.type,
      class: a.icaoClass,
      frequency: a.frequency ?? null,
      lowerFt: a.lowerFt,
      upperFt: a.upperFt,
      provider: a.provider ?? a.source ?? null,
      datasetVersion: a.datasetVersion ?? null,
    },
  };
}

function intersectsBbox(a: Bbox2D, b: Bbox2D): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function parseBbox(raw: string | undefined): Bbox2D {
  const values = raw?.split(',').map(Number) ?? [];
  if (values.length !== 4 || values.some((v) => !Number.isFinite(v))) {
    throw new AppError('BAD_REQUEST', 'bbox must be "west,south,east,north"');
  }
  const [west, south, east, north] = values as Bbox2D;
  if (west < -180 || west > 180 || east < -180 || east > 180) {
    throw new AppError('BAD_REQUEST', 'bbox longitudes must be in [-180, 180]');
  }
  if (south < -90 || south > 90 || north < -90 || north > 90) {
    throw new AppError('BAD_REQUEST', 'bbox latitudes must be in [-90, 90]');
  }
  if (west >= east || south >= north) {
    throw new AppError('BAD_REQUEST', 'bbox must be ordered west < east and south < north');
  }
  return [west, south, east, north];
}

const AIRSPACE_TYPES = ['FIR', 'TMA', 'CTA', 'CTR', 'RESTRICTED', 'DANGER', 'PROHIBITED'] as const;

function parseTypes(raw: string | undefined): Airspace['type'][] | undefined {
  if (!raw) return undefined;
  const types = raw
    .split(',')
    .map((type) => type.trim().toUpperCase())
    .filter(Boolean);
  const valid = new Set<string>(AIRSPACE_TYPES);
  if (types.some((type) => !valid.has(type))) {
    throw new AppError('BAD_REQUEST', `types must be one of ${AIRSPACE_TYPES.join(',')}`);
  }
  return [...new Set(types)] as Airspace['type'][];
}

type AirspaceRouteConfig =
  | {
      AIRSPACE_PROVIDER?: string;
      OPENAIP_DATASET_PATH?: string;
      OPENAIP_API_KEY?: string;
      OPENAIP_GLOBAL_IMPORT?: boolean;
      OPENAIP_BASE_URL?: string;
      OPENAIP_COUNTRY?: string;
      OPENAIP_BBOX?: string;
      OPENAIP_PAGE_LIMIT?: number;
      AIRSPACE_DB_SOURCE_PROVIDER?: string;
      OPENFLIGHTMAPS_DATASET_PATH?: string;
      AIXM_DATASET_PATH?: string;
    }
  | undefined;

async function createConfiguredProvider(
  ctx: AppContext,
  config: AirspaceRouteConfig,
): Promise<AirspaceProvider> {
  const kind = config?.AIRSPACE_PROVIDER ?? process.env.AIRSPACE_PROVIDER;
  if (kind === 'db') {
    return new DbAirspaceProvider(
      ctx,
      config?.AIRSPACE_DB_SOURCE_PROVIDER ?? process.env.AIRSPACE_DB_SOURCE_PROVIDER ?? 'openaip',
    );
  }

  return await selectAirspaceProvider({
    ...(kind ? { kind } : {}),
    ...((config?.OPENAIP_DATASET_PATH ?? process.env.OPENAIP_DATASET_PATH)
      ? {
          openaipDatasetPath: config?.OPENAIP_DATASET_PATH ?? process.env.OPENAIP_DATASET_PATH,
        }
      : {}),
    ...((config?.OPENAIP_API_KEY ?? process.env.OPENAIP_API_KEY)
      ? { openaipApiKey: config?.OPENAIP_API_KEY ?? process.env.OPENAIP_API_KEY }
      : {}),
    ...((config?.OPENAIP_GLOBAL_IMPORT ?? process.env.OPENAIP_GLOBAL_IMPORT)
      ? {
          openaipGlobalImport:
            config?.OPENAIP_GLOBAL_IMPORT === true ||
            process.env.OPENAIP_GLOBAL_IMPORT === 'true' ||
            process.env.OPENAIP_GLOBAL_IMPORT === '1',
        }
      : {}),
    ...((config?.OPENAIP_BASE_URL ?? process.env.OPENAIP_BASE_URL)
      ? { openaipBaseUrl: config?.OPENAIP_BASE_URL ?? process.env.OPENAIP_BASE_URL }
      : {}),
    ...((config?.OPENAIP_COUNTRY ?? process.env.OPENAIP_COUNTRY)
      ? { openaipCountry: config?.OPENAIP_COUNTRY ?? process.env.OPENAIP_COUNTRY }
      : {}),
    ...((config?.OPENAIP_BBOX ?? process.env.OPENAIP_BBOX)
      ? { openaipBbox: config?.OPENAIP_BBOX ?? process.env.OPENAIP_BBOX }
      : {}),
    ...((config?.OPENAIP_PAGE_LIMIT ?? process.env.OPENAIP_PAGE_LIMIT)
      ? {
          openaipPageLimit: Number(config?.OPENAIP_PAGE_LIMIT ?? process.env.OPENAIP_PAGE_LIMIT),
        }
      : {}),
    ...((config?.OPENFLIGHTMAPS_DATASET_PATH ?? process.env.OPENFLIGHTMAPS_DATASET_PATH)
      ? {
          openflightmapsDatasetPath:
            config?.OPENFLIGHTMAPS_DATASET_PATH ?? process.env.OPENFLIGHTMAPS_DATASET_PATH,
        }
      : {}),
    ...((config?.AIXM_DATASET_PATH ?? process.env.AIXM_DATASET_PATH)
      ? { aixmDatasetPath: config?.AIXM_DATASET_PATH ?? process.env.AIXM_DATASET_PATH }
      : {}),
    logger: ctx.logger,
  });
}

export function createAirspaceRoutes(ctx: AppContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const config = ctx.config as AirspaceRouteConfig;

  // Lazily built once, shared across requests. The mock dataset load is cheap
  // and memoized behind the service's TTL cache.
  let servicePromise: Promise<AirspaceService> | null = null;
  const getService = (): Promise<AirspaceService> => {
    if (!servicePromise) {
      servicePromise = (async () => {
        const provider = await createConfiguredProvider(ctx, config);
        const service = new AirspaceService(provider);
        await service.load();
        return service;
      })();
    }
    return servicePromise;
  };

  const ok = (c: Context<AppEnv>, data: unknown) =>
    c.json({ data, meta: { requestId: c.get('requestId') } });

  app.get('/airspace/current', async (c) => {
    const lat = Number(c.req.query('lat'));
    const lon = Number(c.req.query('lon'));
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new AppError('BAD_REQUEST', 'lat must be a number in [-90, 90]');
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new AppError('BAD_REQUEST', 'lon must be a number in [-180, 180]');
    }
    const altRaw = c.req.query('alt');
    const altFt = altRaw !== undefined && altRaw !== '' ? Number(altRaw) : null;
    if (altFt !== null && !Number.isFinite(altFt)) {
      throw new AppError('BAD_REQUEST', 'alt must be a number (feet)');
    }

    const provider = config?.AIRSPACE_PROVIDER ?? process.env.AIRSPACE_PROVIDER;
    const matches =
      provider === 'db'
        ? await createAirspaceReadRepo(ctx.db).findContainingPoint({
            lat,
            lon,
            altFt,
            provider:
              config?.AIRSPACE_DB_SOURCE_PROVIDER ?? process.env.AIRSPACE_DB_SOURCE_PROVIDER,
          })
        : (await getService()).currentAirspace(lat, lon, altFt);
    const grouped = groupByType(matches);

    // Primary controlling class/frequency: prefer the smallest/most operationally
    // specific volume — CTR/special-use over broad TMA/CTA/FIR.
    const priority: Record<Airspace['type'], number> = {
      CTR: 0,
      PROHIBITED: 1,
      RESTRICTED: 2,
      DANGER: 3,
      TMA: 4,
      CTA: 5,
      FIR: 6,
    };
    const primary = [...matches].sort((a, b) => priority[a.type] - priority[b.type])[0];

    return ok(c, {
      query: { lat, lon, altFt },
      fir: grouped.fir.map(summarize),
      tma: grouped.tma.map(summarize),
      cta: grouped.cta.map(summarize),
      ctr: grouped.ctr.map(summarize),
      restricted: grouped.restricted.map(summarize),
      danger: grouped.danger.map(summarize),
      prohibited: grouped.prohibited.map(summarize),
      class: primary?.icaoClass ?? null,
      frequency: primary?.frequency ?? null,
      name: primary?.name ?? null,
      matches: matches.map(summarize),
    });
  });

  app.get('/airspace/viewport', async (c) => {
    const bbox = parseBbox(c.req.query('bbox'));
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 500) || 500, 1), 1500);
    const types = parseTypes(c.req.query('types'));
    const provider = config?.AIRSPACE_PROVIDER ?? process.env.AIRSPACE_PROVIDER;

    let airspaces: Airspace[];
    if (provider === 'db' && ctx.db) {
      airspaces = await createAirspaceReadRepo(ctx.db).listActiveInBbox({
        bbox,
        provider: config?.AIRSPACE_DB_SOURCE_PROVIDER ?? process.env.AIRSPACE_DB_SOURCE_PROVIDER,
        types,
        limit,
      });
    } else {
      const service = await getService();
      const wanted = types ? new Set(types) : null;
      airspaces = service
        .allAirspaces()
        .filter((airspace) => !wanted || wanted.has(airspace.type))
        .filter((airspace) => intersectsBbox(geometryBbox(airspace.polygon), bbox))
        .slice(0, limit);
    }

    return ok(c, {
      type: 'FeatureCollection',
      features: airspaces.map(toFeature),
      count: airspaces.length,
      truncated: airspaces.length >= limit,
      query: { bbox, limit, types: types ?? null },
    });
  });

  return app;
}
